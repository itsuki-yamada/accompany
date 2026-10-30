import { appearanceSettings, loadAppearance, type Appearance } from "./appearance";
import { showContextMenu, type MenuItem } from "./context-menu";
import { finishLoading, showDisconnected } from "./loading";
import { NameSettings } from "./member-name";
import { MinWindowSettings } from "./min-window";
import { notifyDone, requestPermissionOnFirstInteraction } from "./notify";
import { Pane, type AgentStatus, type SelectionRange, type Viewer } from "./pane";
import { QuickCommands } from "./quick-commands";
import { prefixIndicator, shortcutList, withKeys, type Direction, type Shortcut } from "./shortcuts";
import { Sidebar, type Group, type Tab } from "./sidebar";
import { entriesOf } from "./split-view";
import { isEditingTabName } from "./tab-name";

// 自分の表示。並べているタブ（ターミナル 1 つが 1 つのタブ）を葉に持つ分割の木。どのタブをどう並べるかは参加者ごとで、
// サーバーが持って本人に配る（docs/adr/100-terminal-tabs.md）
type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };
type Split = Extract<Layout, { type: "split" }>;

// 並べられるタブの数（サーバーと同じ）
const maxPanes = 3;

const root = document.getElementById("workspace")!;
const tabBar = document.getElementById("tabs")!;
const panes = new Map<string, Pane>();
// 最後に届いたタブの並び。次／前のタブへの切り替えに使う
let tabs: Tab[] = [];
// 最後に届いたタブのグループ（docs/adr/209-tab-groups.md）
let groups: Group[] = [];
// 最後に届いた自分の表示
let view: Layout | undefined;
// 自分の、いまは出していない分割。分割のタブを選ぶと、サーバーがそのまま（並び・向き・割合）出す（docs/adr/215-split-view.md）
let parked: Layout[] = [];
// 自分がフォーカスしているターミナル
let focusedTerminal: string | undefined;

// ショートカットの一覧。ツールバーのボタンで開く
const shortcuts = shortcutList();
document.body.append(shortcuts);
// キーで一覧を開いたときのターミナル。閉じたら、そこにキー入力の先を戻す
let shortcutsOpenedFrom: string | undefined;
shortcuts.addEventListener("toggle", (event) => {
  if ((event as ToggleEvent).newState !== "closed") return;
  const from = shortcutsOpenedFrom;
  shortcutsOpenedFrom = undefined;
  if (from && (document.activeElement === document.body || shortcuts.contains(document.activeElement))) focusPane(from);
});
// プレフィックス（Ctrl+T）を押して、次のキーを待ち受けていることの表示（docs/adr/177-prefix-keys.md）
document.body.append(prefixIndicator());

// 配色とフォントの大きさは参加者ごと（docs/adr/36-appearance.md）。変えたら表示中の全ターミナルに反映する
let appearance: Appearance = loadAppearance();
// 端末の大きさの下限は参加者全員の設定で、サーバーが持って全員に配る（docs/adr/99-smallest-size.md）
const minWindow = new MinWindowSettings((size) => send({ type: "set-min-window", ...size }));
// 自分の名前。ほかの参加者の画面に出る（docs/adr/96-member-name.md）
const nameSettings = new NameSettings((name) => send({ type: "name", name }));
const settings = appearanceSettings(
  appearance,
  (changed) => {
    appearance = changed;
    panes.forEach((pane) => pane.setAppearance(appearance));
  },
  [nameSettings.element, minWindow.element],
);
document.body.append(settings);

