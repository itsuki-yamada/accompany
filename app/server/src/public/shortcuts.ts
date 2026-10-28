// キーボードショートカット。2 つの方式を受け付ける。
// - tmux のようなプレフィックス: Ctrl+T を押してから、キーを 1 つ押す（docs/adr/177-prefix-keys.md）
// - 修飾キー: macOS 向けの Cmd+Shift か、Windows / Linux 向けの Ctrl+Shift で、OS を判定せずにどちらも受け付ける。
//   Shift なしの Ctrl キーはシェルのキーなので奪わない（docs/adr/31-shortcuts.md）
export type Direction = "left" | "right" | "up" | "down";

export type Shortcut =
  | { type: "split"; direction: "row" | "column" }
  | { type: "close" }
  | { type: "move-focus"; direction: Direction }
  | { type: "next-pane" }
  | { type: "swap-pane"; step: 1 | -1 }
  | { type: "rotate-split" }
  | { type: "new-tab" }
  | { type: "next-tab" }
  | { type: "previous-tab" }
  | { type: "select-tab"; index: number }
  | { type: "rename-tab" }
  | { type: "copy-last-output" }
  | { type: "show-shortcuts" }
  | { type: "send-prefix" }
  | { type: "toggle-sidebar" }
  | { type: "focus-sidebar" };

// prefix は Ctrl+T のあとに押すキー（event.key、入力される文字）。% や " は配列によって位置が違うので、位置ではなく文字で判定する。
// prefixText は画面に出す表記（なければ prefix）。
// code・key・repeat は修飾キー（⌘⇧ / Ctrl+Shift）の方式のもの。code はキーの位置（event.code）で、Latin 以外の配列でも効くように
// 位置で判定する。key は画面に出す表記。repeat は、押し続けたときに繰り返してよいか（分割・閉じる・新しいタブ・サイドメニューは 1 回だけにする）
type Binding = {
  label: string;
  shortcut: Shortcut;
  prefix?: string;
  prefixText?: string;
  code?: string;
  key?: string;
  repeat?: boolean;
};

// プレフィックスのあとのキーは tmux の既定に寄せる。
// 修飾キーの次／前のタブは ⌘⇧] / [ にしたかったが、macOS の Chrome が予約していてページに届かないので . / , にする。
// 分割は、新しいタブを開いて右・下に並べる（docs/adr/100-terminal-tabs.md）
const bindings: Binding[] = [
  { label: "新しいタブ", prefix: "c", code: "KeyO", key: "O", repeat: false, shortcut: { type: "new-tab" } },
  { label: "次のタブ", prefix: "n", code: "Period", key: ".", repeat: true, shortcut: { type: "next-tab" } },
  { label: "前のタブ", prefix: "p", code: "Comma", key: ",", repeat: true, shortcut: { type: "previous-tab" } },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    label: "その番目のタブ",
    prefix: String(n),
    prefixText: "1〜9",
    shortcut: { type: "select-tab", index: n - 1 } as const,
  })),
  { label: "タブの名前を変える", prefix: ",", shortcut: { type: "rename-tab" } },
  { label: "右に分割", prefix: "%", code: "KeyR", key: "R", repeat: false, shortcut: { type: "split", direction: "row" } },
  { label: "下に分割", prefix: '"', code: "KeyD", key: "D", repeat: false, shortcut: { type: "split", direction: "column" } },
  ...(["left", "right", "up", "down"] as const).map((direction) => {
    const arrow = `Arrow${direction[0]!.toUpperCase()}${direction.slice(1)}`;
    return {
      label: "隣のターミナルへ移る",
      prefix: arrow,
      prefixText: "←↑→↓",
      code: arrow,
      key: "←↑→↓",
      repeat: true,
      shortcut: { type: "move-focus", direction } as const,
    };
  }),
  { label: "次のターミナルへ移る", prefix: "o", shortcut: { type: "next-pane" } },
  { label: "ターミナルを閉じる", prefix: "x", code: "KeyX", key: "X", repeat: false, shortcut: { type: "close" } },
  { label: "前・次のターミナルと入れ替える", prefix: "{", prefixText: "{ / }", shortcut: { type: "swap-pane", step: -1 } },
  { label: "前・次のターミナルと入れ替える", prefix: "}", prefixText: "{ / }", shortcut: { type: "swap-pane", step: 1 } },
  { label: "分割の向きを変える", prefix: " ", prefixText: "space", shortcut: { type: "rotate-split" } },
  // tmux には既定のキーがない。tmux-yank などにならって y（yank）にする
  { label: "直前のコマンドの出力をコピー", prefix: "y", shortcut: { type: "copy-last-output" } },
  { label: "ショートカットの一覧", prefix: "?", shortcut: { type: "show-shortcuts" } },
  // S は Sidebar、E は VS Code のエクスプローラーへ移るキー（⌘⇧E）にならう（docs/adr/72-sidebar.md）
  { label: "サイドメニューを出す・隠す", code: "KeyS", key: "S", repeat: false, shortcut: { type: "toggle-sidebar" } },
  { label: "サイドメニューへ移る", code: "KeyE", key: "E", repeat: false, shortcut: { type: "focus-sidebar" } },
];

