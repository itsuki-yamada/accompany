#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { websocket } from "hono/bun";
import { createApp } from "./app";
import index from "./public/index.html";
import { SessionStore, stateDir } from "./session-store";
import { Uploads } from "./uploads";
import { Workspace } from "./workspace";

// accompany [--port <port>] [--fresh] [-- <command...>]
// --fresh: 前回の画面の配置とスクロールバックを戻さずに、新しく始める
const { values, positionals } = parseArgs({
  options: { port: { type: "string", default: "3000" }, fresh: { type: "boolean", default: false } },
  allowPositionals: true,
});

const shell = [process.env.SHELL ?? "/bin/sh"];
// 画面の配置とスクロールバックは、起動したディレクトリごとに保存し、次に起動したときに戻す（docs/adr/34-session-restore.md）
const cwd = process.cwd();
const store = new SessionStore(stateDir(), cwd);
const saved = values.fresh ? undefined : store.load();
const workspace = new Workspace(positionals.length > 0 ? positionals : undefined, shell, saved);
const uploads = new Uploads();
const app = createApp(workspace, uploads);

// 認証がないため、同じネットワークの他のマシンからは操作できないよう loopback だけで待ち受ける
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(values.port),
  development: false,
  // 本番モードの既定では同じポートで二重に待ち受けてしまい、接続がどちらのコマンドにつながるか分からなくなる
  reusePort: false,
  routes: { "/": index },
  fetch: app.fetch,
  websocket,
});

// 保存できないことが続いても（書き込めない保存先など）、警告は保存できるようになるまで 1 回だけ出す
let saveFailed = false;
async function save() {
  try {
    store.save(await workspace.snapshot(cwd));
    saveFailed = false;
  } catch (error) {
    if (!saveFailed) console.warn(`Accompany: 画面を保存できませんでした: ${error}`);
    saveFailed = true;
  }
}

// 変化のたびに書くと出力の多いコマンドで書き込みが続くので、変化があってから少し間を置いて、まとめて書く。
// 止める操作を経ずに落ちたときは、この間に起きた変化だけが失われる
const saveDelayMs = 1000;
let saveTimer: Timer | undefined;
let stopping = false;
workspace.onChange = () => {
  if (saveTimer || stopping) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void save();
  }, saveDelayMs);
};

// PTY のコマンドは別セッションで動くため、Accompany を止めるときに明示的に止める。
// コマンドが終わるとそのターミナルが閉じて配置が変わるので、止める前の画面を先に保存する。
// ドロップされたファイルも、Accompany を止めたら要らなくなるので消す。
// bunx で起動すると、同じシグナルが bunx からも転送されて二度届くので、二度目以降は無視する。
// 代わりに、保存が長引いても止まれるよう、保存を待つのは stopSaveTimeoutMs までにする
const stopSaveTimeoutMs = 3000;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(saveTimer);
    await Promise.race([save(), Bun.sleep(stopSaveTimeoutMs)]);
    workspace.killAll();
    uploads.remove();
    process.exit(0);
  });
}

// localhost は環境によって ::1 に解決されるため、待ち受けているアドレスをそのまま表示する
console.log(`Accompany: http://${server.hostname}:${server.port}`);
if (saved) console.log(`前回の画面を戻しました（新しく始めるときは --fresh を付けて起動する）: ${store.file}`);
