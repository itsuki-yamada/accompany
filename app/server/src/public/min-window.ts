// 端末の大きさの下限。ウィンドウの大きさ（ピクセル）で持ち、参加者全員に効く。サーバーが持って全員に配り、保存する。
// 各ブラウザは、このウィンドウで Accompany を開いたときの表示領域に、自分のフォントの大きさで収まる列数・行数を求めて、
// 自分の表示領域に収まる列数・行数と一緒にサーバーに伝える（docs/adr/99-smallest-size.md）
export type WindowSize = { width: number; height: number };

// サーバーの上限（app/server/src/min-window.ts の maxMinWindow）と同じ。0 は下限なし
const maxWidth = 1920;
const maxHeight = 1080;

function valid(value: number, max: number) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

// 設定の画面（表示の設定）に置く、下限の入力欄。入力欄を離れたとき（change）に、範囲内の整数ならサーバーに送る。
// 入力のたびに送ると、途中の値で全員の端末の大きさが変わってしまう
export class MinWindowSettings {
  readonly element = document.createElement("section");
  private value: WindowSize | undefined;
  private width: HTMLInputElement;
  private height: HTMLInputElement;

  constructor(send: (size: WindowSize) => void) {
    const heading = document.createElement("h2");
    heading.textContent = "端末の大きさの下限";
    const note = document.createElement("p");
    note.textContent =
      "端末は参加者のうち一番小さい画面に合わせますが、一番大きい人の画面に入る範囲で、このウィンドウに収まる大きさまで広げます。参加者全員に効き、Accompany に保存します";
    this.width = numberInput(maxWidth);
    this.height = numberInput(maxHeight);
    for (const input of [this.width, this.height]) {
      input.addEventListener("change", () => {
        const size = { width: Number(this.width.value), height: Number(this.height.value) };
        // 空や範囲外のまま離れたら、使っている値に戻す
        if (this.width.value === "" || this.height.value === "" || !valid(size.width, maxWidth) || !valid(size.height, maxHeight)) {
          this.show();
          return;
        }
        send(size);
      });
    }
    this.element.className = "min-window-settings";
    this.element.append(
      heading,
      note,
      field(`ウィンドウの幅（0〜${maxWidth}px）`, this.width, "下限のウィンドウの幅"),
      field(`ウィンドウの高さ（0〜${maxHeight}px）`, this.height, "下限のウィンドウの高さ"),
    );
  }

  get current() {
    return this.value;
  }

  // サーバーから届いた下限を出す。入力中の欄は書き換えない（幅を変えて高さを入力している途中に、幅の変更が配られて
  // 戻ってくると、入力中の高さが消えてしまう）
  set(size: WindowSize) {
    this.value = size;
    this.show(false);
  }

  // 使っている下限を出す。force でなければ、入力中（フォーカスのある）欄はそのままにする
  private show(force = true) {
    if (!this.value) return;
    for (const [input, value] of [
      [this.width, this.value.width],
      [this.height, this.value.height],
    ] as const) {
      if (force || document.activeElement !== input) input.value = String(value);
    }
  }
}

function numberInput(max: number) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.max = String(max);
  input.step = "1";
  return input;
}

function field(text: string, control: HTMLElement, name: string) {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = text;
  control.setAttribute("aria-label", name);
  label.append(caption, control);
  return label;
}
