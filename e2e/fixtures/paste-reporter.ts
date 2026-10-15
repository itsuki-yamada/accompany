// E2E で、ブラケットペーストを有効にしたまま、受け取った入力を JSON の文字列で表示するプログラムの代わりに起動する
// （Claude Code やシェルのように、貼り付けをブラケットペーストで受け取るコマンドの代わり）
// 準備完了は、raw モードにしてモードを有効にしてから表示する（key-reporter.ts と同じく、テストを安定させるため）
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  console.log(`received: ${JSON.stringify(data.toString())}`);
});
process.stdout.write("\x1b[?2004h");
console.log("Paste reporter ready");
