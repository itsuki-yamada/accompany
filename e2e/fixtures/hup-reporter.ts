// E2E で、シェルの前面で動くコマンドの代わりに起動する。プロセス ID を E2E_DIR/reporter.pid に書き、
// SIGHUP を受けたら、E2E_HUP_DELAY_MS（既定 0）ミリ秒の片付けをしてから、そのときまだ端末（標準出力）に書けたか
// （open / closed）を E2E_DIR/hup に書いて終わる。端末が閉じたあと（PTY のもう一方が閉じたあと）は、書けずに closed になる
import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.E2E_DIR!;
const delayMs = Number(process.env.E2E_HUP_DELAY_MS) || 0;
writeFileSync(join(dir, "reporter.pid"), String(process.pid));
process.on("SIGHUP", () => {
  setTimeout(() => {
    let state = "open";
    try {
      writeSync(1, "Received SIGHUP\r\n");
    } catch {
      state = "closed";
    }
    writeFileSync(join(dir, "hup"), state);
    process.exit(129);
  }, delayMs);
});
console.log("Waiting for SIGHUP");
setInterval(() => {}, 1000);
