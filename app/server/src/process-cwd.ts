import fs from "node:fs/promises";

// lsof がこの時間で終わらなければ止めて、調べられなかったものとする
const lsofTimeoutMs = 2000;

// pid のプロセスのカレントディレクトリを調べる
// Linux は /proc/<pid>/cwd、macOS などは lsof を使う
export async function processCwd(pid: number): Promise<string | undefined> {
  if (pid <= 0) return undefined;

  if (process.platform === "linux") {
    try {
      const real = await fs.realpath(`/proc/${pid}/cwd`);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) return real;
    } catch {
      // /proc から読めなかったときは lsof も試す
    }
  }

  try {
    const proc = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        proc.kill();
        reject(new Error("lsof timed out"));
      }, lsofTimeoutMs);
    });
    try {
      const text = await Promise.race([new Response(proc.stdout).text(), timeout]);
      for (const line of text.split("\n")) {
        if (line.startsWith("n")) {
          const cwd = line.slice(1).trim();
          if (cwd) {
            const stat = await fs.stat(cwd);
            if (stat.isDirectory()) return cwd;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 調べられなかったときは undefined
  }

  return undefined;
}
