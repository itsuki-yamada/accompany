// E2E で、起動した時点の端末のサイズを一度だけ表示するエージェントの代わりに起動する。
// 起動したあとに大きさが変わっても表示し直さない（SIGWINCH も受けず、読み直しもしない）ので、
// 起動した時点で PTY がどの大きさだったかが分かる（docs/adr/208-start-at-first-size.md）
console.log(`start size: ${process.stdout.columns}x${process.stdout.rows}`);
// プロセスが終わらないよう、動き続ける
setInterval(() => {}, 1 << 30);
