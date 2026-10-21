// E2E で、指定した行数を一度に出力するコマンドの代わりに起動する。スクロールバック（1000 行）を超える出力を試すため。
// 数を入力して Enter を押すと、通し番号の付いた行（row 1, row 2, ...）をその数だけ出す
console.log("Line printer ready");
let next = 1;
let input = "";
process.stdin.on("data", (data) => {
  input += data.toString();
  const lines = input.split("\n");
  input = lines.pop() ?? "";
  for (const line of lines) {
    const count = Number(line.trim());
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    const rows: string[] = [];
    for (let i = 0; i < count; i++) rows.push(`row ${next++}`);
    console.log(rows.join("\n"));
  }
});
