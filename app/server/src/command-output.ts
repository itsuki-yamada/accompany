// コマンドをシェルを通さずに動かし、標準出力を返す。timeoutMs で終わらなければ止めて、例外にする
// （止まったままのコマンドを待ち続けないため）
export async function commandOutput(command: string[], timeoutMs: number) {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${command[0]} timed out`));
    }, timeoutMs);
  });
  try {
    const read = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out]) => out);
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
