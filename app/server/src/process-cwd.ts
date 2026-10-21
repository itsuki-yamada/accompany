import { readlink, stat } from "node:fs/promises";
import { commandOutput } from "./command-output";

// lsof がこの時間で終わらなければ止めて、調べられなかったものとする
const lsofTimeoutMs = 2000;

// pid のプロセスのカレントディレクトリ。Linux は /proc/<pid>/cwd、macOS などは lsof で調べる（docs/adr/109-inherit-cwd.md）。
// 調べられなかったとき、ディレクトリとして存在しないとき（削除された。Linux の readlink は「 (deleted)」を付けて返す）は undefined
export async function processCwd(pid: number) {
  try {
    const dir = process.platform === "linux" ? await readlink(`/proc/${pid}/cwd`) : await lsofCwd(pid);
    return dir && (await stat(dir)).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

// -Fn: 「n<パス>」の行で出す
async function lsofCwd(pid: number) {
  const output = await commandOutput(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], lsofTimeoutMs);
  return output
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
}
