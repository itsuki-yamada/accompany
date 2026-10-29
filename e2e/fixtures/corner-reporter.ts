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
// 大きさが変わったら（SIGWINCH を受けて process.stdout が大きさを読み直したら）、resize で知らされる。
// Bun の process.stdout は、起動時に大きさを読んでから SIGWINCH を受けられるようになるまでに少し間があり、その間に
// 届いた SIGWINCH は捨てられて、起動時の大きさのまま描き直さない（CI で E2E を並行に流して負荷が上がると当たる）。
// 取りこぼしても戻れるよう、PTY の実際の大きさ（ioctl）を 100ms ごとに読み直す。変わっていれば resize が出る。
// このタイマーは、シグナルを待つだけでプロセスが終わらないよう、動き続けるためのものも兼ねる（docs/adr/205-parallel-e2e.md）
process.stdout.on("resize", draw);
setInterval(() => (process.stdout as any)._refreshSize?.(), 100);
