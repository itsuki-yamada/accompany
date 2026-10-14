// E2E で、端末のサイズを表示し、サイズが変わるたびに表示し直すエージェントの代わりに起動する
const report = () => console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`);
report();
process.on("SIGWINCH", report);
// シグナルを待つだけだとプロセスが終わってしまうので、動き続ける
setInterval(() => {}, 1 << 30);
