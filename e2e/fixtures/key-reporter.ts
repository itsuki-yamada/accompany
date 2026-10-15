// E2E で、受け取ったキー入力をバイト列（16 進）で表示するプログラムの代わりに起動する
// 準備完了を表示する前に raw モードにする。先に表示すると、raw モードになる前に届いた Ctrl+W や Ctrl+H を
// 端末（行の編集）が単語や文字の削除として処理してしまい、テストが不安定になる
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  console.log(`keys: ${[...data].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
});
console.log("Key reporter ready");
