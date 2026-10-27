#!/usr/bin/env bun
// 最初に読み込み、古い Bun では、ほかのモジュールを動かす前に終了する
import "./require-bun";
import { websocket } from "hono/bun";
import { createApp } from "./app";
import { maxPort, parseCliArgs } from "./cli-args";
import index from "./public/index.html";
import { maxMinWindow, parseMinWindowOption } from "./min-window";
import { SessionStore, stateDir } from "./session-store";
import { compressedRoutes } from "./static-assets";
import { Uploads } from "./uploads";
import { Workspace } from "./workspace";

// accompany [--port <port>] [--fresh] [--min-window <幅>x<高さ>] [-v | --version] [-h | --help] [-- <command...>]
// accompany activate [シェル]: シェルの統合のスクリプトを表示する（docs/adr/112-copy-last-output.md）
// --fresh: 前回の画面の配置とスクロールバックを戻さずに、新しく始める
// --min-window: 端末の大きさの下限を、ウィンドウの大きさ（ピクセル）で指定する。保存した下限より優先し、保存はしない
// （docs/adr/99-smallest-size.md）
const { values, positionals } = parseCliArgs();
const minWindowOption = values["min-window"];
const minWindow = minWindowOption === undefined ? undefined : parseMinWindowOption(minWindowOption);
if (minWindowOption !== undefined && !minWindow) {
  console.error(
    `Accompany: --min-window は「幅x高さ」（例: 480x1080。幅 0〜${maxMinWindow.width}、高さ 0〜${maxMinWindow.height} の整数）で指定してください: ${minWindowOption}`,
  );
  process.exit(1);
}

const shell = [process.env.SHELL ?? "/bin/sh"];
// 画面の配置とスクロールバックは、起動したディレクトリごとに保存し、次に起動したときに戻す（docs/adr/34-session-restore.md）
const cwd = process.cwd();
const store = new SessionStore(stateDir(), cwd);
const saved = values.fresh ? undefined : store.load();
const workspace = new Workspace(positionals.length > 0 ? positionals : undefined, shell, saved, minWindow);
const uploads = new Uploads();
const app = createApp(workspace, uploads);

// 指定したポート（既定 3000）が使われていたら、空いているポートまで 1 つずつ上げて待ち受ける。
// 上げるのは portAttempts 個まで（docs/adr/152-free-port.md）
const portAttempts = 10;
const requestedPort = Number(values.port);
const routes = await compressedRoutes(index);
let server: ReturnType<typeof Bun.serve> | undefined;
for (let port = requestedPort; port < requestedPort + portAttempts && port <= maxPort; port++) {
  try {
    // 認証がないため、同じネットワークの他のマシンからは操作できないよう loopback だけで待ち受ける
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: false,
      // 本番モードの既定では同じポートで二重に待ち受けてしまい、接続がどちらのコマンドにつながるか分からなくなる
      reusePort: false,
      routes,
      fetch: app.fetch,
      // 途中から開いた人に送る画面（スクロールバックを含む）は大きいので、圧縮して送れるようにする。
      // 何を圧縮するかは送るときに決める（docs/adr/111-loading.md）
      websocket: { ...websocket, perMessageDeflate: true },
    });
    break;
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EADDRINUSE") throw error;
  }
}
if (!server) {
  const last = Math.min(requestedPort + portAttempts - 1, maxPort);
  console.error(
    `Accompany: ポート ${requestedPort}〜${last} はすべて使われています。--port で別のポートを指定してください`,
  );
  // 最初のターミナルのコマンドは、待ち受ける前に起動しているので、残さずに止める
  workspace.killAll();
  uploads.remove();
  process.exit(1);
}
if (server.port !== requestedPort && requestedPort !== 0) {
  console.log(`Accompany: ポート ${requestedPort} は使われているので、${server.port} で待ち受けます`);
}

// 保存できないことが続いても（書き込めない保存先など）、警告は保存できるようになるまで 1 回だけ出す
let saveFailed = false;
async function save({ stopping = false } = {}) {
  try {
    store.save(await workspace.snapshot(cwd, { refreshCwd: stopping }));
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
    await Promise.race([save({ stopping: true }), Bun.sleep(stopSaveTimeoutMs)]);
    workspace.killAll();
    uploads.remove();
    process.exit(0);
  });
}

// localhost は環境によって ::1 に解決されるため、待ち受けているアドレスをそのまま表示する
console.log(`Accompany: http://${server.hostname}:${server.port}`);
if (saved) console.log(`前回の画面を戻しました（新しく始めるときは --fresh を付けて起動する）: ${store.file}`);
