// E2E で、しばらく出力を出し続けてから入力待ちに戻るエージェントの代わりに起動する
// - 起動直後に、端末に背景色（OSC 11）と種類（DA）を問い合わせてから、1.8 秒ほど出力し続ける
//   （Claude Code も起動時に問い合わせてから画面を描き続ける。ブラウザの端末は問い合わせに自動で応答する）
// - 「work」と入力すると、3 秒間出力し続けてから入力待ちに戻る（「longwork」なら 6 秒間）
// - 「later」と入力すると、3 秒何も出さずに待ってから、3 秒間出力し続ける
const print = (text: string) => process.stdout.write(text);

async function busy(label: string, ms: number) {
  const end = Date.now() + ms;
  for (let i = 1; Date.now() < end; i++) {
    print(`${label} ${i}\r\n`);
    await Bun.sleep(100);
  }
}

print("\x1b]11;?\x07\x1b[c");
await busy("starting", 1800);
print("Busy Agent ready\r\n> ");
// 問い合わせへの応答は改行を含まないので、次に入力した行の頭に付いてくる
for await (const line of console) {
  if (line.endsWith("longwork")) {
    await busy("working", 6000);
    print("done\r\n");
  } else if (line.endsWith("work")) {
    await busy("working", 3000);
    print("done\r\n");
  } else if (line.endsWith("later")) {
    await Bun.sleep(3000);
    await busy("working", 3000);
    print("done\r\n");
  }
  print("> ");
}
