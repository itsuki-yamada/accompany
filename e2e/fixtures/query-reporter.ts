// E2E で、端末への問い合わせ（デバイス属性・カーソルの位置・色など）を出し、届いた返事を種類ごとに数えて表示するプログラムの代わりに起動する
// （git の delta や less、vim のように、起動時に端末へ問い合わせるコマンドの代わり）
// - q を押すと、問い合わせをまとめて出し、collectMs の間に届いた返事を数えて「<種類> replies: <数> <返事の中身>」の形で表示する
// - フォーカスの報告（CSI ? 1004 h）を有効にし、届いたら「focus: in」「focus: out」と表示する
// - それ以外に打った文字は、Enter で「typed: <文字>」と表示する
// 準備完了は、raw モードにしてモードを有効にしてから表示する（key-reporter.ts と同じく、テストを安定させるため）
const queries = [
  { kind: "DA1", query: "\x1b[c", reply: /\x1b\[\?[\d;]*c/g },
  { kind: "DA2", query: "\x1b[>c", reply: /\x1b\[>[\d;]*c/g },
  { kind: "DSR", query: "\x1b[5n", reply: /\x1b\[0n/g },
  { kind: "CPR", query: "\x1b[6n", reply: /\x1b\[\d+;\d+R/g },
  { kind: "DECRQM", query: "\x1b[?2004$p", reply: /\x1b\[\?2004;\d\$y/g },
  { kind: "DECRQSS", query: "\x1bP$qm\x1b\\", reply: /\x1bP[01]\$r[^\x1b]*\x1b\\/g },
  { kind: "OSC 10", query: "\x1b]10;?\x1b\\", reply: /\x1b\]10;([^\x07\x1b]*)(?:\x07|\x1b\\)/g },
  { kind: "OSC 11", query: "\x1b]11;?\x1b\\", reply: /\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)/g },
  { kind: "OSC 12", query: "\x1b]12;?\x1b\\", reply: /\x1b\]12;([^\x07\x1b]*)(?:\x07|\x1b\\)/g },
];
const collectMs = 1000;

let collecting: string | undefined;
let line = "";

process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  const text = data.toString();
  if (collecting !== undefined) {
    collecting += text;
    return;
  }
  for (const part of text.split(/(\x1b\[[IO])/)) {
    if (part === "\x1b[I") console.log("focus: in");
    else if (part === "\x1b[O") console.log("focus: out");
    else if (part === "q" && line === "") ask();
    else if (part.includes("\r")) {
      console.log(`typed: ${line}${part.split("\r")[0]}`);
      line = "";
    } else line += part;
  }
});

function ask() {
  collecting = "";
  process.stdout.write(queries.map((q) => q.query).join(""));
  setTimeout(() => {
    let rest = collecting ?? "";
    collecting = undefined;
    for (const { kind, reply } of queries) {
      const matches = [...rest.matchAll(reply)];
      rest = rest.replace(reply, "");
      console.log(`${kind} replies: ${matches.length} ${matches.map((m) => m[1] ?? "").join(" ")}`.trimEnd());
    }
    // 返事と見分けられなかったもの（フォーカスの報告など）
    if (rest) console.log(`other: ${JSON.stringify(rest)}`);
    console.log("Query report done");
  }, collectMs);
}

process.stdout.write("\x1b[?1004h");
console.log("Query reporter ready");
