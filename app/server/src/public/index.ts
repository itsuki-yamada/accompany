import { appearanceSettings, loadAppearance, type Appearance } from "./appearance";
import { notifyDone, requestPermissionOnFirstInteraction } from "./notify";
import { Pane, type AgentStatus, type Viewer } from "./pane";
import { QuickCommands } from "./quick-commands";
import { shortcutList, withKeys, type Direction, type Shortcut } from "./shortcuts";

type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

type Tab = { id: string; name: string; layout: Layout };
type Tabs = { tabs: Tab[]; active: string };

const root = document.getElementById("workspace")!;
const tabBar = document.getElementById("tabs")!;
const panes = new Map<string, Pane>();
// 最後に届いたタブの並びと表示中のタブ。次／前のタブへの切り替えや、通知をクリックしたときにそのターミナルのタブを探すのに使う
let current: Tabs | undefined;
// 自分の画面だけで拡大表示しているターミナル。サーバーには伝えない（docs/adr/68-zoom.md）
let zoomed: string | undefined;

// ショートカットの一覧。タブバーのボタンで開く
const shortcuts = shortcutList();
document.body.append(shortcuts);

// 配色とフォントの大きさは参加者ごと（docs/adr/36-appearance.md）。変えたら表示中の全ターミナルに反映する
let appearance: Appearance = loadAppearance();
const settings = appearanceSettings(appearance, (changed) => {
  appearance = changed;
  panes.forEach((pane) => pane.setAppearance(appearance));
});
document.body.append(settings);

// 参加者とそのフォーカス先。自分が誰かはサーバーが最初に教えてくれる
type Member = { id: number; name: string; color: string; terminal?: string };
let you: number | undefined;
let members: Member[] = [];
// ターミナルごとの、コマンドが設定したタイトル
let titles: Record<string, string> = {};
// ターミナルごとのエージェントの状態。サーバーが判定して全員に配る
let statuses: Record<string, AgentStatus> = {};

requestPermissionOnFirstInteraction();

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws/workspace`);
const send = (message: object) => socket.send(JSON.stringify(message));
// よく使うコマンドの一覧と、その登録・編集・削除の画面
const quickCommands = new QuickCommands(send);

// タブの並びと表示中のタブ、分割の配置は参加者全員で共有する。サーバーから届くたびに組み直す。
// ただし境界をドラッグしている間は、組み直すとドラッグ中の境界がなくなるので、手を離すまで待つ
let dragging = false;
let deferredTabs: Tabs | undefined;
// タブを切り替えたあと、組み立て直したらフォーカスするターミナル
let pendingFocus: string | undefined;
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
  } else if (message.type === "status") {
    notifyFinished(statuses, message.statuses);
    statuses = message.statuses;
    showStatuses();
  } else if (message.type === "commands") {
    quickCommands.set(message.commands);
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
  const appearanceButton = button("表示の設定", "⚙", () => {});
  appearanceButton.popoverTargetElement = settings;
  tabBar.replaceChildren(
    tablist,
    button("新しいタブ", "+", () => send({ type: "new-tab" }), withKeys("新しいタブ")),
    help,
    appearanceButton,
  );

  const layout = tabs.find((t) => t.id === active)?.layout;
  // 通知のクリックで切り替えを頼んだあと、ほかの人が別のタブに切り替えたときは、フォーカスする予定を取り消す
  if (pendingFocus && !(layout && terminalIds(layout).includes(pendingFocus))) pendingFocus = undefined;
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
  // 拡大中のターミナルが閉じられた・タブが切り替わった・分割が 1 つになったときは、拡大を解除する
  if (zoomed && (!ids.has(zoomed) || ids.size < 2)) zoomed = undefined;
  showZoom();
  showViewers();
  showTitles();
  showStatuses();
  if (pendingFocus && panes.has(pendingFocus)) {
    panes.get(pendingFocus)!.focus();
    pendingFocus = undefined;
  } else if (isFirstRender) panes.values().next().value?.focus();
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
      split: (direction) => split(id, direction),
      close: () => send({ type: "close", terminal: id }),
      zoom: () => toggleZoom(id),
      focused: () => send({ type: "focus", terminal: id }),
      shortcut: (shortcut) => runShortcut(id, shortcut),
      commands: () => quickCommands.list,
      manageCommands: () => quickCommands.open(),
    }, appearance);
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
      return split(terminal, shortcut.direction);
    case "close":
      return send({ type: "close", terminal });
    case "zoom":
      return toggleZoom(terminal);
    case "move-focus":
      // 拡大中は隣のターミナルが隠れているので、解除してから移る（tmux と同じ）
      setZoom(undefined);
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

// 分割で増えたターミナルが隠れないよう、拡大中なら解除してから分割する（tmux と同じ）
function split(terminal: string, direction: "row" | "column") {
  setZoom(undefined);
  send({ type: "split", terminal, direction });
}

// 拡大表示を切り替える。分割していなければ何もしない。キー入力の先は、切り替えたターミナルに置く
function toggleZoom(terminal: string) {
  if (zoomed === terminal) setZoom(undefined);
  else if (panes.size > 1) setZoom(terminal);
  panes.get(terminal)?.focus();
}

function setZoom(terminal: string | undefined) {
  if (zoomed === terminal) return;
  zoomed = terminal;
  showZoom();
}

// 拡大中は、そのターミナルだけをタブの表示領域いっぱいに出す。ほかのターミナルは CSS で隠すだけで、
// 接続と xterm はそのまま残す（作り直すと、画面の復元と描き直しが起きる）
function showZoom() {
  root.toggleAttribute("data-zoomed", zoomed !== undefined);
  for (const [id, pane] of panes) {
    pane.element.toggleAttribute("data-zoomed", id === zoomed);
    pane.setZoom(id === zoomed, panes.size - 1);
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

function showStatuses() {
  for (const [id, pane] of panes) pane.setStatus(statuses[id] ?? "idle");
}

// 作業中から入力待ちに変わったターミナルを、見ていなければ通知する。
// 見ている = ページが見えていて、そのターミナルが表示中のタブにあり、自分がそのターミナルにフォーカスしている
function notifyFinished(previous: Record<string, AgentStatus>, next: Record<string, AgentStatus>) {
  const focused = members.find((m) => m.id === you)?.terminal;
  for (const [id, status] of Object.entries(next)) {
    if (previous[id] !== "working" || status !== "idle") continue;
    if (!document.hidden && panes.has(id) && focused === id) continue;
    notifyDone(`ターミナル ${id}: 入力待ち`, () => focusTerminal(id));
  }
}

// ほかのタブのターミナルなら、そのタブに切り替えてからフォーカスする
function focusTerminal(id: string) {
  const pane = panes.get(id);
  if (pane) {
    if (zoomed !== id) setZoom(undefined);
    return pane.focus();
  }
  const tab = current?.tabs.find((t) => terminalIds(t.layout).includes(id));
  if (!tab) return;
  pendingFocus = id;
  send({ type: "select-tab", tab: tab.id });
}

function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
}
