// キーボードショートカット。修飾キーは macOS 向けの Cmd+Shift か、Windows / Linux 向けの Ctrl+Shift で、
// OS を判定せずにどちらも受け付ける。Shift なしの Ctrl キーはシェルのキーなので奪わない（docs/adr/31-shortcuts.md）
export type Direction = "left" | "right" | "up" | "down";

export type Shortcut =
  | { type: "split"; direction: "row" | "column" }
  | { type: "close" }
  | { type: "move-focus"; direction: Direction }
  | { type: "new-tab" }
  | { type: "next-tab" }
  | { type: "previous-tab" }
  | { type: "toggle-sidebar" }
  | { type: "focus-sidebar" };

// code はキーの位置（event.code）。Latin 以外の配列でも効くように、event.key（入力される文字）ではなく位置で判定する。
// key は画面に出す表記。repeat は、押し続けたときに繰り返してよいか（分割・閉じる・新しいタブ・サイドメニューは 1 回だけにする）
type Binding = { label: string; code: string; key: string; repeat: boolean; shortcut: Shortcut };

// 次／前のタブは ⌘⇧] / [ にしたかったが、macOS の Chrome が予約していてページに届かないので . / , にする。
// 分割は、新しいタブを開いて右・下に並べる（docs/adr/100-terminal-tabs.md）
const bindings: Binding[] = [
  { label: "右に分割", code: "KeyR", key: "R", repeat: false, shortcut: { type: "split", direction: "row" } },
  { label: "下に分割", code: "KeyD", key: "D", repeat: false, shortcut: { type: "split", direction: "column" } },
  { label: "ターミナルを閉じる", code: "KeyX", key: "X", repeat: false, shortcut: { type: "close" } },
  ...(["left", "right", "up", "down"] as const).map((direction) => ({
    label: "隣のターミナルへ移る",
    code: `Arrow${direction[0]!.toUpperCase()}${direction.slice(1)}`,
    key: "←↑→↓",
    repeat: true,
    shortcut: { type: "move-focus", direction } as const,
  })),
  { label: "新しいタブ", code: "KeyO", key: "O", repeat: false, shortcut: { type: "new-tab" } },
  { label: "次のタブ", code: "Period", key: ".", repeat: true, shortcut: { type: "next-tab" } },
  { label: "前のタブ", code: "Comma", key: ",", repeat: true, shortcut: { type: "previous-tab" } },
  // S は Sidebar、E は VS Code のエクスプローラーへ移るキー（⌘⇧E）にならう（docs/adr/72-sidebar.md）
  { label: "サイドメニューを出す・隠す", code: "KeyS", key: "S", repeat: false, shortcut: { type: "toggle-sidebar" } },
  { label: "サイドメニューへ移る", code: "KeyE", key: "E", repeat: false, shortcut: { type: "focus-sidebar" } },
];

// 一覧にだけ出すマウスの操作（xterm が扱う）。マウスの報告モードを使うアプリの上で、アプリにマウスを渡さずに選択する
// （docs/adr/114-force-selection.md）
const mouseActions = [{ label: "範囲を強制して選択", mac: "Option+ドラッグ", other: "Shift+ドラッグ" }];

// 一覧にだけ出す、サイドメニュー・ツールバーのタブにキー入力しているときのキー（docs/adr/139-tab-order.md）
const tabActions = [
  { label: "タブを前・後ろへ移す（サイドメニュー・ツールバーのタブで）", mac: "Option+↑↓ / ←→", other: "Alt+↑↓ / ←→" },
];

// ショートカットのキーなら、その操作を返す。押し続けて繰り返し届いた keydown のうち、繰り返さない操作は ignore にする
// （キーは止めるが、操作はしない）
export function shortcutFor(event: KeyboardEvent): Shortcut | "ignore" | undefined {
  // 日本語入力の変換中のキーは IME に任せる
  if (event.isComposing || !event.shiftKey || event.altKey || event.metaKey === event.ctrlKey) return;
  const binding = bindings.find((b) => b.code === event.code);
  if (!binding) return;
  return event.repeat && !binding.repeat ? "ignore" : binding.shortcut;
}

// 画面に出すキーの表記（例: ⌘⇧R / Ctrl+Shift+R）
function keysOf(binding: Binding) {
  return { mac: `⌘⇧${binding.key}`, other: `Ctrl+Shift+${binding.key}` };
}

// ボタンのツールチップ（例: 右に分割（⌘⇧R / Ctrl+Shift+R））。text はツールチップに出す操作の名前
export function withKeys(label: string, text = label) {
  const binding = bindings.find((b) => b.label === label);
  if (!binding) return text;
  const { mac, other } = keysOf(binding);
  return `${text}（${mac} / ${other}）`;
}

// ショートカットの一覧。ツールバーのボタンで開く
export function shortcutList() {
  const list = document.createElement("div");
  list.id = "shortcut-list";
  list.className = "shortcut-list";
  list.popover = "auto";
  list.setAttribute("role", "dialog");
  list.setAttribute("aria-label", "キーボードショートカット");

  const heading = document.createElement("h2");
  heading.textContent = "キーボードショートカット";
  const note = document.createElement("p");
  note.textContent = "ターミナルにキー入力しているときに使えます";
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const text of ["操作", "macOS", "Windows / Linux"]) {
    const th = document.createElement("th");
    th.textContent = text;
    head.append(th);
  }
  const body = table.createTBody();
  for (const binding of bindings.filter((b, i) => bindings.findIndex((c) => c.label === b.label) === i)) {
    const { mac, other } = keysOf(binding);
    const row = body.insertRow();
    for (const text of [binding.label, mac, other]) row.insertCell().textContent = text;
  }
  for (const { label, mac, other } of [...mouseActions, ...tabActions]) {
    const row = body.insertRow();
    for (const text of [label, mac, other]) row.insertCell().textContent = text;
  }
  list.append(heading, note, table);
  return list;
}
