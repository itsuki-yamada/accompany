// E2E で、端末のサイズを左上に、目印の言葉と URL を右下の隅に表示するエージェントの代わりに起動する。
// サイズが変わるたびに描き直す。描いたあとはカーソルを左下に置くので、入力した文字は端末のエコーで左下に出る
const corner = "corner-word https://example.com/corner";

const draw = () => {
  const { columns, rows } = process.stdout;
  process.stdout.write(
    `\x1b[2J\x1b[H` + `size: ${columns}x${rows}` + `\x1b[${rows};${columns - corner.length}H${corner}` + `\x1b[${rows};1H`,
  );
};
draw();
process.on("SIGWINCH", draw);
// シグナルを待つだけだとプロセスが終わってしまうので、動き続ける
setInterval(() => {}, 1 << 30);
