// E2E で、しばらく出力を出し続けてから入力待ちに戻るエージェントの代わりに起動する
// - 起動直後に 1.5 秒ほど出力し続ける（Claude Code も起動時に画面を描き続ける）
// - 「work」と入力すると、3 秒間出力し続けてから入力待ちに戻る
const print = (text: string) => process.stdout.write(text);

async function busy(label: string, ms: number) {
  const end = Date.now() + ms;
  for (let i = 1; Date.now() < end; i++) {
    print(`${label} ${i}\r\n`);
    await Bun.sleep(100);
  }
}

await busy("starting", 1500);
print("Busy Agent ready\r\n> ");
for await (const line of console) {
  if (line.trim() === "work") {
    await busy("working", 3000);
    print("done\r\n");
  }
  print("> ");
}
