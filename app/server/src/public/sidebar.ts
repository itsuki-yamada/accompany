// サイドメニュー。タブ（ターミナル 1 つが 1 つのタブ）の一覧を、状態・タイトル・フォーカスしている参加者とともに出す。
// 出す・隠すは参加者ごとで、ブラウザに覚えておく（docs/adr/72-sidebar.md）。隠している間は、ツールバーにタブを並べる
// （docs/adr/100-terminal-tabs.md）。タブはドラッグ、Alt+矢印、右クリックのメニューで並べ替えられ、並びは全員で共有する
// （docs/adr/139-tab-order.md）。タブの名前のダブルクリックか右クリックのメニューで、タブに名前を付けられる（docs/adr/110-tab-name.md）。
// タブは名前と色の付いたグループにまとめられ、ラベルの下（ツールバーでは右）にグループのタブを並べる（docs/adr/209-tab-groups.md）
import { showContextMenu, type MenuItem } from "./context-menu";
import { statusDescriptions, statusLabels, type AgentStatus } from "./pane";
import { shortcutFor, withKeys } from "./shortcuts";
import { editTabName, type TabNameEditor } from "./tab-name";

// サーバーから届く、タブの並び。name は画面に出す名前、custom は参加者が付けた名前（付けていなければない）、
// group は入っているグループの ID
export type Tab = { id: string; name: string; custom?: string; group?: string };
// タブのグループ。グループのタブは並びの中で続けて並ぶ。name・custom はタブと同じ
export type Group = { id: string; name: string; custom?: string; color: string };

// グループの色。サーバーとは名前（blue など）でやりとりする。タブの一覧の背景（暗い色）の上で見分けやすく、
// ラベルの文字（暗い色）が読める明るさにする（docs/adr/209-tab-groups.md）
export const groupColors: Record<string, { label: string; value: string }> = {
  blue: { label: "青", value: "#8ab4f8" },
  red: { label: "赤", value: "#f28b82" },
  yellow: { label: "黄", value: "#fdd663" },
  green: { label: "緑", value: "#81c995" },
  pink: { label: "ピンク", value: "#ff8bcb" },
  purple: { label: "紫", value: "#c58af9" },
  cyan: { label: "水色", value: "#78d9ec" },
  grey: { label: "灰色", value: "#bdc1c6" },
};

function colorOf(group: Group) {
  return groupColors[group.color]?.value ?? groupColors.grey!.value;
}

// ドラッグしているもの。タブか、グループ（ラベル）
type DragSource = { kind: "tab" | "group"; id: string };
type Place = "before" | "after";
type Member = { id: number; name: string; color: string; terminal?: string };

export type SidebarState = {
  tabs: Tab[];
  groups: Group[];
  // 自分が表示している（並べている）タブ
  shown: string[];
  // 並べられるタブの数
  maxShown: number;
  titles: Record<string, string>;
  statuses: Record<string, AgentStatus>;
  members: Member[];
  you: number | undefined;
};

export type SidebarActions = {
  // そのタブだけを表示して、そのターミナルにフォーカスする
  selectTab: (id: string) => void;
  // 並べているタブに加える・外す
  toggleTab: (id: string) => void;
  newTab: () => void;
  closeTab: (id: string) => void;
  // タブを並びの index 番目（並べ替えたあとの位置）へ移す。group を渡したときは、そのグループに入れる（null なら外す）
  moveTab: (id: string, index: number, group?: string | null) => void;
  // タブのグループ（docs/adr/209-tab-groups.md）
  newGroup: (tab: string) => void;
  addToGroup: (tab: string, group: string) => void;
  removeFromGroup: (tab: string) => void;
  // グループのタブをまとめて、グループのタブを除いた並びの index 番目へ移す
  moveGroup: (group: string, index: number) => void;
  renameGroup: (group: string, name: string) => void;
  recolorGroup: (group: string, color: string) => void;
  ungroup: (group: string) => void;
  closeGroup: (group: string) => void;
  // タブに名前を付ける。空なら名前をやめる
  renameTab: (id: string, name: string) => void;
  // サイドメニューから、表示中のターミナルにキー入力の先を戻す
  returnFocus: () => void;
};

