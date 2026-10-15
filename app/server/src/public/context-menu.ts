export type MenuItem = { label: string; disabled?: boolean; action: () => void } | "separator";

// 開いているメニューは画面に 1 つだけ
let closeCurrent: (() => void) | undefined;

// 指定した位置にメニューを出す。Escape・Tab・外側のクリック・項目の選択で閉じる。
// 外側のクリック以外で閉じたときは、onClose でキー入力の先を元に戻す
export function showContextMenu(x: number, y: number, items: MenuItem[], onClose: () => void) {
  closeCurrent?.();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === "separator") {
      const separator = document.createElement("div");
      separator.setAttribute("role", "separator");
      menu.append(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = item.label;
    // 選べない項目も、矢印キーで移れるようにフォーカスは受け付ける
    if (item.disabled) button.setAttribute("aria-disabled", "true");
    // マウスで指した項目にフォーカスを移し、強調する項目を 1 つにする
    button.addEventListener("mouseenter", () => button.focus());
    button.addEventListener("click", () => {
      if (item.disabled) return;
      close(true);
      item.action();
    });
    buttons.push(button);
    menu.append(button);
  }

  const moveFocus = (step: number) => {
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };
  menu.addEventListener("keydown", (event) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveFocus(1),
      ArrowUp: () => moveFocus(-1),
      Home: () => buttons[0]?.focus(),
      End: () => buttons.at(-1)?.focus(),
      Escape: () => close(true),
      Tab: () => close(true),
    };
    const handle = keys[event.key];
    if (!handle) return;
    event.preventDefault();
    handle();
  });

  const onPointerDown = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) close(false);
  };
  const close = (restoreFocus: boolean) => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    menu.remove();
    closeCurrent = undefined;
    if (restoreFocus) onClose();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  closeCurrent = () => close(false);

  // 画面からはみ出さないように置く
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - height))}px`;
  buttons[0]?.focus();
}
