// タブ（ターミナル）に名前を付ける入力欄。ターミナルのバー、サイドメニュー・ツールバーのタブで、名前の代わりに出す。
// 名前は全員で共有し、整えるのはサーバー（docs/adr/110-tab-name.md）
import { maxNameLength, trimName } from "./member-name";

export type TabNameEditor = {
  // 付けている名前。付けていなければ空
  value: string;
  // 名前を付けていないときの名前（「ターミナル N」）。入力欄の例として出す
  placeholder: string;
  // 入力欄の読み上げ名。既定は「ターミナルの名前」（グループの名前にも使う。docs/adr/209-tab-groups.md）
  label?: string;
  // 決めた名前（前後の空白を除き、上限の文字数までに切り詰めたもの）。空なら名前をやめる
  commit: (name: string) => void;
  // 入力欄を閉じたあと。keyboard は Enter・Esc で閉じたか（キー入力の先を戻すため。ほかの場所を押して閉じたときは戻さない）
  finish: (keyboard: boolean) => void;
};

// anchor（名前の表示）を隠して、その場所に入力欄を出す。Enter か、入力欄を離れたときに決め、Esc でやめる
export function editTabName(anchor: HTMLElement, { value, placeholder, label = "ターミナルの名前", commit, finish }: TabNameEditor) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-name-editor";
  input.value = value;
  input.placeholder = placeholder;
  input.title = `名前（${maxNameLength} 文字まで）。空にすると「${placeholder}」に戻ります`;
  input.setAttribute("aria-label", label);
  let done = false;
  const close = (save: boolean, keyboard: boolean) => {
    if (done) return;
    done = true;
    const name = trimName(input.value);
    input.remove();
    anchor.hidden = false;
    if (save && name !== value) commit(name);
    finish(keyboard);
  };
  input.addEventListener("keydown", (event) => {
    // サイドメニューの ↑↓・Esc や、ターミナルのショートカットに渡さない
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      close(true, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(false, true);
    }
  });
  input.addEventListener("blur", () => close(true, false));
  // 入力欄の中のクリックで、タブを選んだり、ドラッグを始めたりしない
  for (const type of ["click", "dblclick", "pointerdown", "dragstart"] as const) {
    input.addEventListener(type, (event) => event.stopPropagation());
  }
  anchor.hidden = true;
  anchor.after(input);
  input.focus();
  input.select();
}

// 名前を付けている入力欄にキー入力しているか
export function isEditingTabName() {
  return document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains("tab-name-editor");
}
