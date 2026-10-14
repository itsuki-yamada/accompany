import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

// 起動コマンドは ACCOMPANY_CMD で差し替えられる（例: tarball から bunx で起動する）
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultCommand = "bun app/server/src/cli.ts";

// 複数の作業ディレクトリで同時に E2E を流してもポートがぶつからないよう、E2E_PORT_BASE で使うポートをずらせる
const portBase = Number(process.env.E2E_PORT_BASE) || 3000;

// テストで使うポート。offset 0 は、--port を指定しないテストが使う
export function testPort(offset = 0) {
  return String(portBase + offset);
}

export type Accompany = { url: string; stop: () => Promise<void> };

export function startAccompany(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<Accompany> {
  const portArgs = args.includes("--port") ? [] : ["--port", testPort()];
  const command = [process.env.ACCOMPANY_CMD ?? defaultCommand, ...portArgs, ...args].join(" ");
  const child: ChildProcess = spawn(command, {
    cwd: repoRoot,
    shell: true,
    detached: true,
    env: { ...process.env, ...env },
  });
  // 次のテストが同じポートで起動できるよう、プロセスグループ全体が終わるまで待つ
  const stop = async () => {
    const pgid = child.pid;
    if (!pgid) return;
    process.kill(-pgid);
    while (isAlive(pgid)) await new Promise((r) => setTimeout(r, 20));
  };

  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const url = output.match(/https?:\/\/\S+/)?.[0];
      if (url) resolve({ url, stop });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) =>
      reject(new Error(`Accompany が URL を表示する前に終了した (code: ${code})\n${output}`)),
    );
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
