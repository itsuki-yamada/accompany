// E2E で、URL を出力するコマンド（Claude Code の代わり）。
// Claude Code と同じく、URL の文字列そのものを OSC 8 のハイパーリンクにした行と、ただの文字列の URL の行を出す。
// --mouse を付けると、Claude Code（全画面の表示）のようにマウスの報告モード（SGR 形式）を有効にし、
// 受け取った入力をバイト列（16 進）で表示する。Claude Code はクリックを受け取ると、その位置のリンクを自分でも開く
const mouse = process.argv.includes("--mouse");
if (mouse) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (data) => {
    console.log(`keys: ${[...data].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  });
  process.stdout.write("\x1b[?1000h\x1b[?1006h");
}
const osc8 = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
console.log(`OSC 8: ${osc8("http://link.test/osc8", "http://link.test/osc8")}`);
console.log("Plain: http://link.test/plain");
// --unsafe を付けると、http・https 以外の URL と、URL として解釈できない文字列も OSC 8 のハイパーリンクにして出す
if (process.argv.includes("--unsafe")) {
  // 開いてしまうと、Accompany と同じオリジンの新しいタブでスクリプトが動き、localStorage に印を残す
  console.log(`JS: ${osc8("javascript:localStorage.setItem('pwned','javascript')", "javascript-link")}`);
  console.log(`Data: ${osc8("data:text/html,<script>opener&&opener.localStorage.setItem('pwned','data')</script>", "data-link")}`);
  console.log(`File: ${osc8("file:///etc/hosts", "file-link")}`);
  console.log(`NoScheme: ${osc8("link.test/no-scheme", "no-scheme-link")}`);
}
console.log("Link output ready");
// 終わらずに待つ（終わるとターミナルが閉じる）
if (!mouse) for await (const _ of console);
