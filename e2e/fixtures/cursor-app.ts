// E2E で、アプリケーションカーソルモード（DECCKM）にして画面を描き続ける TUI の代わりに起動する。
// このモードでは、ブラウザの端末は矢印キーを SS3（ESC O A など）で送る
process.stdout.write("\x1b[?1hCursor App ready\r\n");
let frame = 0;
setInterval(() => process.stdout.write(`frame ${++frame}\r`), 100);