// プレフィックスの表記
const prefixName = "Ctrl+T";

// 一覧にだけ出すマウスの操作（xterm が扱う）。マウスの報告モードを使うアプリの上で、アプリにマウスを渡さずに選択する
// （docs/adr/114-force-selection.md）
const mouseActions = [{ label: "範囲を強制して選択", mac: "Option+ドラッグ", other: "Shift+ドラッグ" }];

// 一覧にだけ出す、サイドメニュー・ツールバーのタブにキー入力しているときのキー（docs/adr/139-tab-order.md）
const tabActions = [
  { label: "タブを前・後ろへ移す（サイドメニュー・ツールバーのタブで）", mac: "Option+↑↓ / ←→", other: "Alt+↑↓ / ←→" },
];

// 修飾キーの方式のショートカットのキーなら、その操作を返す。押し続けて繰り返し届いた keydown のうち、繰り返さない操作は ignore にする
// （キーは止めるが、操作はしない）
export function shortcutFor(event: KeyboardEvent): Shortcut | "ignore" | undefined {
  // 日本語入力の変換中のキーは IME に任せる
  if (event.isComposing || !event.shiftKey || event.altKey || event.metaKey === event.ctrlKey) return;
  const binding = bindings.find((b) => b.code !== undefined && b.code === event.code);
  if (!binding) return;
  return event.repeat && !binding.repeat ? "ignore" : binding.shortcut;
}

// プレフィックスを押して、次のキーを待ち受けているか。タイムアウトはない（tmux と同じ）。Escape・関係ないキー・
// ページの外へのフォーカスの移動・クリックでやめる
let waiting = false;
// 直前にプレフィックスのあとで押したキーの位置。押し続けて繰り返し届いた keydown を、ターミナルに渡さずに止めるため
let lastCode: string | undefined;
const listeners = new Set<(waiting: boolean) => void>();

function setWaiting(value: boolean) {
  if (waiting === value) return;
  waiting = value;
  listeners.forEach((listener) => listener(value));
}

export function cancelPrefix() {
  setWaiting(false);
}

window.addEventListener("blur", cancelPrefix);
document.addEventListener("pointerdown", cancelPrefix, { capture: true });

// Ctrl+T（Shift・Alt・Cmd なし）。Latin 以外の配列では入力される文字が t にならないので、キーの位置でも見る
function isPrefix(event: KeyboardEvent) {
  if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false;
  return event.key.toLowerCase() === "t" || (!isAscii(event.key) && event.code === "KeyT");
}

function isAscii(key: string) {
  return key.length === 1 && key.charCodeAt(0) < 0x80;
}

const modifierKeys = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

// プレフィックスのあとのキー（event.key）。英字は、Latin 以外の配列でも効くように、入力される文字が英数字でなければキーの位置で見る
function prefixKeyOf(event: KeyboardEvent) {
  if (event.key.length === 1 && !isAscii(event.key) && /^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3).toLowerCase();
  }
  return event.key;
}

