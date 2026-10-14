import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

// 起動コマンドは ACCOMPANY_CMD で差し替えられる（例: tarball から bunx で起動する）
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultCommand = "bun app/server/src/cli.ts";

export type Accompany = { url: string; stop: () => void };

export function startAccompany(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<Accompany> {
  const command = [process.env.ACCOMPANY_CMD ?? defaultCommand, ...args].join(" ");
  const child: ChildProcess = spawn(command, {
    cwd: repoRoot,
    shell: true,
    detached: true,
    env: { ...process.env, ...env },
  });
  const stop = () => {
    if (child.pid) process.kill(-child.pid);
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
