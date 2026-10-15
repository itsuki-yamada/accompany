// キーボードショートカット。修飾キーは macOS 向けの Cmd+Shift か、Windows / Linux 向けの Ctrl+Shift で、
// OS を判定せずにどちらも受け付ける。Shift なしの Ctrl キーはシェルのキーなので奪わない（docs/adr/31-shortcuts.md）
export type Direction = "left" | "right" | "up" | "down";

export type Shortcut =
  | { type: "split"; direction: "row" | "column" }
  | { type: "close" }
  | { type: "move-focus"; direction: Direction }
  | { type: "new-tab" }
  | { type: "next-tab" }
  | { type: "previous-tab" };

type Binding = { label: string; keys: string[]; shortcut: Shortcut };

// keys は event.key を小文字にしたもの。] / [ は Shift で } / { になる配列があるので両方を受け付ける
const bindings: Binding[] = [
  { label: "右に分割", keys: ["r"], shortcut: { type: "split", direction: "row" } },
  { label: "下に分割", keys: ["d"], shortcut: { type: "split", direction: "column" } },
  { label: "ターミナルを閉じる", keys: ["x"], shortcut: { type: "close" } },
  { label: "隣のターミナルへ移る", keys: ["arrowleft"], shortcut: { type: "move-focus", direction: "left" } },
  { label: "隣のターミナルへ移る", keys: ["arrowright"], shortcut: { type: "move-focus", direction: "right" } },
  { label: "隣のターミナルへ移る", keys: ["arrowup"], shortcut: { type: "move-focus", direction: "up" } },
  { label: "隣のターミナルへ移る", keys: ["arrowdown"], shortcut: { type: "move-focus", direction: "down" } },
  { label: "新しいタブ", keys: ["o"], shortcut: { type: "new-tab" } },
  { label: "次のタブ", keys: ["]", "}"], shortcut: { type: "next-tab" } },
  { label: "前のタブ", keys: ["[", "{"], shortcut: { type: "previous-tab" } },
];

export function shortcutFor(event: KeyboardEvent): Shortcut | undefined {
  // 日本語入力の変換中のキーは IME に任せる
  if (event.isComposing || !event.shiftKey || event.altKey || event.metaKey === event.ctrlKey) return;
  const key = event.key.toLowerCase();
  return bindings.find((b) => b.keys.includes(key))?.shortcut;
}

// 画面に出すキーの表記（例: ⌘⇧R / Ctrl+Shift+R）
// 隣のターミナルへの移動は、4 つの向きをまとめて 1 行で出す
function keysOf(binding: Binding) {
  const key = binding.shortcut.type === "move-focus" ? "←↑→↓" : binding.keys[0]!.toUpperCase();
  return { mac: `⌘⇧${key}`, other: `Ctrl+Shift+${key}` };
}

// ボタンのツールチップ（例: 右に分割（⌘⇧R / Ctrl+Shift+R））。text はツールチップに出す操作の名前
export function withKeys(label: string, text = label) {
  const binding = bindings.find((b) => b.label === label);
  if (!binding) return text;
  const { mac, other } = keysOf(binding);
  return `${text}（${mac} / ${other}）`;
}

// ショートカットの一覧。タブバーのボタンで開く
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
  list.append(heading, note, table);
  return list;
}
