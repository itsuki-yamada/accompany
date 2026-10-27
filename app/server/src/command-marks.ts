import type { TrimmedLines } from "./trimmed-lines";

// シェルの統合（OSC 133）の印で、直前に実行したコマンドの出力の範囲を覚える（docs/adr/112-copy-last-output.md）。
// ブラウザ（@xterm/xterm）とサーバー側の画面（@xterm/headless）の両方で使う。サーバー側の画面で覚えた範囲は、
// 途中から参加した人や、ページを読み込み直した人に送る（画面の書き出しには OSC 133 の印が含まれないため）。
// 範囲の行は xterm の marker で覚え、出力でスクロールバックが押し出されても同じ行についていく。
// 代替画面（全画面の TUI が使う）の中の印は扱わない

// 範囲の端。y は出力の始めからの行の番号（バッファの行に、スクロールバックから押し出された行の数を足したもの）
export type Position = { x: number; y: number };

// 送るときの形。integrated は OSC 133 の印を受け取ったことがあるか。last は直前のコマンドの出力の範囲（end の位置の文字は含まない）、
// running は実行中のコマンドの出力の始まり
export type CommandMarksState = { integrated: boolean; last?: { start: Position; end: Position }; running?: Position };

// コピーできないときの理由
export type Unavailable = "no-integration" | "no-command" | "alternate";

type Marker = { line: number; isDisposed: boolean; dispose: () => void };
type Line = { isWrapped: boolean; translateToString: (trimRight?: boolean, start?: number, end?: number) => string };
type Buffer = {
  type: "normal" | "alternate";
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine: (y: number) => Line | undefined;
};
// @xterm/xterm と @xterm/headless の Terminal のうち、使うところ
type MarkTerminal = {
  buffer: { active: Buffer; normal: Buffer };
  registerMarker: (cursorYOffset?: number) => Marker | undefined;
  parser: {
    registerOscHandler: (ident: number, callback: (data: string) => boolean) => unknown;
    registerEscHandler: (id: { final: string }, callback: () => boolean) => unknown;
  };
};
type Placed = { x: number; marker: Marker };

export class CommandMarks {
  integrated = false;
  private last: { start: Placed; end: Placed } | undefined;
  private running: Placed | undefined;

  constructor(
    private terminal: MarkTerminal,
    private trimmed: TrimmedLines,
  ) {
    terminal.parser.registerOscHandler(133, (data) => {
      this.integrated = true;
      if (terminal.buffer.active.type !== "normal") return false;
      const kind = data.split(";")[0];
      if (kind === "C") {
        this.running?.marker.dispose();
        this.running = this.here();
      } else if ((kind === "D" || kind === "A") && this.running) {
        // D を出さずに次のプロンプト（A）を出すシェルもあるので、A でも終わりとみなす
        const end = this.here();
        if (end) this.setLast({ start: this.running, end });
        else this.running.marker.dispose();
        this.running = undefined;
      }
      return false;
    });
    // リセット（RIS）でバッファが作り直されると、覚えていた行はなくなる
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.setLast(undefined);
      this.running?.marker.dispose();
      this.running = undefined;
      return false;
    });
  }

  // 直前のコマンドの出力の文字列と行の数、範囲（バッファの行。end の位置の文字は含まない）。コピーできないときは、その理由
  lastOutput(): { text: string; lines: number; start: Position; end: Position } | { unavailable: Unavailable } {
    const unavailable = this.unavailable();
    const last = this.last;
    if (unavailable || !last) return { unavailable: unavailable ?? "no-command" };
    // 始まりの行だけが押し出されたときは、残っている先頭の行から
    const start = last.start.marker.isDisposed ? { x: 0, y: 0 } : { x: last.start.x, y: last.start.marker.line };
    const end = { x: last.end.x, y: last.end.marker.line };
    const buffer = this.terminal.buffer.normal;
    let text = "";
    for (let y = start.y; y <= end.y; y++) {
      const from = y === start.y ? start.x : 0;
      // 終わりの位置が行の頭なら、その行は含めない
      if (y === end.y && end.x === 0 && y > start.y) break;
      const line = buffer.getLine(y);
      if (!line) break;
      // 折り返した行は、前の行の続きとしてつなぐ
      if (y > start.y && !line.isWrapped) text += "\n";
      text += line.translateToString(true, from, y === end.y ? end.x : undefined);
    }
    text = text.replace(/\n+$/, "");
    const lines = text === "" ? 0 : text.split("\n").length;
    return { text, lines, start, end };
  }

  // コピーできないときは、その理由。文字列は読まないので、出力のたびに呼んでもよい
  unavailable(): Unavailable | undefined {
    if (!this.integrated) return "no-integration";
    if (this.terminal.buffer.active.type !== "normal") return "alternate";
    // 終わりの行がスクロールバックから押し出された（または画面を消した）ら、もうコピーできない
    if (!this.last || this.last.end.marker.isDisposed) return "no-command";
    return undefined;
  }

  // サーバー側の画面で覚えている範囲を、送る形にする
  state(): CommandMarksState {
    const offset = this.trimmed.count;
    const position = (placed: Placed | undefined) =>
      placed && !placed.marker.isDisposed ? { x: placed.x, y: placed.marker.line + offset } : undefined;
    const start = position(this.last?.start);
    const end = position(this.last?.end);
    return {
      integrated: this.integrated,
      last: start && end ? { start, end } : undefined,
      running: position(this.running),
    };
  }

  // サーバー側の画面から届いた範囲を覚える。つないだときに届いた画面を書き終えてから呼ぶ（行に印を置くため）。
  // 書き終えるまでに受け取った印のほうが新しいので、それは上書きしない
  restore(state: CommandMarksState) {
    this.integrated ||= state.integrated;
    if (this.terminal.buffer.active.type !== "normal") return;
    if (!this.last && state.last) {
      const start = this.place(state.last.start);
      const end = this.place(state.last.end);
      if (start && end) this.setLast({ start, end });
      else {
        start?.marker.dispose();
        end?.marker.dispose();
      }
    }
    if (!this.running && state.running) this.running = this.place(state.running);
  }

  private setLast(range: { start: Placed; end: Placed } | undefined) {
    this.last?.start.marker.dispose();
    this.last?.end.marker.dispose();
    this.last = range;
  }

  private here(): Placed | undefined {
    const marker = this.terminal.registerMarker(0);
    return marker && { x: this.terminal.buffer.active.cursorX, marker };
  }

  // 出力の始めからの行の番号の位置に、印を置く。印は、カーソルの行からの相対で置く
  private place({ x, y }: Position): Placed | undefined {
    if (y < this.trimmed.count) return undefined;
    const buffer = this.terminal.buffer.active;
    const marker = this.terminal.registerMarker(y - this.trimmed.count - (buffer.baseY + buffer.cursorY));
    return marker && { x, marker };
  }
}
