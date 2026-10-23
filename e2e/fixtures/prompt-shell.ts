// E2E で、シェルの統合（OSC 133）の印を出すシェルの代わりに起動する。
// プロンプトの前に A（プロンプトの始まり）、後に B（コマンドの始まり）、コマンドを実行する前に C（出力の始まり）、
// 実行し終えたら D（出力の終わり）を出す。
// 「echo 文字列」は文字列を 1 行出し、「lines 数 文字列」は「文字列 1」「文字列 2」…をその数だけ出す。
// 「tui」は代替画面（全画面の TUI が使う）に切り替えて「Prompt TUI」と描き、次に Enter を押すと通常の画面に戻って終わる
const write = (s: string) => process.stdout.write(s);
const prompt = () => write("\x1b]133;A\x07$ \x1b]133;B\x07");

console.log("Prompt shell ready");
prompt();
const lines = console[Symbol.asyncIterator]();
for (let next = await lines.next(); !next.done; next = await lines.next()) {
  const line = next.value;
  write("\x1b]133;C\x07");
  const [command, ...args] = line.trim().split(/\s+/);
  if (command === "echo") {
    console.log(args.join(" "));
  } else if (command === "lines") {
    const count = Number(args[0]);
    const word = args.slice(1).join(" ");
    for (let i = 1; i <= count; i++) console.log(`${word} ${i}`);
  } else if (command === "tui") {
    write("\x1b[?1049h\x1b[2J\x1b[3;5HPrompt TUI");
    await lines.next();
    write("\x1b[?1049l");
  }
  write("\x1b]133;D;0\x07");
  prompt();
}