// エージェントの状態の表記は、ターミナルのバーと同じ（docs/adr/70-agent-detection.md、docs/adr/74-unseen-done.md）。
// statuses に含まれないターミナルではエージェントが動いていないので、状態を出さず、件数にも数えない
const storageKey = "accompany.sidebar";

export class Sidebar {
  // ツールバーに置く、出す・隠すのボタン
  readonly toggleButton = document.createElement("button");
  // ツールバーに置く、タブの一覧。サイドメニューを隠している間だけ出す
  readonly strip = document.createElement("div");
  private stripTabs = document.createElement("div");
  private list = document.createElement("div");
  private summary = document.createElement("span");
  private state: SidebarState | undefined;
  // ドラッグしているタブ・グループ。ドラッグしている間は、組み直すとドラッグしている要素がなくなるので、届いた状態は手を離してから出す
  private dragged: DragSource | undefined;
  // 新しいグループに入れたタブと、送ったときのタブの並び。送ったあとに最初に届いた並びで、そのタブが新しいグループに
  // 入っていれば、ラベルに名前の入力欄を出す。入っていなければ（サーバーが受け付けなかったなど）やめる。
  // 待ち続けると、あとでほかの参加者がそのタブで作ったグループに入力欄を出してしまう
  private pendingGroup: { tab: string; tabs: Tab[] } | undefined;
  // 名前を付けている途中か。組み直すと入力欄がなくなるので、ドラッグと同じく、届いた状態は閉じてから出す
  private editing = false;
  private deferred: SidebarState | undefined;

  constructor(
    readonly element: HTMLElement,
    private actions: SidebarActions,
  ) {
    element.setAttribute("aria-label", "サイドメニュー");

    this.toggleButton.type = "button";
    this.toggleButton.textContent = "☰";
    this.toggleButton.setAttribute("aria-label", "サイドメニュー");
    this.toggleButton.setAttribute("aria-controls", element.id);
    this.toggleButton.title = withKeys("サイドメニューを出す・隠す");
    this.toggleButton.addEventListener("click", () => this.toggle());

    const tabHeader = header("タブ");
    this.summary.className = "sidebar-summary";
    tabHeader.append(this.summary, newTabButton(actions));
    this.list.className = "sidebar-tabs";
    this.list.setAttribute("role", "tablist");
    this.list.setAttribute("aria-orientation", "vertical");
    this.list.setAttribute("aria-multiselectable", "true");
    this.list.setAttribute("aria-label", "タブ");
    element.append(tabHeader, this.list);
    element.addEventListener("keydown", (event) => this.onKeyDown(event));

    this.strip.className = "toolbar-tabs";
    this.stripTabs.className = "toolbar-tab-list";
    this.stripTabs.setAttribute("role", "tablist");
    this.stripTabs.setAttribute("aria-multiselectable", "true");
    this.stripTabs.setAttribute("aria-label", "タブ");
    this.strip.append(this.stripTabs, newTabButton(actions));
    this.strip.addEventListener("keydown", (event) => this.moveByKey(event, false));
    this.enableDropAtEnd(element);
    this.enableDropAtEnd(this.strip);

    this.setVisible(loadVisible());
  }

  get visible() {
    return !this.element.hidden;
  }

  // 隠すときにキー入力の先がサイドメニューにあれば、ターミナルに戻す
  toggle() {
    const hadFocus = this.element.contains(document.activeElement);
    this.setVisible(!this.visible);
    saveVisible(this.visible);
    if (!this.visible && hadFocus) this.actions.returnFocus();
  }

  // サイドメニューへ移る。隠していれば出す。自分がフォーカスしているターミナルのタブ、なければ最初のタブに移る
  focus() {
    if (!this.visible) {
      this.setVisible(true);
      saveVisible(true);
    }
    const mine = this.state?.members.find((m) => m.id === this.state?.you)?.terminal;
    const rows = this.list.querySelectorAll<HTMLButtonElement>("button[data-terminal]");
    ([...rows].find((row) => row.dataset.terminal === mine) ?? rows[0])?.focus();
  }

