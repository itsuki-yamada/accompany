import type { Subprocess } from "bun";

type Listener = (data: Uint8Array) => void;

// サーバー上でコマンドを PTY 付きで動かし、入出力をつながっているブラウザと共有する
export class TerminalSession {
  private proc: Subprocess | undefined;
  private listeners = new Set<Listener>();

  constructor(private command: string[]) {}

  // 起動直後の出力を取りこぼさないよう、最初にブラウザがつながったときに起動する
  attach(listener: Listener): () => void {
    this.listeners.add(listener);
    this.proc ??= Bun.spawn(this.command, {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, data) => this.listeners.forEach((l) => l(data)),
      },
    });
    return () => this.listeners.delete(listener);
  }

  write(data: string) {
    this.proc?.terminal?.write(data);
  }

  kill() {
    this.proc?.kill();
  }
}
