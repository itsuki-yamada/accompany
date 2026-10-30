// サイドメニュー。タブ（ターミナル 1 つが 1 つのタブ）の一覧を、状態・タイトル・フォーカスしている参加者とともに出す。
// 出す・隠すは参加者ごとで、ブラウザに覚えておく（docs/adr/72-sidebar.md）。隠している間は、ツールバーにタブを並べる
// （docs/adr/100-terminal-tabs.md）。タブはドラッグ、Alt+矢印、右クリックのメニューで並べ替えられ、並びは全員で共有する
// （docs/adr/139-tab-order.md）。タブの名前のダブルクリックか右クリックのメニューで、タブに名前を付けられる（docs/adr/110-tab-name.md）。
// タブは名前と色の付いたグループにまとめられ、ラベルの下（ツールバーでは右）にグループのタブを並べる（docs/adr/209-tab-groups.md）。
// 分割したタブは、1 つのタブの枠の中に名前を横に並べ、並べ替え・グループの出し入れでは 1 つのタブとして扱う（docs/adr/215-split-view.md）
import { showContextMenu, type MenuItem } from "./context-menu";
import { statusDescriptions, statusLabels, type AgentStatus } from "./pane";
import { shortcutFor, withKeys } from "./shortcuts";
import { entriesOf, type Entry } from "./split-view";
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

// ドラッグしているもの。タブ（分割なら、項目の最初のタブ）か、グループ（ラベル）
type DragSource = { kind: "tab" | "group"; id: string };
type Place = "before" | "after";
type Member = { id: number; name: string; color: string; terminal?: string };

export type SidebarState = {
  tabs: Tab[];
  groups: Group[];
  // 自分が表示している（並べている）タブ
  shown: string[];
  // 自分の分割（いま出しているものと、しまってあるもの）。それぞれ、分割の中の並び（左から・上から）
  splits: string[][];
  titles: Record<string, string>;
  statuses: Record<string, AgentStatus>;
  members: Member[];
  you: number | undefined;
};