  update(state: SidebarState) {
    if (this.dragged !== undefined || this.editing) {
      this.deferred = state;
      return;
    }
    const known = new Set(this.state?.groups.map((g) => g.id));
    this.state = state;
    // 組み直すとキー入力の先の行がなくなるので、どの行だったかを覚えておき、あとで戻す
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && (this.element.contains(active) || this.strip.contains(active))
        ? active.dataset.key
        : undefined;
    this.renderList(state);
    this.renderStrip(state);
    if (focused) {
      const scope = this.visible ? this.element : this.strip;
      scope.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
    }
    // 自分が作ったグループが届いたら、すぐに名前を付けられるようにする（Chrome のタブグループと同じ）
    const pending = this.pendingGroup;
    if (pending && state.tabs !== pending.tabs) {
      this.pendingGroup = undefined;
      const tab = state.tabs.find((t) => t.id === pending.tab);
      if (tab?.group !== undefined && !known.has(tab.group)) this.renameGroup(tab.group);
    }
  }

  private setVisible(visible: boolean) {
    this.element.hidden = !visible;
    this.strip.hidden = visible;
    this.toggleButton.setAttribute("aria-expanded", String(visible));
  }

  private renderList(state: SidebarState) {
    const { tabs, titles, statuses, members, you } = state;
    this.summary.replaceChildren(counts(tabs.flatMap((tab) => (statuses[tab.id] ? [statuses[tab.id]!] : []))));
    this.list.replaceChildren(
      ...this.withLabels(state, true, (tab) => {
        const { id } = tab;
        const row = document.createElement("div");
        row.className = "tab-row";
        this.markGroup(row, tab, state);
        const select = this.tabButton(tab, state);
        select.dataset.nav = "";
        const status = statuses[id];
        const line = document.createElement("span");
        line.className = "session-line";
        if (status) {
          const badge = document.createElement("span");
          badge.className = "session-status";
          badge.dataset.status = status;
          badge.textContent = statusLabels[status];
          badge.title = statusDescriptions[status];
          line.append(badge);
        }
        const label = document.createElement("span");
        label.className = "session-name";
        label.textContent = tab.name;
        // 長い名前は末尾を省くので、全文はツールチップで見る
        label.title = tab.name;
        line.append(label);
        select.append(line);
        const title = titles[id];
        if (title) {
          const program = document.createElement("span");
          program.className = "session-title";
          program.textContent = title;
          select.title = title;
          select.append(program);
        }
        const viewers = members.filter((m) => m.terminal === id);
        if (viewers.some((m) => m.id === you)) select.dataset.focused = "true";
        if (viewers.length > 0) {
          const list = document.createElement("span");
          list.className = "session-viewers";
          list.append(
            ...viewers.map((m) => {
              const viewer = document.createElement("span");
              viewer.className = "viewer";
              viewer.textContent = m.id === you ? "あなた" : m.name;
              viewer.style.setProperty("--viewer-color", m.color);
              return viewer;
            }),
          );
          select.append(list);
        }

        row.append(select, ...this.tabActions(tab, state));
        this.enableDrag(row, { kind: "tab", id }, true);
        return row;
      }),
    );
  }

  // タブの要素を並べ、グループの最初のタブの前に、グループのラベルを入れる
  private withLabels(state: SidebarState, vertical: boolean, render: (tab: Tab) => HTMLElement) {
    const elements: HTMLElement[] = [];
    let previous: string | undefined;
    for (const tab of state.tabs) {
      const group = state.groups.find((g) => g.id === tab.group);
      if (group && group.id !== previous) elements.push(this.groupLabel(group, vertical));
      previous = group?.id;
      elements.push(render(tab));
    }
    return elements;
  }

  // グループのタブに、グループの色を付ける
  private markGroup(element: HTMLElement, tab: Tab, state: SidebarState) {
    const group = state.groups.find((g) => g.id === tab.group);
    if (!group) return;
    element.dataset.group = group.id;
    element.style.setProperty("--group-color", colorOf(group));
  }

