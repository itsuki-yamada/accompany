import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { Subprocess } from "bun";

export type Size = { cols: number; rows: number };

// ブラウザに送るもの。出力と端末の大きさの変更は、この順番どおりに届ける
export type Message = { type: "output"; data: Uint8Array } | { type: "resize"; size: Size };
type Listener = (message: Message) => void;

export type Participant = {
  // 参加者のブラウザの画面に収まる大きさを伝える
  resize: (size: Size) => void;
  detach: () => void;
};

const encoder = new TextEncoder();

// サーバー上でコマンドを PTY 付きで動かし、入出力をつながっているブラウザと共有する
export class TerminalSession {
  private proc: Subprocess | undefined;
  private listeners = new Set<Listener>();
  // 端末の大きさは、参加者のうち一番小さい画面に合わせる
  private size: Size = { cols: 80, rows: 24 };
  private requestedSizes = new Map<Listener, Size>();
  // 途中から参加したブラウザに現在の画面を送るため、PTY の出力をサーバー側の端末にも反映しておく
  private screen = new Terminal({ ...this.size, allowProposedApi: true });
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

  attach(listener: Listener): Participant {
    // サーバー側の端末は書き込みを非同期に処理する。ここまでの出力を反映し終えてから画面を書き出し、
    // それまでに届いたものは書き出した画面に含まれないので、ためておいて画面のあとに送る
    const pending: Message[] = [];
    let restored = false;
    const receive: Listener = (message) => (restored ? listener(message) : pending.push(message));
    this.listeners.add(receive);
    this.screen.write("", () => {
      listener({ type: "resize", size: this.size });
      const snapshot = this.serializer.serialize() + (this.cursorHidden ? "\x1b[?25l" : "");
      if (snapshot) listener({ type: "output", data: encoder.encode(snapshot) });
      pending.forEach(listener);
      restored = true;
    });

    // 起動直後の出力を取りこぼさないよう、最初にブラウザがつながったときに起動する
    this.proc ??= Bun.spawn(this.command, {
      terminal: {
        ...this.size,
        data: (_terminal, data) => {
          this.screen.write(data);
          this.broadcast({ type: "output", data });
        },
      },
    });

    return {
      resize: (size) => {
        this.requestedSizes.set(receive, size);
        this.fitToSmallest();
      },
      detach: () => {
        this.listeners.delete(receive);
        this.requestedSizes.delete(receive);
        this.fitToSmallest();
      },
    };
  }

  write(data: string) {
    this.proc?.terminal?.write(data);
  }

  kill() {
    this.proc?.kill();
  }

  private fitToSmallest() {
    const sizes = [...this.requestedSizes.values()];
    if (sizes.length === 0) return;
    const size = {
      cols: Math.min(...sizes.map((s) => s.cols)),
      rows: Math.min(...sizes.map((s) => s.rows)),
    };
    if (size.cols === this.size.cols && size.rows === this.size.rows) return;
    this.size = size;
    this.screen.resize(size.cols, size.rows);
    this.proc?.terminal?.resize(size.cols, size.rows);
    this.broadcast({ type: "resize", size });
  }

  private broadcast(message: Message) {
    this.listeners.forEach((l) => l(message));
  }
}
