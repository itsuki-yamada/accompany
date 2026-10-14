// E2E で、受け取ったキー入力をバイト列（16 進）で表示するプログラムの代わりに起動する
console.log("Key reporter ready");
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  console.log(`keys: ${[...data].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
});
