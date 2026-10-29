import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";

// 起動コマンドは ACCOMPANY_CMD で差し替えられる（例: tarball から bunx で起動する）
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultCommand = "bun app/server/src/cli.ts";

// 複数の作業ディレクトリで同時に E2E を流してもポートがぶつからないよう、E2E_PORT_BASE で使うポートをずらせる
const basePort = Number(process.env.E2E_PORT_BASE) || 3000;

// 並行に流すワーカーどうしでポートがぶつからないよう、ワーカーごとに portsPerWorker ずつずらす。
// TEST_PARALLEL_INDEX は 0 から（ワーカー数 - 1）までで、落ちて起動し直したワーカーも同じ番号を引き継ぐ。
// テストが使う offset は今は 50 まで。幅はそれより十分広くとる（docs/adr/205-parallel-e2e.md）
export const portsPerWorker = 100;
const portBase = basePort + Number(process.env.TEST_PARALLEL_INDEX ?? 0) * portsPerWorker;

// テストで使うポート。offset 0 は、--port を指定しないテストが使う
export function testPort(offset = 0) {
  if (offset >= portsPerWorker) throw new Error(`testPort の offset は ${portsPerWorker} 未満にする（ほかのワーカーのポートとぶつかる）: ${offset}`);
  return String(portBase + offset);
}

// stop は、既定ではプロセスグループ全体（端末で Ctrl+C を押したとき）に signal を送り、全体が終わるまで待つ。
// onlyCommand を付けると、起動したコマンドのプロセス（npm の起動役など）だけに送る
export type Accompany = {
  url: string;
  // 起動したコマンドのプロセス（npm の起動役など）の pid。プロセスグループの ID でもある
  pid: number;
  stop: (signal?: NodeJS.Signals, options?: { onlyCommand?: boolean }) => Promise<void>;
};

// 起動コマンド（ACCOMPANY_CMD または既定のもの）
export function accompanyCommand() {
  return process.env.ACCOMPANY_CMD ?? defaultCommand;
}

// 画面の配置とスクロールバックを保存するディレクトリ（ACCOMPANY_STATE_DIR）を、使い捨てで作る
export function newStateDir() {
  return join(mkdtempSync(join(tmpdir(), "accompany-e2e-")), "state");
}

// 保存先は、既定ではテストごとに使い捨てのディレクトリにする。前のテストや開発者自身の状態を復元しないため。
// 再起動をまたいで同じ保存先を使うテストは、env で ACCOMPANY_STATE_DIR を渡す。
// 端末の大きさの下限（ウィンドウの大きさ）は、既定では 0x0（下限なし）にして起動する。既定の下限（480×1080）は
// テストの画面（1280×720）より縦に大きく、下限を確かめるテストのほかは、参加者の画面に合わせた大きさで確かめたいため。
// 下限を指定するテストは minWindow で渡し、既定の下限や保存した下限で起動するテストは null を渡す（docs/adr/99-smallest-size.md）
export function startAccompany(
  args: string[] = [],
  env: Record<string, string> = {},
  { minWindow = "0x0" }: { minWindow?: string | null } = {},
): Promise<Accompany> {
  const portArgs = args.includes("--port") ? [] : ["--port", testPort()];
  const minWindowArgs = minWindow === null || args.includes("--min-window") ? [] : ["--min-window", minWindow];
  // exec: シェルを起動したコマンドに置き換え、child.pid を起動したコマンドのプロセスにする（シェルによっては自分では置き換えない）
  const command = ["exec", accompanyCommand(), ...portArgs, ...minWindowArgs, ...args].join(" ");
  const ownStateDir = env.ACCOMPANY_STATE_DIR ? undefined : newStateDir();
  const child: ChildProcess = spawn(command, {
    cwd: repoRoot,
    shell: true,
    detached: true,
    env: { ...process.env, ...(ownStateDir && { ACCOMPANY_STATE_DIR: ownStateDir }), ...env },
  });
  // 次のテストが同じポートで起動できるよう、プロセスグループ全体が終わり、ポートが空くまで待つ。
  // 終了している途中のプロセスは、グループの確かめ（isAlive）では見つからないが、まだポートで待ち受けていることがある（docs/adr/145-wait-port-free.md）
  let listening: URL | undefined;
  const stop = async (signal: NodeJS.Signals = "SIGTERM", { onlyCommand = false } = {}) => {
    const pgid = child.pid;
    if (!pgid) return;
    if (isAlive(pgid)) process.kill(onlyCommand ? pgid : -pgid, signal);
    while (isAlive(pgid)) await sleep(20);
    if (listening) await waitUntilFree(listening.hostname, Number(listening.port));
    if (ownStateDir) rmSync(join(ownStateDir, ".."), { recursive: true, force: true });
  };

  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const url = output.match(/https?:\/\/\S+/)?.[0];
      if (!url) return;
      listening = new URL(url);
      resolve({ url, pid: child.pid!, stop });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) =>
      reject(new Error(`Accompany が URL を表示する前に終了した (code: ${code})\n${output}`)),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 同じアドレスとポートで待ち受けられるようになるまで待つ。空かないままなら、次のテストの起動ではなくここで落とす
async function waitUntilFree(hostname: string, port: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await canListen(hostname, port))) {
    if (Date.now() > deadline) throw new Error(`Accompany を止めたあと ${timeoutMs} ms たっても、${hostname}:${port} が空かない`);
    await sleep(20);
  }
}

function canListen(hostname: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, hostname, () => server.close(() => resolve(true)));
  });
}

function isAlive(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// 参加者ごとのブラウザのコンテキストを作る。作ったものは closeContexts でテストのあとに閉じる。
// 閉じないと、ページが次のテスト以降も残り続け、Playwright がテストのたびに残ったページ全部のスクリーンショットを撮るので、
// 後のテストほど遅くなり、待ち時間の短い確認が落ちやすくなる（#83）
const contexts = new Set<BrowserContext>();

export async function newContext(browser: Browser, options?: BrowserContextOptions) {
  const context = await browser.newContext(options);
  contexts.add(context);
  return context;
}

// 閉じるときに例外が出ても、afterEach の続き（Accompany を止めるなど）を止めないよう、結果を待つだけにする
export async function closeContexts() {
  const closing = [...contexts];
  contexts.clear();
  await Promise.allSettled(closing.map((context) => context.close()));
}
