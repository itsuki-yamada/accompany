// E2E で、Claude Code（全画面の表示）のようにマウスの報告モードを有効にし、受け取った入力をバイト列（16 進）で
// 表示するプログラムの代わりに起動する。Claude Code と同じく、押下・離す（?1000h）に加えてドラッグ（?1002h）も報告させ、
// 形式は SGR（?1006h）にする。SGR 形式の報告は ESC [ < で始まり（1b 5b 3c）、従来の形式は ESC [ M で始まる（1b 5b 4d）。
// Claude Code は、ドラッグの報告を受け取ると、選択した範囲を自分の出力として描く
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  console.log(`keys: ${[...data].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
});
process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
console.log("Mouse reporter ready");
