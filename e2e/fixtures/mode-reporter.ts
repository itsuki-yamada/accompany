// E2E で、TUI が有効にするモードを有効にしたまま、受け取った入力をバイト列（16 進）で表示するプログラムの代わりに起動する
// - マウスの報告モード（SGR 形式）: クリックが ESC [ < ... で届く
// - アプリケーションカーソルキーモード: 上矢印が ESC O A で届く（通常は ESC [ A）
// 終了するときにモードを戻さない TUI のように、有効にしたまま動き続ける
// 準備完了は、raw モードにしてモードを有効にしてから表示する（key-reporter.ts と同じく、テストを安定させるため）
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  console.log(`keys: ${[...data].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
});
process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?1h");
console.log("Mode reporter ready");
