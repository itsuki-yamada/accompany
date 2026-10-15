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
  // コマンドが OSC 0 / OSC 2 で設定したタイトル。ブラウザに出す前に sanitizeTitle で整える
  title = "";

  constructor(
    private command: string[],
    // コマンドが終了したとき（シェルの exit など）に呼ぶ
    private onExit: () => void = () => {},
    // タイトルが変わったときに呼ぶ
    private onTitleChange: () => void = () => {},
  ) {
    this.screen.loadAddon(this.serializer);
    this.screen.onTitleChange((title) => {
      const sanitized = sanitizeTitle(title);
      if (sanitized === this.title) return;
      this.title = sanitized;
      this.onTitleChange();
    });
    for (const [final, hidden] of [["h", false], ["l", true]] as const) {
      this.screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) this.cursorHidden = hidden;
        return false;
      });
    }
    // RIS（ESC c）でカーソルも表示に戻る
    this.screen.parser.registerEscHandler({ final: "c" }, () => {
      this.cursorHidden = false;
      return false;
    });
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
    if (!this.proc) {
      this.proc = Bun.spawn(this.command, {
        terminal: {
          ...this.size,
          data: (_terminal, data) => {
            this.screen.write(data);
            this.broadcast({ type: "output", data });
          },
        },
      });
      this.proc.exited.then(() => this.onExit());
    }

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

  // TUI が残したモード（マウスの報告など）を戻す。モードは参加者全員とサーバー側の画面が共有している状態なので、
  // RIS（ESC c）を出力の流れに混ぜて、出力と同じ順番で全員とサーバー側の画面に届ける。コマンドには何も送らない
  reset() {
    const data = encoder.encode("\x1bc");
    this.screen.write(data);
    this.broadcast({ type: "output", data });
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

// タイトルとして出す長さの上限（文字数）。超えた部分は切り詰め、末尾に … を付ける
const maxTitleLength = 256;

// コマンドが設定したタイトルを、バーに出せる 1 行の文字列に整える。
// C0・C1 の制御文字はサーバー側の端末が OSC を読むときに取り除くが、念のためここでも取り除く。
// 双方向テキストの制御文字は表示を偽装できるので取り除き、改行にあたる文字は空白にする
export function sanitizeTitle(title: string) {
  const text = title
    .replace(/[\u2028\u2029\u0085]/g, " ")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  const chars = [...text];
  return chars.length > maxTitleLength ? `${chars.slice(0, maxTitleLength - 1).join("")}…` : text;
}
