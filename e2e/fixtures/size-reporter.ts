// E2E で、端末のサイズを表示し、サイズが変わるたびに表示し直すエージェントの代わりに起動する
const report = () => console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`);
report();
// 大きさが変わったら（SIGWINCH を受けて process.stdout が大きさを読み直したら）、resize で知らされる。
// Bun の process.stdout は、起動時に大きさを読んでから SIGWINCH を受けられるようになるまでに少し間があり、その間に
// 届いた SIGWINCH は捨てられて、起動時の大きさのまま描き直さない（CI で E2E を並行に流して負荷が上がると当たる）。
// 取りこぼしても戻れるよう、PTY の実際の大きさ（ioctl）を 100ms ごとに読み直す。変わっていれば resize が出る。
// このタイマーは、シグナルを待つだけでプロセスが終わらないよう、動き続けるためのものも兼ねる（docs/adr/205-parallel-e2e.md）
process.stdout.on("resize", report);
setInterval(() => (process.stdout as any)._refreshSize?.(), 100);
