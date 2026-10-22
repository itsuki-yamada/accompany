// 自分の名前。ほかの参加者の画面（ターミナルのバー、サイドメニュー、ペアプロモードの表示など）に出る。
// このブラウザに保存し、つないだときと変えたときにサーバーへ送る。整えるのはサーバー（docs/adr/96-member-name.md）
const storageKey = "accompany.name";
// サーバーの上限（app/server/src/member-name.ts の maxNameLength）と同じ
const maxNameLength = 32;

// 保存した名前を読む。保存していない・読めないときは空（名前を設定していない）
export function loadName() {
  try {
    return localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string) {
  try {
    if (name) localStorage.setItem(storageKey, name);
    else localStorage.removeItem(storageKey);
  } catch {
    // 保存できなくても、開いている間は使う
  }
}

// 設定の画面（表示の設定）に置く、名前の入力欄。入力欄を離れたとき（change）か Enter で、保存してサーバーに送る。
// 入力のたびに送ると、途中の名前がほかの参加者の画面で次々に変わってしまう
export class NameSettings {
  readonly element = document.createElement("section");
  private input = document.createElement("input");
  private saved = loadName();

  constructor(send: (name: string) => void) {
    const heading = document.createElement("h2");
    heading.textContent = "あなたの名前";
    const note = document.createElement("p");
    note.textContent = "ほかの参加者の画面に出ます。このブラウザに保存します。空にすると「参加者 N」に戻ります";
    this.input.type = "text";
    this.input.maxLength = maxNameLength;
    this.input.autocomplete = "nickname";
    this.input.value = this.saved;
    const commit = () => {
      const name = this.input.value.trim();
      this.input.value = name;
      if (name === this.saved) return;
      this.saved = name;
      saveName(name);
      send(name);
    };
    this.input.addEventListener("change", commit);
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) commit();
    });
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = `名前（${maxNameLength} 文字まで）`;
    this.input.setAttribute("aria-label", "あなたの名前");
    label.append(caption, this.input);
    this.element.className = "name-settings";
    this.element.append(heading, note, label);
  }

  // つないだときにサーバーへ送る名前。設定していなければ空
  get current() {
    return this.saved;
  }

  // 名前を設定していないときに使われる名前（「参加者 N」）を、入力欄の例として出す
  setDefault(name: string) {
    this.input.placeholder = name;
  }
}
