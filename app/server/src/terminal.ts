import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { Subprocess } from "bun";

type Listener = (data: Uint8Array) => void;

const cols = 80;
const rows = 24;
const encoder = new TextEncoder();

// サーバー上でコマンドを PTY 付きで動かし、入出力をつながっているブラウザと共有する
export class TerminalSession {
  private proc: Subprocess | undefined;
  private listeners = new Set<Listener>();
  // 途中から参加したブラウザに現在の画面を送るため、PTY の出力をサーバー側の端末にも反映しておく
  private screen = new Terminal({ cols, rows, allowProposedApi: true });
  private serializer = new SerializeAddon();
  // 書き出した画面にはカーソルの表示・非表示が含まれないため、DECTCEM（CSI ? 25 h/l）を見て自分で追う
  private cursorHidden = false;

  constructor(private command: string[]) {
    this.screen.loadAddon(this.serializer);
    for (const [final, hidden] of [["h", false], ["l", true]] as const) {
      this.screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) this.cursorHidden = hidden;
        return false;
      });
    }
  }

  attach(listener: Listener): () => void {
    // サーバー側の端末は書き込みを非同期に処理する。ここまでの出力を反映し終えてから画面を書き出し、
    // それまでに届いた出力は書き出した画面に含まれないので、ためておいて画面のあとに送る
    const pending: Uint8Array[] = [];
    let restored = false;
    const receive: Listener = (data) => (restored ? listener(data) : pending.push(data));
    this.listeners.add(receive);
    this.screen.write("", () => {
      const snapshot = this.serializer.serialize() + (this.cursorHidden ? "\x1b[?25l" : "");
      if (snapshot) listener(encoder.encode(snapshot));
      pending.forEach(listener);
      restored = true;
    });

    // 起動直後の出力を取りこぼさないよう、最初にブラウザがつながったときに起動する
    this.proc ??= Bun.spawn(this.command, {
      terminal: {
        cols,
        rows,
        data: (_terminal, data) => {
          this.screen.write(data);
          this.listeners.forEach((l) => l(data));
        },
      },
    });
    return () => this.listeners.delete(receive);
  }

  write(data: string) {
    this.proc?.terminal?.write(data);
  }

  kill() {
    this.proc?.kill();
  }
}