export type SidebarActions = {
  // タブを選ぶ。分割のタブなら分割を出し（いま出していれば、分割のまま）、そのターミナルにフォーカスする
  selectTab: (id: string) => void;
  // 並べているタブに加える・外す（⌘ / Ctrl を押しながら選んだとき）
  toggleTab: (id: string) => void;
  // タブの右クリックのメニューの、分割表示の項目（作る・解除・閉じる・向きの変更・入れ替え）
  splitItems: (id: string) => MenuItem[];
  newTab: () => void;
  closeTab: (id: string) => void;
  // タブを並びの index 番目（移すタブを除いた並びでの位置）へ移す。group を渡したときは、そのグループに入れる（null なら外す）。
  // 分割したタブは、まとめて渡す
  moveTab: (tabs: string[], index: number, group?: string | null) => void;
  // タブのグループ（docs/adr/209-tab-groups.md）。分割したタブは、まとめて渡す
  newGroup: (tabs: string[]) => void;
  addToGroup: (tabs: string[], group: string) => void;
  removeFromGroup: (tabs: string[]) => void;
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
    const { tabs, statuses } = state;
    this.summary.replaceChildren(counts(tabs.flatMap((tab) => (statuses[tab.id] ? [statuses[tab.id]!] : []))));
    this.list.replaceChildren(
      ...this.withLabels(state, true, (entry) => {
        const row = document.createElement("div");
        row.className = "tab-row";
        this.markGroup(row, entry.lead, state);
        if (entry.tabs.length > 1) {
          // 分割したタブは、1 つの行に名前を横に並べる。それぞれの名前に閉じるボタンを残す
          row.dataset.split = "true";
          row.append(
            ...entry.tabs.map((tab) => {
              const part = document.createElement("div");
              part.className = "split-part";
              part.append(this.sidebarTab(tab, state), this.closeButton(tab, state));
              return part;
            }),
          );
        } else {
          row.append(this.sidebarTab(entry.lead, state), this.closeButton(entry.lead, state));
        }
        this.enableDrag(row, { kind: "tab", id: entry.tabs[0]!.id }, true);
        return row;
      }),
    );
  }

  // サイドメニューのタブ。状態・名前・タイトル・フォーカスしている参加者を出す
  private sidebarTab(tab: Tab, state: SidebarState) {
    const { id } = tab;
    const { titles, statuses, members, you } = state;
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
    return select;
  }

  // 一覧の項目（タブ 1 つか、分割したタブ）。分割は参加者ごとなので、自分の分割をまとめる
  private entries(state = this.state): Entry<Tab>[] {
    return state ? entriesOf(state.tabs, state.splits) : [];
  }

  // そのタブが入っている項目のタブ（分割していなければ、そのタブだけ）
  private blockOf(id: string) {
    return this.entries().find((e) => e.tabs.some((t) => t.id === id))?.tabs.map((t) => t.id) ?? [id];
  }

  // 項目を並べ、グループの最初の項目の前に、グループのラベルを入れる
  private withLabels(state: SidebarState, vertical: boolean, render: (entry: Entry<Tab>) => HTMLElement) {
    const elements: HTMLElement[] = [];
    let previous: string | undefined;
    for (const entry of this.entries(state)) {
      const group = state.groups.find((g) => g.id === entry.lead.group);
      if (group && group.id !== previous) elements.push(this.groupLabel(group, vertical));
      previous = group?.id;
      elements.push(render(entry));
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

  // ツールバーのタブ。名前と状態、閉じるのボタンを出す。分割したタブは、1 つの項目に名前と閉じるボタンを横に並べる
  private renderStrip(state: SidebarState) {
    this.stripTabs.replaceChildren(
      ...this.withLabels(state, false, (entry) => {
        const item = document.createElement("span");
        item.className = "toolbar-tab-item";
        this.markGroup(item, entry.lead, state);
        const parts = entry.tabs.map((tab) => {
          const select = this.tabButton(tab, state);
          select.className = "toolbar-tab";
          const status = state.statuses[tab.id];
          select.textContent = tab.name;
          const group = state.groups.find((g) => g.id === tab.group)?.name;
          select.title = [tab.name, state.titles[tab.id], status && statusLabels[status], group && `グループ: ${group}`]
            .filter(Boolean)
            .join(" ・ ");
          if (entry.tabs.length === 1) {
            if (status) item.dataset.status = status;
            return [select, this.closeButton(tab, state)];
          }
          const part = document.createElement("span");
          part.className = "split-part";
          if (status) part.dataset.status = status;
          part.append(select, this.closeButton(tab, state));
          return [part];
        });
        if (entry.tabs.length > 1) item.dataset.split = "true";
        item.append(...parts.flat());
        this.enableDrag(item, { kind: "tab", id: entry.tabs[0]!.id }, false);
        return item;
      }),
    );
  }

  // タブの閉じるボタン。最後のタブは閉じられない
  private closeButton({ id, name }: Tab, { tabs }: SidebarState) {
    const close = smallButton("×", `${name} を閉じる`, `close-${id}`, () => this.actions.closeTab(id));
    close.className = "tab-close";
    close.disabled = tabs.length === 1;
    return close;
  }

  // タブを選ぶボタン。押すとそのタブを表示し（分割のタブなら分割を出す）、⌘ / Ctrl を押しながら押すと、並べているタブに加える・外す
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

  // タブの右クリックのメニュー。分割表示の項目、サイドメニューでは上・下、ツールバーでは左・右へ移す項目（端のタブは、その向きへは
  // 移せない）、グループに入れる・外す項目を出す。既存のグループには、グループごとの項目で入れる（メニューに入れ子はないので）。
  // 分割したタブでは、移す・グループの項目は分割のタブをまとめて扱う
  private openMenu(tab: Tab, x: number, y: number, vertical: boolean) {
    const [before, after] = vertical ? ["上へ移す", "下へ移す"] : ["左へ移す", "右へ移す"];
    const block = this.blockOf(tab.id);
    const lead = this.entries().find((e) => e.tabs.some((t) => t.id === tab.id))?.lead ?? tab;
    const step = (n: number): MenuItem => {
      const target = this.stepTarget(tab.id, n);
      return {
        label: n < 0 ? before : after,
        disabled: !target,
        action: () => target && this.move(block, target.index, target.group),
      };
    };
    const groups: MenuItem[] = [
      {
        label: "新しいグループに追加",
        action: () => {
          this.pendingGroup = { tab: tab.id, tabs: this.state?.tabs ?? [] };
          this.actions.newGroup(block);
        },
      },
      ...(this.state?.groups ?? [])
        .filter((g) => g.id !== lead.group)
        .map((g) => ({
          label: `グループ「${g.name}」に追加`,
          swatch: colorOf(g),
          action: () => this.actions.addToGroup(block, g.id),
        })),
      ...(lead.group === undefined
        ? []
        : [{ label: "グループから外す", action: () => this.actions.removeFromGroup(block) }]),
    ];
    const split = this.actions.splitItems(tab.id);
    showContextMenu(
      x,
      y,
      `${tab.name} のタブのメニュー`,
      [
        ...split,
        ...(split.length > 0 ? ["separator" as const] : []),
        step(-1),
        step(1),
        "separator",
        ...groups,
        "separator",
        { label: "名前を変更…", action: () => this.rename(tab.id) },
      ],
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

  // タブ（分割なら、分割の項目）を 1 つ前（step = -1）・後ろ（1）へ移すときの、移す位置（移す項目を除いた一覧での、タブの数え方の位置）
  // とグループ。移せなければ undefined。
  // - グループの中では、隣の項目と入れ替える。グループの端から外へ移すと、その場でグループから外れる
  // - グループの外の項目は、隣のグループを飛び越える（グループに入れるのはメニューかドラッグ）
  private stepTarget(id: string, step: number): { index: number; group?: string | null } | undefined {
    const entries = this.entries();
    const k = entries.findIndex((e) => e.tabs.some((t) => t.id === id));
    const entry = entries[k];
    if (!entry) return;
    const rest = entries.filter((e) => e !== entry);
    const at = (position: number) => flatIndex(rest, position);
    const next = entries[k + step];
    const group = entry.lead.group;
    if (group !== undefined) return next?.lead.group === group ? { index: at(k + step) } : { index: at(k), group: null };
    if (!next) return;
    if (next.lead.group === undefined) return { index: at(k + step) };
    const span = rest.flatMap((e, i) => (e.lead.group === next.lead.group ? [i] : []));
    return { index: at(step > 0 ? span.at(-1)! + 1 : span[0]!) };
  }

  // タブ（分割なら、分割のタブをまとめて）を、一覧の index 番目（移すタブを除いた一覧での位置）へ移す（group を渡したときは、
  // そのグループに入れる・外す）。一覧の並びは自分の分割をまとめたものなので、送る位置は、全員で共有するタブの並びでの位置に直す
  // （一覧で直前にあるタブの後ろ）。続けて移したとき（Alt+↑ を 2 回など）に前の並びから位置を数えないよう、
  // サーバーから並びが届く前に手元の並びも変えておく。届いた並びで置き換わる
  private move(ids: string[], index: number, group?: string | null) {
    if (!this.state) return;
    const flat = this.entries().flatMap((e) => e.tabs).filter((t) => !ids.includes(t.id));
    const shared = this.state.tabs.filter((t) => !ids.includes(t.id));
    const moving = this.state.tabs.filter((t) => ids.includes(t.id));
    if (moving.length === 0 || index < 0 || index > flat.length) return;
    const to = index === 0 ? 0 : shared.indexOf(flat[index - 1]!) + 1;
    const moved = moving.map((found) => {
      const tab = { ...found };
      if (group === null) delete tab.group;
      else if (group !== undefined) tab.group = group;
      return tab;
    });
    const tabs = [...shared.slice(0, to), ...moved, ...shared.slice(to)];
    const groups = this.state.groups.filter((g) => tabs.some((t) => t.group === g.id));
    this.update({ ...this.state, tabs, groups });
    this.actions.moveTab(
      moving.map((t) => t.id),
      to,
      group,
    );
  }

  // グループのタブをまとめて、グループのタブを除いた一覧の index 番目へ移す。送る位置は、move と同じく共有の並びでの位置に直す
  private moveGroup(id: string, index: number) {
    if (!this.state) return;
    const flat = this.entries().flatMap((e) => e.tabs).filter((t) => t.group !== id);
    const members = this.state.tabs.filter((t) => t.group === id);
    const rest = this.state.tabs.filter((t) => t.group !== id);
    if (members.length === 0 || index < 0 || index > flat.length) return;
    const to = index === 0 ? 0 : rest.indexOf(flat[index - 1]!) + 1;
    this.update({ ...this.state, tabs: [...rest.slice(0, to), ...members, ...rest.slice(to)] });
    this.actions.moveGroup(id, to);
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
    if (target) this.move(this.blockOf(id), target.index, target.group);
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

  // dragged を target（項目かラベル）の前・後ろに落としたときの操作と、位置の線を出す要素（mark）と向き。落とせなければ undefined。
  // - タブ（分割なら分割のタブをまとめて）: 項目に重ねると、その項目と同じグループに入る（グループに入っていない項目なら、
  //   グループから外れる）。ラベルの前半ならグループの前（グループの外）、後半ならグループの先頭に入る
  // - グループ: グループは入れ子にできないので、ほかのグループの項目・ラベルに重ねたときは、そのグループの前・後ろに移す
  private dropPlan(dragged: DragSource, target: DragSource, place: Place) {
    const entries = this.entries();
    if (dragged.kind === target.kind && dragged.id === target.id) return;
    const entryOf = (id: string) => entries.find((e) => e.tabs[0]!.id === id);
    const targetEntry = target.kind === "tab" ? entryOf(target.id) : undefined;
    if (target.kind === "tab" && !targetEntry) return;
    const mark = `${target.kind}-${target.id}`;
    const span = (list: Entry<Tab>[], group: string | undefined) => list.flatMap((e, i) => (e.lead.group === group ? [i] : []));

    if (dragged.kind === "tab") {
      const entry = entryOf(dragged.id);
      if (!entry) return;
      const ids = entry.tabs.map((t) => t.id);
      const rest = entries.filter((e) => e !== entry);
      if (targetEntry) {
        const index = flatIndex(rest, rest.indexOf(targetEntry) + (place === "after" ? 1 : 0));
        return { mark, markPlace: place, apply: () => this.move(ids, index, targetEntry.lead.group ?? null) };
      }
      const first = span(rest, target.id)[0];
      if (first === undefined) return;
      const index = flatIndex(rest, first);
      return { mark, markPlace: place, apply: () => this.move(ids, index, place === "before" ? null : target.id) };
    }

    if (targetEntry?.lead.group === dragged.id) return;
    const rest = entries.filter((e) => e.lead.group !== dragged.id);
    const other = targetEntry ? targetEntry.lead.group : target.id;
    if (other === undefined) {
      const index = flatIndex(rest, rest.indexOf(targetEntry!) + (place === "after" ? 1 : 0));
      return { mark, markPlace: place, apply: () => this.moveGroup(dragged.id, index) };
    }
    const indices = span(rest, other);
    if (indices.length === 0) return;
    // ほかのグループのラベルに重ねたとき、またはタブの前半に重ねたときは、そのグループの前
    if (target.kind === "group" || place === "before") {
      const index = flatIndex(rest, indices[0]!);
      return { mark: `group-${other}`, markPlace: "before" as Place, apply: () => this.moveGroup(dragged.id, index) };
    }
    const last = indices.at(-1)!;
    const index = flatIndex(rest, last + 1);
    return { mark: `tab-${rest[last]!.tabs[0]!.id}`, markPlace: "after" as Place, apply: () => this.moveGroup(dragged.id, index) };
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

  // ドラッグしているのが、タブ 1 つ（分割していないタブ）なら、そのタブ。ターミナルの領域の端に落として分割表示を作るのに使う
  // （docs/adr/215-split-view.md）
  draggedTab() {
    if (this.dragged?.kind !== "tab") return;
    const block = this.blockOf(this.dragged.id);
    return block.length === 1 ? block[0] : undefined;
  }

  // ドラッグを終える（ターミナルの領域の端に落としたとき）
  finishDrag() {
    this.endDrag();
  }

  // 最後へ移す操作。すでに最後にあって、移しても変わらないときは undefined
  private dropAtEnd(dragged: DragSource) {
    const entries = this.entries();
    if (dragged.kind === "tab") {
      const entry = entries.find((e) => e.tabs[0]!.id === dragged.id);
      if (!entry || (entries.at(-1) === entry && entry.tabs.every((t) => t.group === undefined))) return;
      const ids = entry.tabs.map((t) => t.id);
      return () => this.move(ids, flatIndex(entries.filter((e) => e !== entry), entries.length - 1), null);
    }
    const rest = entries.filter((e) => e.lead.group !== dragged.id);
    if (entries.at(-1)?.lead.group === dragged.id) return;
    return () => this.moveGroup(dragged.id, flatIndex(rest, rest.length));
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

// 項目の並び（entries）の position 番目の前にあるタブの数。一覧での位置を、タブの数え方の位置に直す
function flatIndex(entries: Entry<Tab>[], position: number) {
  return entries.slice(0, position).reduce((n, e) => n + e.tabs.length, 0);
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
