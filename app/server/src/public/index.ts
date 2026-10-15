import { Pane, type Viewer } from "./pane";
import { shortcutList, withKeys, type Direction, type Shortcut } from "./shortcuts";

type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

type Tab = { id: string; name: string; layout: Layout };
type Tabs = { tabs: Tab[]; active: string };

const root = document.getElementById("workspace")!;
const tabBar = document.getElementById("tabs")!;
const panes = new Map<string, Pane>();
// 最後に届いたタブの並びと表示中のタブ。次／前のタブへの切り替えに使う
let current: Tabs | undefined;

// ショートカットの一覧。タブバーのボタンで開く
const shortcuts = shortcutList();
document.body.append(shortcuts);

// 参加者とそのフォーカス先。自分が誰かはサーバーが最初に教えてくれる
type Member = { id: number; name: string; color: string; terminal?: string };
let you: number | undefined;
let members: Member[] = [];
// ターミナルごとの、コマンドが設定したタイトル
let titles: Record<string, string> = {};

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws/workspace`);
const send = (message: object) => socket.send(JSON.stringify(message));

// タブの並びと表示中のタブ、分割の配置は参加者全員で共有する。サーバーから届くたびに組み直す。
// ただし境界をドラッグしている間は、組み直すとドラッグ中の境界がなくなるので、手を離すまで待つ
let dragging = false;
let deferredTabs: Tabs | undefined;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "welcome") {
    you = message.you;
  } else if (message.type === "presence") {
    members = message.members;
    showViewers();
  } else if (message.type === "titles") {
    titles = message.titles;
    showTitles();
  } else if (message.type === "tabs") {
    if (dragging) deferredTabs = message;
    else renderTabs(message);
  }
};

// 表示中のタブの配置だけを組み立てる。ほかのタブのターミナルは接続を切り、戻ったときにサーバーから画面を復元する
function renderTabs({ tabs, active }: Tabs) {
  current = { tabs, active };
  const tablist = document.createElement("div");
  tablist.className = "tab-list";
  tablist.setAttribute("role", "tablist");
  tablist.append(
    ...tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab";
      const select = button(tab.name, tab.name, () => send({ type: "select-tab", tab: tab.id }));
      select.className = "tab-select";
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === active));
      const close = button(`${tab.name} を閉じる`, "×", () => send({ type: "close-tab", tab: tab.id }));
      // 最後のタブは閉じられない
      close.disabled = tabs.length === 1;
      item.append(select, close);
      return item;
    }),
  );
  const help = button("キーボードショートカット", "⌨", () => {});
  help.popoverTargetElement = shortcuts;
  tabBar.replaceChildren(
    tablist,
    button("新しいタブ", "+", () => send({ type: "new-tab" }), withKeys("新しいタブ")),
    help,
  );

  const layout = tabs.find((t) => t.id === active)?.layout;
  if (layout) render(layout);
}

function button(label: string, text: string, onClick: () => void, title = label) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = title;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", onClick);
  return element;
}

function render(layout: Layout) {
  const ids = new Set(terminalIds(layout));
  // 要素を組み直すとキー入力の先が外れるので、あとで戻す。キー入力の先のターミナルが閉じたら、
  // 一番近いターミナルに移す（キーボードだけで操作を続けられるように）
  const active = document.activeElement;
  let lostFocus: DOMRect | undefined;
  for (const [id, pane] of panes) {
    if (!ids.has(id)) {
      if (pane.element.contains(document.activeElement)) lostFocus = pane.element.getBoundingClientRect();
      pane.dispose();
      panes.delete(id);
    }
  }
  const isFirstRender = panes.size === 0;
  const element = build(layout);
  // 分割の子だったときの割合が残らないよう、一番外側は画面いっぱいに広げる
  element.style.flex = "1 1 0";
  root.replaceChildren(element);
  panes.forEach((pane) => pane.setClosable(ids.size > 1));
  showViewers();
  showTitles();
  if (isFirstRender) panes.values().next().value?.focus();
  else if (lostFocus) nearestPane(lostFocus)?.focus();
  else if (active instanceof HTMLElement && active !== document.activeElement && root.contains(active)) active.focus();
}

function build(node: Layout): HTMLElement {
  if (node.type === "terminal") return paneFor(node.id).element;

  const split = document.createElement("div");
  split.className = `split split-${node.direction}`;
  const [first, second] = node.children.map(build);
  first.style.flex = `${node.ratio} 1 0`;
  second.style.flex = `${1 - node.ratio} 1 0`;
  split.append(first, divider(split, node, first, second), second);
  return split;
}

function paneFor(id: string) {
  let pane = panes.get(id);
  if (!pane) {
    pane = new Pane(id, {
      split: (direction) => send({ type: "split", terminal: id, direction }),
      close: () => send({ type: "close", terminal: id }),
      focused: () => send({ type: "focus", terminal: id }),
      shortcut: (shortcut) => runShortcut(id, shortcut),
    });
    panes.set(id, pane);
  }
  return pane;
}

// 境界をドラッグして割合を変える。手元ではすぐに反映し、サーバー経由で全員に配る
function divider(split: HTMLElement, node: Extract<Layout, { type: "split" }>, first: HTMLElement, second: HTMLElement) {
  const element = document.createElement("div");
  element.className = "divider";
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", node.direction === "row" ? "vertical" : "horizontal");
  element.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    element.setPointerCapture(down.pointerId);
    dragging = true;
    const move = (event: PointerEvent) => {
      const rect = split.getBoundingClientRect();
      const ratio =
        node.direction === "row"
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
      const clamped = Math.min(0.9, Math.max(0.1, ratio));
      first.style.flex = `${clamped} 1 0`;
      second.style.flex = `${1 - clamped} 1 0`;
      send({ type: "resize-split", split: node.id, ratio: clamped });
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      dragging = false;
      if (deferredTabs) renderTabs(deferredTabs);
      deferredTabs = undefined;
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
  });
  return element;
}

// キーボードショートカット（docs/adr/31-shortcuts.md）。terminal はキー入力の先のターミナル
function runShortcut(terminal: string, shortcut: Shortcut) {
  switch (shortcut.type) {
    case "split":
      return send({ type: "split", terminal, direction: shortcut.direction });
    case "close":
      return send({ type: "close", terminal });
    case "move-focus":
      return neighborOf(terminal, shortcut.direction)?.focus();
    case "new-tab":
      return send({ type: "new-tab" });
    case "next-tab":
    case "previous-tab": {
      if (!current) return;
      const { tabs, active } = current;
      const step = shortcut.type === "next-tab" ? 1 : -1;
      // 端では反対側に回る
      const index = (tabs.findIndex((t) => t.id === active) + step + tabs.length) % tabs.length;
      return send({ type: "select-tab", tab: tabs[index]!.id });
    }
  }
}

// その向きに隣り合うターミナルのうち、重なりが一番大きいもの（同じなら先に並んでいるもの）
function neighborOf(terminal: string, direction: Direction) {
  const from = panes.get(terminal)?.element.getBoundingClientRect();
  if (!from) return;
  // 境界の幅（4px）と枠の分だけ離れていても、隣り合っているものとみなす
  const gap = 8;
  let best: { pane: Pane; overlap: number } | undefined;
  for (const [id, pane] of panes) {
    if (id === terminal) continue;
    const to = pane.element.getBoundingClientRect();
    const adjacent = {
      left: Math.abs(from.left - to.right) <= gap,
      right: Math.abs(to.left - from.right) <= gap,
      up: Math.abs(from.top - to.bottom) <= gap,
      down: Math.abs(to.top - from.bottom) <= gap,
    }[direction];
    const overlap =
      direction === "left" || direction === "right"
        ? Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
        : Math.min(from.right, to.right) - Math.max(from.left, to.left);
    if (adjacent && overlap > 0 && (!best || overlap > best.overlap)) best = { pane, overlap };
  }
  return best?.pane;
}

// 中心どうしが一番近いターミナル
function nearestPane(rect: DOMRect) {
  const center = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;
  const [x, y] = center(rect);
  let best: { pane: Pane; distance: number } | undefined;
  for (const pane of panes.values()) {
    const [px, py] = center(pane.element.getBoundingClientRect());
    const distance = Math.hypot(px - x, py - y);
    if (!best || distance < best.distance) best = { pane, distance };
  }
  return best?.pane;
}

function showViewers() {
  for (const [id, pane] of panes) {
    const viewers: Viewer[] = members
      .filter((m) => m.terminal === id)
      .map((m) => ({ name: m.name, color: m.color, self: m.id === you }));
    pane.setViewers(viewers);
  }
}

function showTitles() {
  panes.forEach((pane, id) => pane.setTitle(titles[id] ?? ""));
}

function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
}
