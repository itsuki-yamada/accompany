// 端末の通常の画面で、スクロールバックがいっぱいになって先頭から押し出された行の数を数える。
// バッファの行の番号にこの数を足すと、押し出されても変わらない「出力の始めからの行の番号」になる。
// 参加者ごとに、出力を書き終えた時点（押し出された行の数）がずれていても、同じ文字の行を指せる（docs/adr/94-remote-selection.md）。
// ブラウザ（@xterm/xterm）とサーバー側の画面（@xterm/headless）の両方で使う。xterm の公開の API には押し出しを知らせるものが
// ないので、内部の API（バッファの行の一覧の onTrim）を使う。リセットするとバッファが作り直されるので、そのたびにつなぎ直す
export class TrimmedLines {
  count: number;

  constructor(terminal: object, start = 0) {
    this.count = start;
    const buffers = (terminal as any)._core._bufferService.buffers;
    let normal: any;
    let subscription: { dispose: () => void } | undefined;
    const watch = () => {
      if (buffers.normal === normal) return;
      subscription?.dispose();
      normal = buffers.normal;
      subscription = normal.lines.onTrim((amount: number) => (this.count += amount));
    };
    watch();
    buffers.onBufferActivate(watch);
  }
}
