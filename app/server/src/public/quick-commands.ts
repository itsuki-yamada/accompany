// よく使うコマンド。一覧はサーバーが持ち、参加者全員で共有する（docs/adr/35-quick-commands.md）
export type QuickCommand = { id: string; name: string; content: string; run: boolean };

// 登録・編集・削除する画面。1 つだけ作り、どのターミナルのメニューからも開く
export class QuickCommands {
  list: QuickCommand[] = [];
  private dialog = document.createElement("dialog");
  private items = document.createElement("ul");
  private empty = document.createElement("p");
  private form = document.createElement("form");
  private nameInput = document.createElement("input");
  private contentInput = document.createElement("textarea");
  private runInput = document.createElement("input");
  private submit = document.createElement("button");
  private cancel = document.createElement("button");
  // 編集中のコマンド。未設定なら新しく登録する
  private editing: string | undefined;

  constructor(private send: (message: object) => void) {
    this.dialog.className = "quick-commands";
    this.dialog.setAttribute("aria-labelledby", "quick-commands-heading");
    const heading = document.createElement("h2");
    heading.id = "quick-commands-heading";
    heading.textContent = "よく使うコマンド";
    const note = document.createElement("p");
    note.className = "quick-commands-note";
    note.textContent = "参加者全員で共有します。ターミナルのバーの「コマンド」から選ぶと、そのターミナルに入力します";
    this.empty.textContent = "まだ登録していません";
    this.empty.className = "quick-commands-empty";

    this.nameInput.type = "text";
    this.nameInput.placeholder = "例: テスト（空なら内容の 1 行目）";
    this.contentInput.required = true;
    this.contentInput.rows = 3;
    this.contentInput.placeholder = "例: npm test";
    this.runInput.type = "checkbox";
    this.submit.type = "submit";
    this.cancel.type = "button";
    this.cancel.textContent = "キャンセル";
    this.cancel.addEventListener("click", () => this.resetForm());
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "閉じる";
    close.addEventListener("click", () => this.dialog.close());
    const actions = document.createElement("div");
    actions.className = "quick-commands-actions";
    actions.append(this.submit, this.cancel);
    this.form.append(
      field("名前", this.nameInput),
      field("内容", this.contentInput),
      field("Enter まで送る（すぐ実行）", this.runInput),
      actions,
    );
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const command = { name: this.nameInput.value, content: this.contentInput.value, run: this.runInput.checked };
      if (this.editing) this.send({ type: "update-command", id: this.editing, ...command });
      else this.send({ type: "add-command", ...command });
      this.resetForm();
    });
    const footer = document.createElement("div");
    footer.className = "quick-commands-footer";
    footer.append(close);
    this.dialog.append(heading, note, this.items, this.empty, this.form, footer);
    document.body.append(this.dialog);
    this.resetForm();
    this.render();
  }

  // サーバーから一覧が届いたとき。編集中のコマンドがほかの参加者に消されたら、編集をやめる
  set(list: QuickCommand[]) {
    this.list = list;
    if (this.editing && !list.some((c) => c.id === this.editing)) this.resetForm();
    this.render();
  }

  open() {
    this.dialog.showModal();
    this.contentInput.focus();
  }

  private render() {
    this.empty.hidden = this.list.length > 0;
    this.items.replaceChildren(
      ...this.list.map((command) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.className = "quick-command-name";
        name.textContent = command.name;
        const content = document.createElement("code");
        content.className = "quick-command-content";
        content.textContent = command.content;
        item.append(name);
        if (command.run) {
          const badge = document.createElement("span");
          badge.className = "quick-command-run";
          badge.textContent = "Enter まで送る";
          item.append(badge);
        }
        item.append(
          content,
          button(`${command.name} を編集`, "編集", () => this.edit(command)),
          button(`${command.name} を削除`, "削除", () => this.send({ type: "remove-command", id: command.id })),
        );
        return item;
      }),
    );
  }

  private edit(command: QuickCommand) {
    this.editing = command.id;
    this.nameInput.value = command.name;
    this.contentInput.value = command.content;
    this.runInput.checked = command.run;
    this.submit.textContent = "保存";
    this.cancel.hidden = false;
    this.contentInput.focus();
  }

  private resetForm() {
    this.editing = undefined;
    this.form.reset();
    this.submit.textContent = "登録";
    this.cancel.hidden = true;
  }
}

function field(text: string, input: HTMLInputElement | HTMLTextAreaElement) {
  const label = document.createElement("label");
  label.className = input.type === "checkbox" ? "quick-commands-check" : "quick-commands-field";
  const span = document.createElement("span");
  span.textContent = text;
  if (input.type === "checkbox") label.append(input, span);
  else label.append(span, input);
  return label;
}

function button(label: string, text: string, onClick: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", onClick);
  return element;
}