  // グループのラベル。右クリックでメニュー、ダブルクリックで名前を付け、ドラッグでグループごと移す
  private groupLabel(group: Group, vertical: boolean) {
    const wrapper = document.createElement(vertical ? "div" : "span");
    wrapper.className = vertical ? "group-row" : "toolbar-group";
    const label = document.createElement("button");
    label.type = "button";
    label.className = "group-label";
    label.dataset.key = `group-${group.id}`;
    label.dataset.group = group.id;
    label.dataset.color = group.color;
    label.style.setProperty("--group-color", colorOf(group));
    label.textContent = group.name;
    label.title = `${group.name}（ドラッグでグループごと移す。右クリックで名前・色の変更、解除、まとめて閉じる）`;
    label.setAttribute("aria-label", `${group.name} のグループ`);
    label.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const at = event.clientX || event.clientY ? event : label.getBoundingClientRect();
      this.openGroupMenu(group, at.x, at.y);
    });
    label.addEventListener("dblclick", () => this.renameGroup(group.id));
    wrapper.append(label);
    this.enableDrag(wrapper, { kind: "group", id: group.id }, vertical);
    return wrapper;
  }

  // ツールバーのタブ。名前と状態、並べて表示・閉じるのボタンを出す
  private renderStrip(state: SidebarState) {
    this.stripTabs.replaceChildren(
      ...this.withLabels(state, false, (tab) => {
        const item = document.createElement("span");
        item.className = "toolbar-tab-item";
        this.markGroup(item, tab, state);
        const select = this.tabButton(tab, state);
        select.className = "toolbar-tab";
        const status = state.statuses[tab.id];
        if (status) item.dataset.status = status;
        select.textContent = tab.name;
        const group = state.groups.find((g) => g.id === tab.group)?.name;
        select.title = [tab.name, state.titles[tab.id], status && statusLabels[status], group && `グループ: ${group}`]
          .filter(Boolean)
          .join(" ・ ");
        item.append(select, ...this.tabActions(tab, state));
        this.enableDrag(item, { kind: "tab", id: tab.id }, false);
        return item;
      }),
    );
  }

  // タブの並べて表示・閉じるのボタン。並べて表示は、表示しているタブが 1 つのときは外せず、並べられる数まで並べているときは
  // 加えられない。最後のタブは閉じられない
  private tabActions({ id, name }: Tab, { tabs, shown, maxShown }: SidebarState) {
    const isShown = shown.includes(id);
    const toggle = smallButton("⊞", `${name} を並べて表示`, `toggle-${id}`, () => this.actions.toggleTab(id));
    toggle.className = "tab-toggle";
    toggle.setAttribute("aria-pressed", String(isShown));
    toggle.disabled = isShown ? shown.length === 1 : shown.length >= maxShown;
    toggle.title = isShown
      ? "並べるのをやめる"
      : shown.length >= maxShown
        ? `並べられるのは ${maxShown} つまで`
        : "並べて表示（⌘ / Ctrl を押しながらタブを選んでも並べられる）";
    const close = smallButton("×", `${name} を閉じる`, `close-${id}`, () => this.actions.closeTab(id));
    close.className = "tab-close";
    close.disabled = tabs.length === 1;
    return [toggle, close];
  }

  // タブを選ぶボタン。押すとそのタブだけを表示し、⌘ / Ctrl を押しながら押すと、並べているタブに加える・外す
  private tabButton(tab: Tab, { shown }: SidebarState) {
    const select = document.createElement("button");
    select.type = "button";
    select.className = "session";
    select.dataset.key = `tab-${tab.id}`;
    select.dataset.terminal = tab.id;
    if (tab.group !== undefined) select.dataset.group = tab.group;
    select.setAttribute("role", "tab");
    select.setAttribute("aria-label", tab.name);
    select.setAttribute("aria-selected", String(shown.includes(tab.id)));
    select.addEventListener("click", (event) =>
      event.metaKey || event.ctrlKey ? this.actions.toggleTab(tab.id) : this.actions.selectTab(tab.id),
    );
    select.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      // キーボードのコンテキストメニューキーで開いたときは、タブの位置に出す
      const at = event.clientX || event.clientY ? event : select.getBoundingClientRect();
      this.openMenu(tab, at.x, at.y, this.list.contains(select));
    });
    select.addEventListener("dblclick", () => this.rename(tab.id));
    return select;
  }

  // タブの右クリックのメニュー。サイドメニューでは上・下、ツールバーでは左・右へ移す。端のタブは、その向きへは移せない。
  // グループに入れる・外す項目も出す。既存のグループには、グループごとの項目で入れる（メニューに入れ子はないので）
  private openMenu(tab: Tab, x: number, y: number, vertical: boolean) {
    const [before, after] = vertical ? ["上へ移す", "下へ移す"] : ["左へ移す", "右へ移す"];
    const step = (n: number): MenuItem => {
      const target = this.stepTarget(tab.id, n);
      return {
        label: n < 0 ? before : after,
        disabled: !target,
        action: () => target && this.move(tab.id, target.index, target.group),
      };
    };
    const groups: MenuItem[] = [
      {
        label: "新しいグループに追加",
        action: () => {
          this.pendingGroup = { tab: tab.id, tabs: this.state?.tabs ?? [] };
          this.actions.newGroup(tab.id);
        },
      },
      ...(this.state?.groups ?? [])
        .filter((g) => g.id !== tab.group)
        .map((g) => ({
          label: `グループ「${g.name}」に追加`,
          swatch: colorOf(g),
          action: () => this.actions.addToGroup(tab.id, g.id),
        })),
      ...(tab.group === undefined
        ? []
        : [{ label: "グループから外す", action: () => this.actions.removeFromGroup(tab.id) }]),
    ];
    showContextMenu(
      x,
      y,
      `${tab.name} のタブのメニュー`,
      [step(-1), step(1), "separator", ...groups, "separator", { label: "名前を変更…", action: () => this.rename(tab.id) }],
      () => this.focusTab(tab.id),
    );
  }

  // グループのラベルの右クリックのメニュー。名前・色の変更、解除、グループのタブをまとめて閉じる。
  // すべてのタブがそのグループにあるときは、まとめて閉じられない（最後のタブは閉じないので）
  private openGroupMenu(group: Group, x: number, y: number) {
    const all = (this.state?.tabs ?? []).every((t) => t.group === group.id);
    showContextMenu(
      x,
      y,
      `${group.name} のグループのメニュー`,
      [
        { label: "名前を変更…", action: () => this.renameGroup(group.id) },
        "separator",
        ...Object.entries(groupColors).map(([color, { label, value }]) => ({
          label,
          ariaLabel: label,
          swatch: value,
          checked: group.color === color,
          ...(group.color === color && { mark: "✓" }),
          action: () => this.actions.recolorGroup(group.id, color),
        })),
        "separator",
        { label: "グループを解除", action: () => this.actions.ungroup(group.id) },
        {
          label: "グループのタブを閉じる",
          disabled: all,
          ...(all && { title: "すべてのタブがこのグループにあるので、まとめては閉じられない" }),
          action: () => this.actions.closeGroup(group.id),
        },
      ],
      () => this.focusKey(`group-${group.id}`),
    );
  }

  // タブを 1 つ前（step = -1）・後ろ（1）へ移すときの、移す位置とグループ。移せなければ undefined。
  // - グループの中では、隣のタブと入れ替える。グループの端から外へ移すと、その場でグループから外れる
  // - グループの外のタブは、隣のグループを飛び越える（グループに入れるのはメニューかドラッグ）
  private stepTarget(id: string, step: number): { index: number; group?: string | null } | undefined {
    const tabs = this.state?.tabs ?? [];
    const index = tabs.findIndex((t) => t.id === id);
    const tab = tabs[index];
    if (!tab) return;
    const next = tabs[index + step];
    if (tab.group !== undefined) return next?.group === tab.group ? { index: index + step } : { index, group: null };
    if (!next) return;
    if (next.group === undefined) return { index: index + step };
    const span = tabs.flatMap((t, i) => (t.group === next.group ? [i] : []));
    // 後ろへ飛び越えるときは、移すタブを除いた並びで、グループの最後のタブの後ろ
    return { index: step > 0 ? span.at(-1)! : span[0]! };
  }

  // タブを並びの index 番目へ移す（group を渡したときは、そのグループに入れる・外す）。続けて移したとき（Alt+↑ を 2 回など）に
  // 前の並びから位置を数えないよう、サーバーから並びが届く前に手元の並びも変えておく。届いた並びで置き換わる
  private move(id: string, index: number, group?: string | null) {
    if (!this.state) return;
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    const found = this.state.tabs.find((t) => t.id === id);
    if (!found || index < 0 || index > tabs.length) return;
    const moved = { ...found };
    if (group === null) delete moved.group;
    else if (group !== undefined) moved.group = group;
    tabs.splice(index, 0, moved);
    const groups = this.state.groups.filter((g) => tabs.some((t) => t.group === g.id));
    this.update({ ...this.state, tabs, groups });
    this.actions.moveTab(id, index, group);
  }

  // グループのタブをまとめて、グループのタブを除いた並びの index 番目へ移す。手元の並びも先に変えておく
  private moveGroup(id: string, index: number) {
    if (!this.state) return;
    const members = this.state.tabs.filter((t) => t.group === id);
    const rest = this.state.tabs.filter((t) => t.group !== id);
    if (members.length === 0 || index < 0 || index > rest.length) return;
    this.update({ ...this.state, tabs: [...rest.slice(0, index), ...members, ...rest.slice(index)] });
    this.actions.moveGroup(id, index);
  }

  // 出ている方（サイドメニューかツールバー）のタブの場所に、名前の入力欄を出す。Enter・Esc で閉じたら、タブにキー入力の先を戻す
  private rename(id: string) {
    const tab = this.state?.tabs.find((t) => t.id === id);
    if (!tab) return;
    this.editName(`tab-${id}`, {
      value: tab.custom ?? "",
      placeholder: `ターミナル ${id}`,
      commit: (name) => this.actions.renameTab(id, name),
    });
  }

  // グループのラベルの場所に、名前の入力欄を出す
  private renameGroup(id: string) {
    const group = this.state?.groups.find((g) => g.id === id);
    if (!group) return;
    this.editName(`group-${id}`, {
      value: group.custom ?? "",
      placeholder: `グループ ${id}`,
      label: "グループの名前",
      commit: (name) => this.actions.renameGroup(id, name),
    });
  }

  private editName(key: string, editor: Omit<TabNameEditor, "finish">) {
    const scope = this.visible ? this.element : this.strip;
    const anchor = scope.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!anchor || this.editing) return;
    this.editing = true;
    // 入力欄の中で文字を選ぶときに、タブ・グループのドラッグを始めない
    const draggable = anchor.parentElement;
    if (draggable) draggable.draggable = false;
    editTabName(anchor, {
      ...editor,
      finish: (keyboard) => {
        if (draggable) draggable.draggable = true;
        this.editing = false;
        const deferred = this.deferred;
        this.deferred = undefined;
        if (deferred) this.update(deferred);
        if (keyboard) this.focusKey(key);
      },
    });
  }

  // 出ている方（サイドメニューかツールバー）のタブにキー入力の先を移す
  private focusTab(id: string) {
    this.focusKey(`tab-${id}`);
  }

  private focusKey(key: string) {
    const scope = this.visible ? this.element : this.strip;
    scope.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
  }

  // Alt（Option）+矢印で、キー入力の先のタブを前・後ろへ移す。サイドメニューは ↑↓、ツールバーは ←→。端ではそれ以上動かない。
  // 移したタブには、組み直したあともキー入力の先が残る（update で戻す）
  private moveByKey(event: KeyboardEvent, vertical: boolean) {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return false;
    const keys: Record<string, number> = vertical ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
    const step = keys[event.key];
    const id = event.target instanceof HTMLElement ? event.target.dataset.terminal : undefined;
    if (!step || !id || !this.state) return false;
    event.preventDefault();
    const target = this.stepTarget(id, step);
    if (target) this.move(id, target.index, target.group);
    return true;
  }

  // タブの行（項目）とグループのラベルをドラッグして並べ替えられるようにする。ほかのタブ・ラベルの前半に重ねるとその前、
  // 後半に重ねるとその後ろへ移し、移す位置に線を出す（data-drop）。タブはグループに出し入れでき、ラベルはグループごと移す。
  // ファイルやほかのページからのドラッグは受け付けない
  private enableDrag(element: HTMLElement, source: DragSource, vertical: boolean) {
    element.draggable = true;
    element.dataset.dragKey = `${source.kind}-${source.id}`;
    const placeOf = (event: DragEvent): Place => {
      const rect = element.getBoundingClientRect();
      const first = vertical ? event.clientY - rect.top < rect.height / 2 : event.clientX - rect.left < rect.width / 2;
      return first ? "before" : "after";
    };
    element.addEventListener("dragstart", (event) => {
      this.dragged = source;
      event.dataTransfer!.effectAllowed = "move";
      // 中身は使わないが、Firefox では何か入れないとドラッグが始まらない
      event.dataTransfer!.setData("text/plain", "");
      element.dataset.dragging = "true";
    });
    element.addEventListener("dragend", () => {
      delete element.dataset.dragging;
      this.endDrag();
    });
    element.addEventListener("dragover", (event) => {
      if (this.dragged === undefined) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      const drop = this.dropPlan(this.dragged, source, placeOf(event));
      const marked = drop && element.parentElement?.querySelector<HTMLElement>(`:scope > [data-drag-key="${drop.mark}"]`);
      this.clearDrop(marked ?? undefined);
      if (drop && marked) marked.dataset.drop = drop.markPlace;
    });
    element.addEventListener("dragleave", (event) => {
      if (!element.contains(event.relatedTarget as Node | null)) this.clearDrop();
    });
    element.addEventListener("drop", (event) => {
      const dragged = this.dragged;
      if (dragged === undefined) return;
      event.preventDefault();
      const place = placeOf(event);
      // ドラッグしている間に届いた並び（ほかの参加者の並べ替えなど）を先に出してから、その並びで位置を数える
      this.endDrag();
      this.dropPlan(dragged, source, place)?.apply();
    });
  }

  // dragged を target（タブかラベル）の前・後ろに落としたときの操作と、位置の線を出す要素（mark）と向き。落とせなければ undefined。
  // - タブ: タブに重ねると、そのタブと同じグループに入る（グループに入っていないタブなら、グループから外れる）。
  //   ラベルの前半ならグループの前（グループの外）、後半ならグループの先頭に入る
  // - グループ: グループは入れ子にできないので、ほかのグループのタブ・ラベルに重ねたときは、そのグループの前・後ろに移す
  private dropPlan(dragged: DragSource, target: DragSource, place: Place) {
    const tabs = this.state?.tabs ?? [];
    if (dragged.kind === target.kind && dragged.id === target.id) return;
    const span = (list: Tab[], group: string | undefined) => list.flatMap((t, i) => (t.group === group ? [i] : []));
    const targetTab = target.kind === "tab" ? tabs.find((t) => t.id === target.id) : undefined;
    if (target.kind === "tab" && !targetTab) return;
    const mark = `${target.kind}-${target.id}`;

    if (dragged.kind === "tab") {
      const rest = tabs.filter((t) => t.id !== dragged.id);
      if (targetTab) {
        const index = rest.indexOf(targetTab) + (place === "after" ? 1 : 0);
        return { mark, markPlace: place, apply: () => this.move(dragged.id, index, targetTab.group ?? null) };
      }
      const first = span(rest, target.id)[0];
      if (first === undefined) return;
      return { mark, markPlace: place, apply: () => this.move(dragged.id, first, place === "before" ? null : target.id) };
    }

    if (targetTab?.group === dragged.id) return;
    const rest = tabs.filter((t) => t.group !== dragged.id);
    const other = targetTab ? targetTab.group : target.id;
    if (other === undefined) {
      const index = rest.indexOf(targetTab!) + (place === "after" ? 1 : 0);
      return { mark, markPlace: place, apply: () => this.moveGroup(dragged.id, index) };
    }
    const indices = span(rest, other);
    if (indices.length === 0) return;
    // ほかのグループのラベルに重ねたとき、またはタブの前半に重ねたときは、そのグループの前
    if (target.kind === "group" || place === "before") {
      return { mark: `group-${other}`, markPlace: "before" as Place, apply: () => this.moveGroup(dragged.id, indices[0]!) };
    }
    const last = indices.at(-1)!;
    return { mark: `tab-${rest[last]!.id}`, markPlace: "after" as Place, apply: () => this.moveGroup(dragged.id, last + 1) };
  }

  // 一覧（サイドメニュー・ツールバーのタブの並び）の、タブ・ラベルのない所に落とすと、最後へ移す。タブはグループから外れる
  // （Chrome と同じ）。線は一覧の最後の要素の後ろに出す
  // area はサイドメニュー・ツールバーのタブの並びのほか、ツールバーのタブの右の空いている所（toolbar-spacer）にも使う
  enableDropAtEnd(area: HTMLElement) {
    const onEmpty = (event: DragEvent) =>
      this.dragged !== undefined && !(event.target instanceof Element && event.target.closest("[data-drag-key]"));
    area.addEventListener("dragover", (event) => {
      if (!onEmpty(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      const last = (this.visible ? this.list : this.stripTabs).lastElementChild as HTMLElement | null;
      const drop = this.dropAtEnd(this.dragged!);
      this.clearDrop(drop ? (last ?? undefined) : undefined);
      if (drop && last) last.dataset.drop = "after";
    });
    area.addEventListener("dragleave", (event) => {
      if (!area.contains(event.relatedTarget as Node | null)) this.clearDrop();
    });
    area.addEventListener("drop", (event) => {
      const dragged = this.dragged;
      if (!dragged || !onEmpty(event)) return;
      event.preventDefault();
      this.endDrag();
      this.dropAtEnd(dragged)?.();
    });
  }

  // 最後へ移す操作。すでに最後にあって、移しても変わらないときは undefined
  private dropAtEnd(dragged: DragSource) {
    const tabs = this.state?.tabs ?? [];
    if (dragged.kind === "tab") {
      const tab = tabs.find((t) => t.id === dragged.id);
      if (!tab || (tabs.at(-1) === tab && tab.group === undefined)) return;
      return () => this.move(dragged.id, tabs.length - 1, null);
    }
    const rest = tabs.filter((t) => t.group !== dragged.id);
    if (tabs.at(-1)?.group === dragged.id) return;
    return () => this.moveGroup(dragged.id, rest.length);
  }

  // ドラッグを終え、移す位置の線を消して、ドラッグしている間に届いた状態を出す
  private endDrag() {
    if (this.dragged === undefined) return;
    this.dragged = undefined;
    this.clearDrop();
    const deferred = this.deferred;
    this.deferred = undefined;
    if (deferred) this.update(deferred);
  }

  private clearDrop(except?: HTMLElement) {
    for (const element of [...this.list.children, ...this.stripTabs.children] as HTMLElement[]) {
      if (element !== except) delete element.dataset.drop;
    }
  }

  // ↑↓ でタブを順に移る。Esc でターミナルに戻る。
  // サイドメニューの中でも、出す・隠す（隠してターミナルに戻る）と、サイドメニューへ移る（ターミナルに戻る）のショートカットは効く
  private onKeyDown(event: KeyboardEvent) {
    if (this.moveByKey(event, true)) return;
    const shortcut = shortcutFor(event);
    if (shortcut === "ignore") return event.preventDefault();
    if (shortcut?.type === "toggle-sidebar" || shortcut?.type === "focus-sidebar") {
      event.preventDefault();
      if (shortcut.type === "toggle-sidebar") this.toggle();
      else this.actions.returnFocus();
      return;
    }
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      return this.actions.returnFocus();
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const rows = [...this.element.querySelectorAll<HTMLElement>("[data-nav]")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    rows[Math.min(rows.length - 1, Math.max(0, index + step))]?.focus();
  }
}

function header(text: string) {
  const element = document.createElement("div");
  element.className = "sidebar-header";
  const title = document.createElement("h2");
  title.textContent = text;
  element.append(title);
  return element;
}

function smallButton(text: string, label: string, key: string, onClick: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = label;
  element.dataset.key = key;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", onClick);
  return element;
}

function newTabButton(actions: SidebarActions) {
  const add = document.createElement("button");
  add.type = "button";
  add.className = "new-tab";
  add.textContent = "+";
  add.setAttribute("aria-label", "新しいタブ");
  add.title = withKeys("新しいタブ");
  add.addEventListener("click", () => actions.newTab());
  return add;
}

// 状態ごとの件数（例: 作業中 1・未確認 1・指示待ち 2）。0 件の状態は出さない
function counts(statuses: AgentStatus[]) {
  const element = document.createElement("span");
  element.className = "status-counts";
  for (const status of ["working", "done", "idle"] as const) {
    const count = statuses.filter((s) => s === status).length;
    if (count === 0) continue;
    const item = document.createElement("span");
    item.className = "status-count";
    item.dataset.status = status;
    item.textContent = `${statusLabels[status]} ${count}`;
    item.title = statusDescriptions[status];
    element.append(item);
  }
  return element;
}

// 自分で切り替えたことがあれば、それに従う。なければ、ウィンドウが狭いとき（分割したターミナルのバーが収まらなくなる）を除いて出す
const narrowWidth = 1024;

function loadVisible() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(storageKey);
  } catch {
    // 読めなければ、切り替えたことがないものとする
  }
  return saved === null ? window.innerWidth >= narrowWidth : saved !== "hidden";
}

function saveVisible(visible: boolean) {
  try {
    localStorage.setItem(storageKey, visible ? "shown" : "hidden");
  } catch {
    // 保存できなくても、開いている間は使う
  }
}