// 参加者とそのフォーカス先、ターミナルごとの選択範囲、ペアプロモードで追従している相手、スクロール位置。
// 自分が誰かはサーバーが最初に教えてくれる
type Member = {
  id: number;
  name: string;
  color: string;
  terminal?: string;
  selections: Record<string, SelectionRange>;
  following?: number;
  scroll?: { terminal: string; offset: number };
};
let you: number | undefined;
let members: Member[] = [];
// ターミナルごとの、コマンドが設定したタイトル
let titles: Record<string, string> = {};
// ターミナルごとのエージェントの状態。サーバーが判定して全員に配る。エージェントが動いていないターミナルは含まない
let statuses: Record<string, AgentStatus> = {};
// ペアプロモードで追従している参加者。自分のブラウザで決め、サーバーにも伝えて、追従されている側に知らせる
// （docs/adr/93-pair-mode.md）
let following: number | undefined;
// 自分でスクロールして、スクロールの追従を止めているときの、相手のフォーカス先のターミナル。
// 相手が別のターミナルに移ったら、また追従する
let scrollPausedOn: string | undefined;
// ペアプロモードであることと、誰に追従しているか。ツールバーに出す。参加者の情報が届くたびに作り直すと、
// 「ペアプロをやめる」のボタンを押している途中やキーボードフォーカスが失われるので、同じ要素を使い回す
const followIndicator = document.createElement("div");
followIndicator.className = "pair-indicator";
followIndicator.setAttribute("role", "status");
followIndicator.setAttribute("aria-label", "ペアプロモード");
followIndicator.hidden = true;
const followMode = document.createElement("strong");
followMode.textContent = "ペアプロモード";
const followLabel = document.createElement("span");
// スクロールの追従を止めていることと、戻すボタン。止めていないときは中身を空にする（読み上げや文字の検索に残さないため）
const scrollPaused = document.createElement("span");
scrollPaused.className = "pair-paused";
const resumeScroll = button("相手のスクロール位置に戻る", "位置を戻す", () => {
  scrollPausedOn = undefined;
  showFollowing();
  followScroll();
});
const scrollPausedLabel = document.createElement("span");
scrollPausedLabel.textContent = "スクロールは追従していません";
followIndicator.append(followMode, followLabel, scrollPaused, button("ペアプロをやめる", "やめる ×", () => stopFollowing()));
// 自分の画面に追従している参加者。追従されている側に出す
const followedIndicator = document.createElement("div");
followedIndicator.className = "followed-indicator";
followedIndicator.setAttribute("role", "status");
followedIndicator.setAttribute("aria-label", "あなたに追従している参加者");
followedIndicator.hidden = true;
// ツールバーの参加者の一覧。ほかの参加者の名前は、押すとその人とペアプロするボタン
const memberList = document.createElement("span");
memberList.className = "toolbar-members";
memberList.setAttribute("role", "group");
memberList.setAttribute("aria-label", "参加者");
let memberListKey = "";
// 自分に追従している参加者がいるか。いるあいだだけ、自分のスクロール位置をサーバーに伝える
let followed = false;

