// E2E で、代替スクリーンに全画面の TUI を描くエージェントの代わりに起動する（カーソルは隠す）
// Enter を押すたびに、同じ位置の「count」を描き直す
const write = (s: string) => process.stdout.write(s);
let count = 0;
const draw = () => write(`\x1b[2J\x1b[5;10HFake TUI\x1b[7;10Hcount: ${count}`);

write("\x1b[?1049h\x1b[?25l");
draw();
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  const enters = data.filter((byte) => byte === 13).length;
  if (enters > 0) {
    count += enters;
    draw();
  }
});
