// E2E で、マウスの報告モード（SGR 形式）を有効にしたまま、受け取った入力をバイト列（16 進）で表示する TUI の代わりに起動する
// 終了するときにモードを戻さない TUI のように、有効にしたまま動き続ける
console.log("Mouse reporter ready");
process.stdout.write("\x1b[?1000h\x1b[?1006h");
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  console.log(`keys: ${[...data].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
});
