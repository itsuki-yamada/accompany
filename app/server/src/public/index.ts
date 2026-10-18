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
// 分割した画面で、フォーカスしているターミナルが自分の枠に収まらないときは、そのターミナルをタブの表示領域いっぱいに
// 拡大して見せる。拡大は自分の画面だけの表示で、サーバーには伝えない（docs/adr/68-zoom.md）。
// focusedTerminal は自分がフォーカスしているターミナル、zoomOff は自分で拡大を外しているか、
// zoomed は拡大しているターミナル、placeholder は拡大中に分割での元の位置を取っておく要素
let focusedTerminal: string | undefined;
let zoomOff = false;
let zoomed: string | undefined;
let placeholder: HTMLElement | undefined;
// 分割した直後などは、自分の枠に合わせた大きさをサーバーに伝えてから端末の大きさが変わるまで、一瞬だけ枠に収まらない。
// そのたびに拡大して戻るとちらつくので、自動で拡大するのは、収まらない状態がこの時間続いたときにする
const zoomDelay = 300;
let zoomTimer: ReturnType<typeof setTimeout> | undefined;

// ショートカットの一覧。タブバーのボタンで開く
const shortcuts = shortcutList();
document.body.append(shortcuts);

// 配色とフォントの大きさは参加者ごと（docs/adr/36-appearance.md）。変えたら表示中の全ターミナルに反映する
let appearance: Appearance = loadAppearance();
const settings = appearanceSettings(appearance, (changed) => {
  appearance = changed;
  panes.forEach((pane) => pane.setAppearance(appearance));
  updateZoom();
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
// フォローしている参加者と、フォローで最後にフォーカスを移したターミナル。各参加者のブラウザだけの状態（docs/adr/69-follow.md）
let following: number | undefined;
let followed: string | undefined;
// フォロー中であることと、誰をフォローしているか。タブバーに出す
const followIndicator = document.createElement("div");
followIndicator.className = "follow-indicator";
followIndicator.setAttribute("role", "status");
followIndicator.setAttribute("aria-label", "フォロー");
followIndicator.hidden = true;

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
    showFollowing();
    followFocus();
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
    followIndicator,
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
  // 組み直すと元の位置の要素がなくなるので、拡大を置き直す。拡大中のターミナルが閉じられた・タブが切り替わった・
  // 分割が 1 つになったときは、拡大しない。拡大していたなら、待たずに置き直す（ちらつかないように）
  updateZoom(zoomed !== undefined);
  showViewers();
  showTitles();
  showStatuses();
  if (pendingFocus && panes.has(pendingFocus)) {
    focusPane(pendingFocus);
    pendingFocus = undefined;
  } else if (isFirstRender) panes.values().next().value?.focus();
  else if (lostFocus) nearestPane(lostFocus)?.focus();
  else if (active instanceof HTMLElement && active !== document.activeElement && root.contains(active)) active.focus();
  // フォローしている相手のフォーカス先が、配置より先に届いていたとき
  followFocus();
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
      zoom: () => toggleZoom(id),
      resized: () => updateZoom(),
      focused: () => {
        focusedTerminal = id;
        updateZoom();
        send({ type: "focus", terminal: id });
      },
      shortcut: (shortcut) => runShortcut(id, shortcut),
      commands: () => quickCommands.list,
      manageCommands: () => quickCommands.open(),
      follow: (member) => (following === member ? stopFollowing() : startFollowing(member)),
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
      return send({ type: "split", terminal, direction: shortcut.direction });
    case "close":
      return send({ type: "close", terminal });
    case "zoom":
      return toggleZoom(terminal);
    case "move-focus": {
      // 拡大中も、隠れているターミナルへ移れる。移った先が枠に収まらなければ、そのターミナルを拡大する
      const next = neighborOf(terminal, shortcut.direction);
      if (next) {
        stopFollowing();
        focusPane(next);
      }
      return;
    }
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

// 自分で拡大を外す／戻す。拡大しているターミナルなら外し、そうでなければ拡大に戻す（枠に収まらなければ拡大する）。
// 外した状態は、もう一度切り替えるまで続く（フォーカスを移しても拡大しない）
function toggleZoom(terminal: string) {
  zoomOff = zoomed === terminal;
  focusPane(terminal);
}

// キー入力の先をそのターミナルに移す。隠れているターミナルはフォーカスを受け取れないので、先に拡大を決め直す
function focusPane(terminal: string) {
  focusedTerminal = terminal;
  updateZoom(true);
  panes.get(terminal)?.focus();
}

// 拡大するターミナルを決め直す。変わったときだけ画面を組み替える。immediate は、フォーカスを移したときや
// 自分で切り替えたときのように、すぐに決める（隠れているターミナルはフォーカスを受け取れないので、待たない）
function updateZoom(immediate = false) {
  // 配置を組み直して元の位置の要素がなくなったときは、いったん分割の表示に戻してから、収まるかを測り直す
  if (zoomed !== undefined && !placeholder?.isConnected) {
    zoomed = undefined;
    showZoom();
  }
  const focused = focusedTerminal === undefined ? undefined : panes.get(focusedTerminal);
  const target = !zoomOff && panes.size > 1 && focused?.overflows() ? focusedTerminal : undefined;
  if (target !== undefined && target !== zoomed && !immediate) {
    zoomTimer ??= setTimeout(() => {
      zoomTimer = undefined;
      updateZoom(true);
    }, zoomDelay);
    showZoomState();
    return;
  }
  clearTimeout(zoomTimer);
  zoomTimer = undefined;
  if (target !== zoomed) {
    zoomed = target;
    showZoom();
  } else showZoomState();
}

// 拡大中のターミナルを、CSS でタブの表示領域いっぱいに重ねて出す。分割での元の位置には同じ大きさの要素を置き、
// ほかのターミナルと境界は見えなくするだけで、配置・接続・xterm はそのまま残す（作り直すと、画面の復元と描き直しが起きる）
function showZoom() {
  placeholder?.remove();
  placeholder = undefined;
  root.toggleAttribute("data-zoomed", zoomed !== undefined);
  for (const [id, pane] of panes) pane.element.toggleAttribute("data-zoomed", id === zoomed);
  const element = zoomed === undefined ? undefined : panes.get(zoomed)?.element;
  if (element) {
    placeholder = document.createElement("div");
    placeholder.className = "zoom-placeholder";
    placeholder.style.flex = element.style.flex;
    element.after(placeholder);
  }
  showZoomState();
}

// 各ターミナルのバーに、拡大の状態（拡大中・外している・切り替えられるか）を出す
function showZoomState() {
  for (const [id, pane] of panes) {
    pane.setZoom({
      placeholder: id === zoomed ? placeholder : undefined,
      hidden: panes.size - 1,
      off: zoomOff && id === focusedTerminal,
    });
  }
}

// その向きに隣り合うターミナルのうち、重なりが一番大きいもの（同じなら先に並んでいるもの）
// 拡大中は、元の分割の配置（元の位置に置いた要素）で向きを決める
function neighborOf(terminal: string, direction: Direction) {
  const from = (terminal === zoomed ? placeholder : panes.get(terminal)?.element)?.getBoundingClientRect();
  if (!from) return;
  // 境界の幅（4px）と枠の分だけ離れていても、隣り合っているものとみなす
  const gap = 8;
  let best: { id: string; overlap: number } | undefined;
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
    if (adjacent && overlap > 0 && (!best || overlap > best.overlap)) best = { id, overlap };
  }
  return best?.id;
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
      .map((m) => ({ id: m.id, name: m.name, color: m.color, self: m.id === you, following: m.id === following }));
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
  stopFollowing();
  const pane = panes.get(id);
  if (pane) return focusPane(id);
  const tab = current?.tabs.find((t) => terminalIds(t.layout).includes(id));
  if (!tab) return;
  pendingFocus = id;
  send({ type: "select-tab", tab: tab.id });
}

// フォローする。相手がいまフォーカスしているターミナルに、すぐ自分のフォーカスも移す
function startFollowing(member: number) {
  following = member;
  followed = undefined;
  showFollowing();
  followFocus();
}

function stopFollowing() {
  if (following === undefined) return;
  following = undefined;
  followed = undefined;
  showFollowing();
}

// フォロー中の表示を更新する。フォローしている相手が抜けていたら、フォローをやめる
function showFollowing() {
  const member = members.find((m) => m.id === following);
  if (!member) following = followed = undefined;
  followIndicator.hidden = !member;
  if (member) {
    const label = document.createElement("span");
    label.textContent = `${member.name} をフォロー中`;
    followIndicator.style.setProperty("--follow-color", member.color);
    followIndicator.replaceChildren(label, button("フォローをやめる", "×", stopFollowing));
    root.dataset.following = "true";
    root.style.setProperty("--follow-color", member.color);
  } else {
    followIndicator.replaceChildren();
    delete root.dataset.following;
  }
  showViewers();
}

// フォローしている相手のフォーカス先が変わったら、自分のフォーカスも移す。移したことは、ふだんどおり focus として
// サーバーに伝わる。相手のフォーカス先が表示中のタブにないとき（タブの切り替えと行き違ったときなど）は、
// 配置が届いて組み立てたときに移す。タブの切り替えは全員で共有しているので、フォローのためには切り替えない
function followFocus() {
  const target = members.find((m) => m.id === following)?.terminal;
  if (!target || target === followed) return;
  const pane = panes.get(target);
  if (!pane) return;
  followed = target;
  pane.focus();
}

// 自分で相手と別のターミナルをクリックしたら、フォローをやめる。バーのボタン（フォローのボタンなど）は除く
root.addEventListener(
  "pointerdown",
  (event) => {
    if (following === undefined || event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest(".pane-bar")) return;
    const target = members.find((m) => m.id === following)?.terminal;
    for (const [id, pane] of panes) {
      if (id !== target && pane.element.contains(event.target)) return stopFollowing();
    }
  },
  { capture: true },
);

function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
}
