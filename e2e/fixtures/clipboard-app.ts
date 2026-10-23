// E2E で、OSC 52 でクリップボードへの書き込み・読み出しを頼むアプリ（tmux や Neovim、Claude Code などの代わり）
// - 「copy テキスト」: テキストをクリップボードに入れるよう頼む（\n は改行に置き換える）
// - 「big 文字数」: その文字数の x をクリップボードに入れるよう頼む
// - 「read」: クリップボードの中身を返すよう頼む（読み出しの要求）
// - 「check」: 読み出しの要求への応答が届いた数を出す。応答は改行で終わらないので、次に入力した行の頭に付いて届く
console.log("Clipboard app ready");
let replies = 0;
for await (const line of console) {
  if (line.includes("\x1b]52")) replies++;
  const command = line.replace(/^.*(\x07|\x1b\\)/, "");
  if (command.startsWith("copy ")) {
    const text = command.slice("copy ".length).replaceAll("\\n", "\n");
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    console.log("copy requested");
  } else if (command.startsWith("big ")) {
    const text = "x".repeat(Number(command.slice("big ".length)));
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    console.log("big copy requested");
  } else if (command === "read") {
    process.stdout.write("\x1b]52;c;?\x07");
    console.log("read requested");
  } else if (command === "check") {
    console.log(`replies: ${replies}`);
  }
}
