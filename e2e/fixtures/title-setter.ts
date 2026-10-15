// E2E で、入力した行をターミナルのタイトルとして設定するコマンド（シェルや Claude Code の代わり）
// 「2;タイトル」と入力すると OSC 2、「0;タイトル」と入力すると OSC 0 でタイトルを設定する。
// キーボードから打ちにくい文字を試せるよう、\uXXXX はその文字に置き換える
console.log("Title setter ready");
for await (const line of console) {
  const text = line.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  process.stdout.write(`\x1b]${text}\x07`);
  console.log(`title set: ${line.length}`);
}