// プレフィックスの方式で、キーを処理する。操作するキーならその操作を、止めるだけのキー（プレフィックス、待ち受けをやめたキー）なら
// consume を返す。関係ないキーは undefined（ふだんどおり、ほかのショートカットやターミナルに渡す）
export function prefixKeyFor(event: KeyboardEvent): Shortcut | "consume" | undefined {
  // 日本語入力の変換中のキーは IME に任せる
  if (event.isComposing || event.key === "Process") {
    cancelPrefix();
    return;
  }
  if (!waiting) {
    // プレフィックスのあとのキーを押し続けても、ターミナルに文字を送らない
    if (event.repeat && event.code === lastCode) return "consume";
    lastCode = undefined;
    if (!isPrefix(event)) return;
    setWaiting(true);
    return "consume";
  }
  // Shift などを押しただけでは、待ち受けをやめない（% や " は Shift と一緒に押す）
  if (modifierKeys.has(event.key)) return;
  if (isPrefix(event)) {
    // プレフィックスを押し続けて繰り返し届いたものは、待ち受けたままにする
    if (event.repeat) return "consume";
    setWaiting(false);
    lastCode = event.code;
    return { type: "send-prefix" };
  }
  setWaiting(false);
  lastCode = event.code;
  if (event.ctrlKey || event.altKey || event.metaKey) return "consume";
  const key = prefixKeyOf(event);
  return bindings.find((b) => b.prefix === key)?.shortcut ?? "consume";
}

// 待ち受けていることを出す要素。待ち受けている間だけ出す
export function prefixIndicator() {
  const element = document.createElement("div");
  element.className = "prefix-indicator";
  element.setAttribute("role", "status");
  element.setAttribute("aria-label", "プレフィックスキー");
  const key = document.createElement("kbd");
  key.textContent = prefixName;
  element.append(key, " 次のキーを押してください（? で一覧、Esc でやめる）");
  element.hidden = true;
  listeners.add((value) => (element.hidden = !value));
  return element;
}

// 画面に出すキーの表記
function keysOf(binding: Binding) {
  return {
    prefix: binding.prefix === undefined ? "—" : (binding.prefixText ?? binding.prefix),
    mac: binding.key === undefined ? "—" : `⌘⇧${binding.key}`,
    other: binding.key === undefined ? "—" : `Ctrl+Shift+${binding.key}`,
  };
}

// ボタン・メニューのツールチップ（例: 右に分割（Ctrl+T → %））。プレフィックスのキーがない操作は、修飾キーの方式のキーを出す
// （例: サイドメニューを出す・隠す（⌘⇧S / Ctrl+Shift+S））。text はツールチップに出す操作の名前
export function withKeys(label: string, text = label) {
  const binding = bindings.find((b) => b.label === label);
  if (!binding) return text;
  const { prefix, mac, other } = keysOf(binding);
  if (binding.prefix !== undefined) return `${text}（${prefixName} → ${prefix}）`;
  return `${text}（${mac} / ${other}）`;
}

// ショートカットの一覧。ツールバーのボタンと、プレフィックスのあとの ? で開く
export function shortcutList() {
  const list = document.createElement("div");
  list.id = "shortcut-list";
  list.className = "shortcut-list";
  list.popover = "auto";
  // キーで開いたときに、キー入力の先を移せるようにする（Escape で閉じるため）
  list.tabIndex = -1;
  list.setAttribute("role", "dialog");
  list.setAttribute("aria-label", "キーボードショートカット");

  const heading = document.createElement("h2");
  heading.textContent = "キーボードショートカット";
  const note = document.createElement("p");
  note.textContent =
    `ターミナルにキー入力しているときに使えます。${prefixName} を押してから、次のキーを押します（tmux と同じ）。` +
    `Windows / Linux の Chrome では ${prefixName} がブラウザの新しいタブになるので、右の列のキーを使うか、Accompany をアプリとして開いてください`;
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const text of ["操作", `${prefixName} のあと`, "macOS", "Windows / Linux"]) {
    const th = document.createElement("th");
    th.textContent = text;
    head.append(th);
  }
  const body = table.createTBody();
  const addRow = (cells: string[]) => {
    const row = body.insertRow();
    for (const text of cells) row.insertCell().textContent = text;
  };
  for (const binding of bindings.filter((b, i) => bindings.findIndex((c) => c.label === b.label) === i)) {
    const { prefix, mac, other } = keysOf(binding);
    addRow([binding.label, prefix, mac, other]);
  }
  addRow([`${prefixName} をターミナルに送る`, prefixName, "—", "—"]);
  for (const { label, mac, other } of [...mouseActions, ...tabActions]) addRow([label, "—", mac, other]);
  list.append(heading, note, table);
  return list;
}