requestPermissionOnFirstInteraction();

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws/workspace`);
const send = (message: object) => socket.send(JSON.stringify(message));
// ページが見えているかをサーバーに伝える。見えていて、表示中のターミナルにフォーカスしていれば、そのターミナルの未確認が消える
// （docs/adr/74-unseen-done.md）
const sendVisibility = () => {
  if (socket.readyState === WebSocket.OPEN) send({ type: "visibility", visible: !document.hidden });
};
socket.addEventListener("open", sendVisibility);
// サーバーが止まったり、ネットワークが切れたりしたとき
socket.addEventListener("close", showDisconnected);
// 保存した名前があれば、つないだときに伝える
socket.addEventListener("open", () => {
  if (nameSettings.current) send({ type: "name", name: nameSettings.current });
});
document.addEventListener("visibilitychange", sendVisibility);
// よく使うコマンドの一覧と、その登録・編集・削除の画面
const quickCommands = new QuickCommands(send);
// サイドメニュー（タブの一覧）
const sidebar = new Sidebar(document.getElementById("sidebar")!, {
  selectTab: (id) => selectTab(id),
  toggleTab: (id) => toggleTab(id),
  splitItems: (id) => splitMenuItems(id),
  newTab: () => {
    stopFollowing();
    send({ type: "new-tab" });
  },
  closeTab: (id) => send({ type: "close", terminal: id }),
  // 並び順は全員で共有し、参加者ごとの表示は変えないので、ペアプロモードはやめない（docs/adr/139-tab-order.md）
  // 分割したタブは、まとめて移す（docs/adr/215-split-view.md）
  moveTab: (ids, index, group) => send({ type: "move-tab", tabs: ids, index, ...(group !== undefined && { group }) }),
  // タブのグループも全員で共有し、参加者ごとの表示は変えないので、ペアプロモードはやめない（docs/adr/209-tab-groups.md）
  newGroup: (ids) => send({ type: "new-group", tabs: ids }),
  addToGroup: (ids, group) => send({ type: "add-to-group", tabs: ids, group }),
  removeFromGroup: (ids) => send({ type: "remove-from-group", tabs: ids }),
  moveGroup: (group, index) => send({ type: "move-group", group, index }),
  renameGroup: (group, name) => send({ type: "rename-group", group, name }),
  recolorGroup: (group, color) => send({ type: "recolor-group", group, color }),
  ungroup: (group) => send({ type: "ungroup", group }),
  closeGroup: (group) => send({ type: "close-group", group }),
  // 名前は全員で共有する。整えるのはサーバー（docs/adr/110-tab-name.md）
  renameTab: (id, name) => send({ type: "rename-tab", tab: id, name }),
  returnFocus: () => {
    const mine = members.find((m) => m.id === you)?.terminal;
    ((mine && panes.get(mine)) || panes.values().next().value)?.focus();
  },
});

// ツールバー。サイドメニューの出す・隠す、サイドメニューを隠している間のタブの一覧、ペアプロモードの表示、参加者の一覧、
// ショートカットの一覧と表示の設定のボタンを置く
{
  const help = button("キーボードショートカット", "⌨", () => {});
  help.popoverTargetElement = shortcuts;
  const appearanceButton = button("表示の設定", "⚙", () => {});
  appearanceButton.popoverTargetElement = settings;
  const spacer = document.createElement("span");
  spacer.className = "toolbar-spacer";
  // タブの右の空いている所に、タブ・グループを落とすと最後へ移す（docs/adr/209-tab-groups.md）
  sidebar.enableDropAtEnd(spacer);
  tabBar.append(
    sidebar.toggleButton,
    sidebar.strip,
    followIndicator,
    followedIndicator,
    spacer,
    memberList,
    help,
    appearanceButton,
  );
}

// 自分の表示は、サーバーから届くたびに組み直す。
// ただし境界をドラッグしている間は、組み直すとドラッグ中の境界がなくなるので、手を離すまで待つ
let dragging = false;
let deferredView: Layout | undefined;
// タブを選んだあと、組み立て直したらフォーカスするターミナル
let pendingFocus: string | undefined;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "welcome") {
    you = message.you;
    nameSettings.setDefault(`参加者 ${you}`);
  } else if (message.type === "presence") {
    members = message.members;
    showSelections();
    showFollowing();
    showFollowed();
    showMemberList();
    followFocus();
    followScroll();
  } else if (message.type === "titles") {
    titles = message.titles;
    showTitles();
  } else if (message.type === "status") {
    notifyFinished(statuses, message.statuses);
    statuses = message.statuses;
    showStatuses();
  } else if (message.type === "commands") {
    quickCommands.set(message.commands);
  } else if (message.type === "min-window") {
    minWindow.set({ width: message.width, height: message.height });
    panes.forEach((pane) => pane.refit());
  } else if (message.type === "tabs") {
    tabs = message.tabs;
    groups = message.groups ?? [];
    panes.forEach((pane) => pane.setClosable(tabs.length > 1));
    showTabNames();
  } else if (message.type === "view") {
    parked = message.splits ?? [];
    if (dragging) deferredView = message.layout;
    else renderView(message.layout);
  }
  if (view) sidebar.update({ tabs, groups, shown: terminalIds(view), maxShown: maxPanes, splits: splitIds(), titles, statuses, members, you });
};

// 自分の分割（いま出しているものと、しまってあるもの）のタブ。それぞれ、分割の中の並び（左から・上から）
function splitIds() {
  return [...(view?.type === "split" ? [view] : []), ...parked].map(terminalIds);
}

// ターミナルごとの、自分が最後にフォーカスした順番（大きいほど新しい）。分割の項目へ移るときに、どのターミナルにフォーカスするかに使う
const focusOrder = new Map<string, number>();
let focusCount = 0;

// タブの一覧の項目（自分の分割は 1 つの項目）ごとの、選ぶタブ。分割なら、分割で最後にフォーカスしていたタブ（なければ先頭）。
// 次・前のタブと、その番目のタブへの切り替えに使う。分割は 1 つの項目として飛ばす（Chrome と同じ。docs/adr/215-split-view.md）
function listedEntries() {
  return entriesOf(tabs, splitIds()).map((entry) => ({
    ids: entry.tabs.map((t) => t.id),
    pick: entry.tabs.reduce((best, t) => ((focusOrder.get(t.id) ?? 0) > (focusOrder.get(best.id) ?? 0) ? t : best)).id,
  }));
}

// 自分の表示に並べているタブだけを組み立てる。ほかのタブのターミナルは接続を切り、戻ったときにサーバーから画面を復元する
function renderView(layout: Layout) {
  view = layout;
  // タブを選んだあと、届いた表示にそのタブがなければ（そのタブが閉じられたなど）、フォーカスする予定を取り消す
  if (pendingFocus && !terminalIds(layout).includes(pendingFocus)) pendingFocus = undefined;
  render(layout);
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
  // 最後のタブは閉じられない。並べられる数まで並べていれば、分割できない
  panes.forEach((pane) => {
    pane.setClosable(tabs.length > 1);
    pane.setSplittable(ids.size < maxPanes, maxPanes);
  });
  showViewers();
  showSelections();
  showTabNames();
  showTitles();
  showStatuses();
  if (pendingFocus && panes.has(pendingFocus)) {
    // タブをダブルクリックして名前を付け始めたときは、そのタブに切り替わっても、入力欄からキー入力の先を奪わない
    if (!isEditingTabName()) focusPane(pendingFocus);
    pendingFocus = undefined;
  } else if (isFirstRender) panes.values().next().value?.focus();
  else if (lostFocus) nearestPane(lostFocus)?.focus();
  else if (active instanceof HTMLElement && active !== document.activeElement && root.contains(active)) active.focus();
  // 追従している相手のフォーカス先が、表示より先に届いていたとき
  followFocus();
  followScroll();
  finishLoadingIfReady();
}

// 自分の表示が届き、表示中のターミナルすべての最初の画面を書き終えたら、読み込み中の表示を消す
function finishLoadingIfReady() {
  if (view && [...panes.values()].every((pane) => pane.loaded)) finishLoading();
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
      split: (direction) => splitPane(id, direction),
      swap: (from) => swapPanes(from, id),
      arrangeItems: () => arrangeItems(id),
      close: () => send({ type: "close", terminal: id }),
      focused: () => {
        focusedTerminal = id;
        focusOrder.set(id, ++focusCount);
        send({ type: "focus", terminal: id });
        sendScroll();
      },
      shortcut: (shortcut) => runShortcut(id, shortcut),
      rename: (name) => send({ type: "rename-tab", tab: id, name }),
      commands: () => quickCommands.list,
      minWindow: () => minWindow.current,
      loaded: finishLoadingIfReady,
      manageCommands: () => quickCommands.open(),
      follow: (member) => (following === member ? stopFollowing() : startFollowing(member)),
      selected: (range) => send({ type: "select", terminal: id, ...range }),
      scrolled: (user) => {
        if (id === focusedTerminal) queueScroll();
        // 追従している相手のターミナルを自分でスクロールして、相手と違う位置になったら、ペアプロモードのまま、
        // スクロールの追従だけを止める。一番下でホイールを回して動かないまま出力が流れたときなど、相手と同じ位置なら止めない
        const leader = members.find((m) => m.id === following);
        const target = leader?.terminal;
        const leaderOffset = leader?.scroll?.terminal === target ? leader?.scroll?.offset : undefined;
        if (user && id === target && scrollPausedOn !== target && panes.get(id)?.scrollOffset() !== (leaderOffset ?? 0)) {
          scrollPausedOn = target;
          showFollowing();
        }
      },
    }, appearance);
    panes.set(id, pane);
  }
  return pane;
}

// 境界をドラッグして割合を変える。手元ではすぐに反映し、サーバーに伝える（自分の表示と、自分に追従している人の表示に効く）。
// 実際に割合を変えたら、自分で表示を変えたので、ペアプロモードはやめる（押しただけではやめない）
function divider(split: HTMLElement, node: Split, first: HTMLElement, second: HTMLElement) {
  const element = document.createElement("div");
  element.className = "divider";
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", node.direction === "row" ? "vertical" : "horizontal");
  // 境界を右クリックできることは気づきにくいので、ツールチップで知らせる
  element.title = "ドラッグで大きさを変える。右クリックで入れ替え・向きの変更";
  // 右クリックでは、この境界の分割を入れ替えたり、向きを変えたりするメニューを出す（docs/adr/163-rearrange-panes.md）
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // メニューを閉じたら、自分がフォーカスしていたターミナルにキー入力の先を戻す
    showContextMenu(event.clientX, event.clientY, "境界のメニュー", splitItems(node), () => {
      if (focusedTerminal) focusPane(focusedTerminal);
    });
  });
  element.addEventListener("pointerdown", (down) => {
    // 右クリックではドラッグを始めない
    if (down.button !== 0) return;
    down.preventDefault();
    element.setPointerCapture(down.pointerId);
    dragging = true;
    let ratio = node.ratio;
    const move = (event: PointerEvent) => {
      const rect = split.getBoundingClientRect();
      const moved =
        node.direction === "row"
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
      const clamped = Math.min(0.9, Math.max(0.1, moved));
      if (clamped === ratio) return;
      ratio = clamped;
      stopFollowing();
      first.style.flex = `${clamped} 1 0`;
      second.style.flex = `${1 - clamped} 1 0`;
      send({ type: "resize-split", split: node.id, ratio: clamped });
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      dragging = false;
      if (deferredView) renderView(deferredView);
      deferredView = undefined;
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
  });
  return element;
}

// キーボードショートカット（docs/adr/31-shortcuts.md、docs/adr/177-prefix-keys.md）。terminal はキー入力の先のターミナル。
// このターミナルで済む操作（Ctrl+T を送る、直前の出力のコピー、名前の変更）は Pane が行う
function runShortcut(terminal: string, shortcut: Shortcut) {
  const shown = view ? terminalIds(view) : [];
  // 並べている順で、step だけ先のターミナル（端では反対側に回る）
  const along = (step: number) => shown[(shown.indexOf(terminal) + step + shown.length) % shown.length];
  switch (shortcut.type) {
    case "split":
      return splitPane(terminal, shortcut.direction);
    case "close":
      return send({ type: "close", terminal });
    case "move-focus": {
      const next = neighborOf(terminal, shortcut.direction);
      if (next) {
        stopFollowing();
        focusPane(next);
      }
      return;
    }
    case "new-tab":
      // 新しいタブは、キー入力の先のターミナルのカレントディレクトリで始める（docs/adr/109-inherit-cwd.md）
      stopFollowing();
      return send({ type: "new-tab", terminal });
    case "next-tab":
    case "previous-tab": {
      const listed = listedEntries();
      if (listed.length === 0) return;
      const step = shortcut.type === "next-tab" ? 1 : -1;
      // 一覧でキー入力の先のタブの項目の、次・前の項目を選ぶ（分割なら分割を出す）。端では反対側に回る
      const index = (listed.findIndex((e) => e.ids.includes(terminal)) + step + listed.length) % listed.length;
      return selectTab(listed[index]!.pick);
    }
    case "select-tab": {
      const entry = listedEntries()[shortcut.index];
      return entry && selectTab(entry.pick);
    }
    case "next-pane": {
      const next = along(1);
      if (next && next !== terminal) {
        stopFollowing();
        focusPane(next);
      }
      return;
    }
    case "swap-pane": {
      const other = along(shortcut.step);
      return other && swapPanes(terminal, other);
    }
    case "rotate-split": {
      const parent = view && parentSplit(view, terminal);
      return parent && rotateSplit(parent.id);
    }
    case "show-shortcuts":
      // ターミナルは Escape を受け取ると既定の動作を止めるので、一覧にキー入力の先を移して Escape で閉じられるようにする
      shortcutsOpenedFrom = terminal;
      shortcuts.showPopover();
      return shortcuts.focus();
    case "toggle-sidebar":
      return sidebar.toggle();
    case "focus-sidebar":
      return sidebar.focus();
  }
}

// 新しいタブを開いて、そのターミナルの右・下に並べる。並べられる数まで並べていれば何もしない。
// 自分で表示を変えるので、ペアプロモードはやめる
function splitPane(terminal: string, direction: "row" | "column") {
  if (!view || terminalIds(view).length >= maxPanes) return;
  stopFollowing();
  send({ type: "split", terminal, direction });
}

// 並べている 2 つのタブの位置を入れ替える。自分で表示を変えるので、ペアプロモードはやめる（docs/adr/163-rearrange-panes.md）
function swapPanes(tab: string, other: string) {
  if (tab === other) return;
  stopFollowing();
  send({ type: "swap-panes", tab, with: other });
}

// 分割の 2 つの子（左右・上下）を入れ替える
function flipSplit(split: string) {
  stopFollowing();
  send({ type: "flip-split", split });
}

// 分割の向き（左右 ⇄ 上下）を変える
function rotateSplit(split: string) {
  stopFollowing();
  send({ type: "rotate-split", split });
}

// ターミナルの右クリックのメニューの、並べ方を変える項目。左右・上下の入れ替えは、そのターミナルを含む一番内側の、
// その向きの分割に効く。向きの変更は、そのターミナルを含む一番内側の分割に効く。1 つだけ表示しているときは出さない
// （そのときのメニューは、並べる前と同じにする）
function arrangeItems(terminal: string): MenuItem[] {
  const row = view && enclosingSplit(view, terminal, "row");
  const column = view && enclosingSplit(view, terminal, "column");
  const parent = view && parentSplit(view, terminal);
  if (!parent) return [];
  return [
    { label: "左右を入れ替える", disabled: !row, action: () => row && flipSplit(row.id) },
    { label: "上下を入れ替える", disabled: !column, action: () => column && flipSplit(column.id) },
    {
      label: parent.direction === "column" ? "左右に並べる" : "上下に並べる",
      title: withKeys("分割の向きを変える", parent.direction === "column" ? "左右に並べる" : "上下に並べる"),
      action: () => rotateSplit(parent.id),
    },
    "separator",
  ];
}

// 境界の右クリックのメニューの項目。その境界の分割を入れ替える・向きを変える
function splitItems(node: Split): MenuItem[] {
  return [
    { label: node.direction === "row" ? "左右を入れ替える" : "上下を入れ替える", action: () => flipSplit(node.id) },
    { label: node.direction === "row" ? "上下に並べる" : "左右に並べる", action: () => rotateSplit(node.id) },
  ];
}

// そのターミナルを含む、一番内側の分割
function parentSplit(node: Layout, terminal: string): Split | undefined {
  if (node.type === "terminal") return;
  return (
    parentSplit(node.children[0], terminal) ??
    parentSplit(node.children[1], terminal) ??
    (node.children.some((child) => child.type === "terminal" && child.id === terminal) ? node : undefined)
  );
}

// そのターミナルを含む、一番内側の、その向きの分割
function enclosingSplit(node: Layout, terminal: string, direction: "row" | "column"): Split | undefined {
  if (node.type === "terminal" || !terminalIds(node).includes(terminal)) return;
  return (
    enclosingSplit(node.children[0], terminal, direction) ??
    enclosingSplit(node.children[1], terminal, direction) ??
    (node.direction === direction ? node : undefined)
  );
}

// タブを選び、そのターミナルにフォーカスする。いま並べているタブなら、分割のままフォーカスだけを移す。しまってある分割のタブなら
// 分割を、どの分割にも入っていないタブならそのタブだけを、サーバーが出す（docs/adr/215-split-view.md）。
// 自分で表示を変えるので、ペアプロモードはやめる
function selectTab(id: string) {
  stopFollowing();
  if (panes.has(id)) return focusPane(id);
  pendingFocus = id;
  send({ type: "select-tab", tab: id });
}

// 開いているタブを、いまの表示に加えて分割にする。edge を渡したときは、表示全体の左・右・下に置く（タブを端へドラッグしたとき）。
// 渡さないときは、フォーカスしているターミナルの右に置く。加えたタブにフォーカスする
function addToView(id: string, edge?: "left" | "right" | "bottom") {
  if (!view || terminalIds(view).includes(id) || terminalIds(view).length >= maxPanes) return;
  stopFollowing();
  pendingFocus = id;
  send({ type: "add-to-view", tab: id, terminal: focusedTerminal, ...(edge && { edge }) });
}

// タブの右クリックのメニューの、分割表示の項目（Chrome の分割表示と同じ）
// - いま出していないタブ: 「現在のタブと新しい分割表示」（いまが分割なら「分割表示に追加」）。並べられる数まで並べていれば選べない
// - 分割に入っているタブ: 「分割を解除」（タブは閉じない）、そのタブを含む一番内側の分割の向きの変更と入れ替え
function splitMenuItems(id: string): MenuItem[] {
  if (!view) return [];
  const shown = terminalIds(view);
  const items: MenuItem[] = [];
  if (!shown.includes(id)) {
    const full = shown.length >= maxPanes;
    items.push({
      label: shown.length > 1 ? "分割表示に追加" : "現在のタブと新しい分割表示",
      disabled: full,
      ...(full && { title: `並べられるのは ${maxPanes} つまで` }),
      action: () => addToView(id),
    });
  }
  const layout = [view, ...parked].find((l) => l.type === "split" && terminalIds(l).includes(id));
  const parent = layout && parentSplit(layout, id);
  if (parent) {
    items.push(
      {
        label: "分割を解除",
        action: () => {
          stopFollowing();
          send({ type: "separate", tab: id });
        },
      },
      { label: parent.direction === "column" ? "左右に並べる" : "上下に並べる", action: () => rotateSplit(parent.id) },
      { label: "位置を入れ替える", action: () => flipSplit(parent.id) },
    );
  }
  return items;
}

// ⌘ / Ctrl を押しながらタブを選んだとき。並べているタブに加える（フォーカスしているターミナルの右に並べ、そこにフォーカスする）・外す。
// 表示しているタブが 1 つのときは外さず、並べられる数まで並べていれば加えない
function toggleTab(id: string) {
  if (!view) return;
  const shown = terminalIds(view);
  if (!shown.includes(id)) return addToView(id);
  if (shown.length === 1) return;
  stopFollowing();
  send({ type: "remove-from-view", tab: id });
}

// タブを、ターミナルの領域の左・右・下の端へドラッグすると、分割表示を作る。端に近づくと、分割表示を作る印（+）を
// タブを置く側に重ねて出す（Chrome と同じ。docs/adr/215-split-view.md）。分割したタブや、いま出しているタブは落とせない
{
  const zone = document.createElement("div");
  zone.className = "split-drop-zone";
  zone.setAttribute("role", "region");
  zone.setAttribute("aria-label", "分割表示を作る");
  const plus = document.createElement("span");
  plus.className = "split-drop-plus";
  plus.textContent = "+";
  zone.append(plus);
  zone.hidden = true;
  document.body.append(zone);
  const edgeOf = (event: DragEvent): "left" | "right" | "bottom" | undefined => {
    const id = sidebar.draggedTab();
    if (!id || !view || terminalIds(view).includes(id) || terminalIds(view).length >= maxPanes) return;
    const rect = root.getBoundingClientRect();
    const reachX = Math.min(160, rect.width * 0.2);
    const reachY = Math.min(160, rect.height * 0.25);
    if (event.clientX - rect.left < reachX) return "left";
    if (rect.right - event.clientX < reachX) return "right";
    if (rect.bottom - event.clientY < reachY) return "bottom";
    return undefined;
  };
  const hide = () => {
    zone.hidden = true;
    delete zone.dataset.edge;
  };
  root.addEventListener("dragover", (event) => {
    const edge = edgeOf(event);
    if (!edge) return hide();
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
    const rect = root.getBoundingClientRect();
    const half = edge === "bottom" ? { left: rect.left, top: rect.top + rect.height / 2, width: rect.width, height: rect.height / 2 } : { left: edge === "left" ? rect.left : rect.left + rect.width / 2, top: rect.top, width: rect.width / 2, height: rect.height };
    Object.assign(zone.style, { left: `${half.left}px`, top: `${half.top}px`, width: `${half.width}px`, height: `${half.height}px` });
    zone.dataset.edge = edge;
    zone.hidden = false;
    // ターミナル（xterm）はドラッグのイベントを外へ伝えないので、伝わる前（capture）に受け取る
  }, true);
  // 中の要素の間を移るときにも dragleave が届き、移る先（relatedTarget）が分からないことがあるので、領域の外に出たかを位置で見る
  root.addEventListener("dragleave", (event) => {
    const rect = root.getBoundingClientRect();
    const inside =
      event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom;
    if (!inside) hide();
  });
  root.addEventListener("drop", (event) => {
    const edge = edgeOf(event);
    const id = sidebar.draggedTab();
    hide();
    if (!edge || !id) return;
    event.preventDefault();
    sidebar.finishDrag();
    addToView(id, edge);
  }, true);
  document.addEventListener("dragend", hide);
}

// キー入力の先をそのターミナルに移す
function focusPane(terminal: string) {
  focusedTerminal = terminal;
  panes.get(terminal)?.focus();
}

// その向きに隣り合うターミナルのうち、重なりが一番大きいもの（同じなら先に並んでいるもの）
function neighborOf(terminal: string, direction: Direction) {
  const from = panes.get(terminal)?.element.getBoundingClientRect();
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

// ほかの参加者の選択範囲を、その人の色で出す（docs/adr/94-remote-selection.md）
function showSelections() {
  for (const [id, pane] of panes) {
    pane.setRemoteSelections(
      members.flatMap((m) =>
        m.id !== you && m.selections[id] ? [{ name: m.name, color: m.color, range: m.selections[id] }] : [],
      ),
    );
  }
}

// タブの名前（付けた名前、なければ「ターミナル N」）を、ターミナルのバーに出す
function showTabNames() {
  for (const [id, pane] of panes) {
    const tab = tabs.find((t) => t.id === id);
    pane.setName(tab?.name ?? `ターミナル ${id}`, tab?.custom);
  }
}

function showTitles() {
  panes.forEach((pane, id) => pane.setTitle(titles[id] ?? ""));
}

function showStatuses() {
  for (const [id, pane] of panes) pane.setStatus(statuses[id]);
}

// 作業中から指示待ち（見ている人がいなければ未確認）に変わったターミナルを、見ていなければ通知する。
// 見ている = ページが見えていて、そのターミナルが自分の表示にあり、自分がそのターミナルにフォーカスしている
function notifyFinished(previous: Record<string, AgentStatus>, next: Record<string, AgentStatus>) {
  const focused = members.find((m) => m.id === you)?.terminal;
  for (const [id, status] of Object.entries(next)) {
    if (previous[id] !== "working" || status === "working") continue;
    if (!document.hidden && panes.has(id) && focused === id) continue;
    const name = tabs.find((t) => t.id === id)?.name ?? `ターミナル ${id}`;
    notifyDone(`${name}: 指示待ち`, () => focusTerminal(id));
  }
}

// 並べているターミナルならそこにフォーカスし、表示していないタブなら、そのタブを選んで（分割のタブなら分割を出して）フォーカスする
function focusTerminal(id: string) {
  stopFollowing();
  if (panes.has(id)) return focusPane(id);
  if (tabs.some((t) => t.id === id)) selectTab(id);
}

// ペアプロモードを始める。相手がいまフォーカスしているターミナルとスクロール位置に、すぐ自分も合わせる
function startFollowing(member: number) {
  following = member;
  scrollPausedOn = undefined;
  send({ type: "follow", member });
  showFollowing();
  showMemberList();
  followFocus(true);
  followScroll();
}

function stopFollowing() {
  if (following === undefined) return;
  following = undefined;
  scrollPausedOn = undefined;
  send({ type: "follow", member: null });
  showFollowing();
  showMemberList();
}

// ペアプロモードの表示を更新する。追従している相手が抜けていたら、やめる（サーバーも、抜けた人への追従をやめたものとする）。
// ペアプロモードの間は、画面の縁を相手の色で太く囲み、ツールバーとターミナルのバーに相手の色を薄く敷く
function showFollowing() {
  const member = members.find((m) => m.id === following);
  if (!member) {
    following = undefined;
    scrollPausedOn = undefined;
  }
  // 相手が別のターミナルに移ったら、スクロールの追従を止めていたのをやめる
  if (member && scrollPausedOn !== undefined && member.terminal !== scrollPausedOn) scrollPausedOn = undefined;
  followIndicator.hidden = !member;
  if (member) {
    followLabel.replaceChildren(memberName(member.name), " の画面に追従中");
    document.body.dataset.pairMode = "following";
    document.body.style.setProperty("--pair-color", member.color);
  } else {
    delete document.body.dataset.pairMode;
  }
  if (scrollPausedOn === undefined) scrollPaused.replaceChildren();
  else if (!scrollPaused.contains(resumeScroll)) scrollPaused.replaceChildren(scrollPausedLabel, resumeScroll);
  showViewers();
}

// 自分に追従している参加者を出す。画面の縁も、追従している人の色で細く囲む
function showFollowed() {
  const followers = members.filter((m) => m.following === you && m.id !== you);
  followedIndicator.hidden = followers.length === 0;
  const label = document.createElement("span");
  label.append(
    ...followers.flatMap((m, i) => (i === 0 ? [memberName(m.name)] : ["、", memberName(m.name)])),
    " があなたの画面に追従中",
  );
  followedIndicator.replaceChildren(label);
  if (followers.length > 0) {
    root.dataset.followed = "true";
    root.style.setProperty("--followed-color", followers[0]!.color);
    followedIndicator.style.setProperty("--followed-color", followers[0]!.color);
  } else {
    delete root.dataset.followed;
  }
  // 追従され始めたら、いまのスクロール位置を伝える
  const wasFollowed = followed;
  followed = followers.length > 0;
  if (followed && !wasFollowed) sendScroll();
}

// ツールバーの参加者の一覧を作り直す。変わっていなければ作り直さない（ボタンを押している途中などに失わないため）
function showMemberList() {
  const others = members.filter((m) => m.id !== you);
  const key = JSON.stringify([others.map((m) => [m.id, m.name, m.color]), following]);
  if (key === memberListKey) return;
  memberListKey = key;
  memberList.replaceChildren(
    ...others.map((member) => {
      const pressed = member.id === following;
      const element = button(
        `${member.name} とペアプロ`,
        member.name,
        () => (pressed ? stopFollowing() : startFollowing(member.id)),
        pressed ? "ペアプロをやめる" : `${member.name} とペアプロ（その人の画面に追従する）`,
      );
      element.className = "viewer";
      element.setAttribute("aria-pressed", String(pressed));
      element.style.setProperty("--viewer-color", member.color);
      return element;
    }),
  );
}

// 自分のフォーカスが、追従している相手のフォーカス先のターミナルになければ移す。移したことは、ふだんどおり
// focus としてサーバーに伝わる。ペアプロモードの間は、サーバーが相手の表示（タブの選び方と並べ方）を自分の表示に写すので、
// 相手のフォーカス先がまだ自分の表示にないとき（表示より先にフォーカス先が届いたときなど）は、表示が届いて組み立てたときに移す
// （docs/adr/100-terminal-tabs.md）。
// サイドメニュー・ツールバーや設定の画面など、配置の外を操作しているときは、フォーカスを持っていかない（force は始めたとき）
function followFocus(force = false) {
  const target = members.find((m) => m.id === following)?.terminal;
  const pane = target ? panes.get(target) : undefined;
  if (!pane) return;
  const active = document.activeElement;
  if (!force && active && active !== document.body && !root.contains(active)) return;
  if (!force && pane.element.contains(active)) return;
  focusPane(target!);
}

// 追従している相手のスクロール位置に合わせる。自分でスクロールして止めているときは合わせない
function followScroll() {
  const member = members.find((m) => m.id === following);
  const scroll = member?.scroll;
  if (!member || !scroll || scroll.terminal !== member.terminal || scrollPausedOn === member.terminal) return;
  panes.get(scroll.terminal)?.scrollToOffset(scroll.offset);
}

// 自分のフォーカス先のスクロール位置を伝える。追従されていないときは伝えない（スクロールのたびに全員へ配らないため）。
// スクロールは続けて起きるので、まとめて伝える
let scrollQueued = false;
function queueScroll() {
  if (!followed || scrollQueued) return;
  scrollQueued = true;
  setTimeout(() => {
    scrollQueued = false;
    sendScroll();
  }, 50);
}

function sendScroll() {
  const pane = focusedTerminal === undefined ? undefined : panes.get(focusedTerminal);
  if (!followed || !pane) return;
  send({ type: "scroll", terminal: focusedTerminal, offset: pane.scrollOffset() });
}

// 自分で相手と別のターミナルを操作したら（クリック、右クリック、バーのボタンなど）、ペアプロモードをやめる。
// ほかの参加者の名前（ペアプロのボタン）は除く
root.addEventListener(
  "pointerdown",
  (event) => {
    if (following === undefined || !(event.target instanceof Element)) return;
    if (event.target.closest(".viewer")) return;
    const target = members.find((m) => m.id === following)?.terminal;
    for (const [id, pane] of panes) {
      if (id !== target && pane.element.contains(event.target)) return stopFollowing();
    }
  },
  { capture: true },
);

// ペアプロモードの表示の中の参加者の名前。長い名前は末尾を省き、全文はツールチップで見る（docs/adr/96-member-name.md）
function memberName(name: string) {
  const element = document.createElement("span");
  element.className = "member-name";
  element.textContent = name;
  element.title = name;
  return element;
}

function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
}
