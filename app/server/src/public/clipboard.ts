// 端末のアプリが OSC 52 で頼んだクリップボードへの書き込みを、このブラウザのクリップボードに入れる。
// サーバーは、最後にそのターミナルへ入力した参加者にだけ送ってくる（docs/adr/113-osc52-clipboard.md）

// ブラウザは、ページにフォーカスがないときなどに書き込みを断る。そのときは、押すとクリップボードに入れるボタンを出す。
// ボタンを押すのはユーザーの操作なので、書き込める。中身は画面に出さない
export class ClipboardPrompt {
  readonly element = document.createElement("div");
  private pending: string | undefined;

  constructor(private notify: (text: string) => void) {
    this.element.className = "pane-clipboard";
    this.element.setAttribute("role", "alertdialog");
    this.element.setAttribute("aria-label", "クリップボードへのコピー");
    this.element.hidden = true;
    const message = document.createElement("span");
    message.textContent = "ターミナルのアプリが、クリップボードへのコピーを頼んでいます";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "クリップボードに入れる";
    copy.addEventListener("click", () => {
      const text = this.pending;
      this.hide();
      if (text !== undefined) void this.write(text, { retry: false });
    });
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.title = "閉じる";
    dismiss.setAttribute("aria-label", "閉じる");
    dismiss.addEventListener("click", () => this.hide());
    this.element.append(message, copy, dismiss);
  }

  request(text: string) {
    void this.write(text, { retry: true });
  }

  tooLarge() {
    this.notify("ターミナルのアプリがコピーを頼んだ中身が大きすぎるため、クリップボードに入れませんでした");
  }

  hide() {
    this.pending = undefined;
    this.element.hidden = true;
  }

  // retry は、断られたときにボタンを出すか（ボタンを押したあとに断られたら、もう出さない）
  private async write(text: string, { retry }: { retry: boolean }) {
    try {
      await navigator.clipboard.writeText(text);
      this.hide();
      this.notify(`クリップボードにコピーしました（${[...text].length} 文字）`);
    } catch {
      if (retry) {
        this.pending = text;
        this.element.hidden = false;
      } else {
        this.notify("クリップボードに入れられませんでした");
      }
    }
  }
}
