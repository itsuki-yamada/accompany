// サイドメニュー。タブ（ターミナル 1 つが 1 つのタブ）の一覧を、状態・タイトル・フォーカスしている参加者とともに出す。
// 出す・隠すは参加者ごとで、ブラウザに覚えておく（docs/adr/72-sidebar.md）。隠している間は、ツールバーにタブを並べる
// （docs/adr/100-terminal-tabs.md）。タブはドラッグ、Alt+矢印、右クリックのメニューで並べ替えられ、並びは全員で共有する
// （docs/adr/139-tab-order.md）
import { showContextMenu } from "./context-menu";
import { statusDescriptions, statusLabels, type AgentStatus } from "./pane";
import { shortcutFor, withKeys } from "./shortcuts";

// サーバーから届く、タブの並び
export type Tab = { id: string; name: string };
type Member = { id: number; name: string; color: string; terminal?: string };

export type SidebarState = {
  tabs: Tab[];
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
  // タブを並びの index 番目（並べ替えたあとの位置）へ移す
  moveTab: (id: string, index: number) => void;
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
  // ドラッグしているタブ。ドラッグしている間は、組み直すとドラッグしている要素がなくなるので、届いた状態は手を離してから出す
  private dragged: string | undefined;
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
    if (this.dragged !== undefined) {
      this.deferred = state;
      return;
    }
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
      ...tabs.map((tab) => {
        const { id } = tab;
        const row = document.createElement("div");
        row.className = "tab-row";
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
        this.enableDrag(row, id, true);
        return row;
      }),
    );
  }

  // ツールバーのタブ。名前と状態、並べて表示・閉じるのボタンを出す
  private renderStrip(state: SidebarState) {
    this.stripTabs.replaceChildren(
      ...state.tabs.map((tab) => {
        const item = document.createElement("span");
        item.className = "toolbar-tab-item";
        const select = this.tabButton(tab, state);
        select.className = "toolbar-tab";
        const status = state.statuses[tab.id];
        if (status) item.dataset.status = status;
        select.textContent = tab.name;
        select.title = [state.titles[tab.id], status && statusLabels[status]].filter(Boolean).join(" ・ ");
        item.append(select, ...this.tabActions(tab, state));
        this.enableDrag(item, tab.id, false);
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
    return select;
  }

  // タブの右クリックのメニュー。サイドメニューでは上・下、ツールバーでは左・右へ移す。端のタブは、その向きへは移せない
  private openMenu(tab: Tab, x: number, y: number, vertical: boolean) {
    const tabs = this.state?.tabs ?? [];
    const index = tabs.findIndex((t) => t.id === tab.id);
    const [before, after] = vertical ? ["上へ移す", "下へ移す"] : ["左へ移す", "右へ移す"];
    showContextMenu(
      x,
      y,
      `${tab.name} のタブのメニュー`,
      [
        { label: before, disabled: index <= 0, action: () => this.move(tab.id, index - 1) },
        { label: after, disabled: index < 0 || index >= tabs.length - 1, action: () => this.move(tab.id, index + 1) },
      ],
      () => this.focusTab(tab.id),
    );
  }

  // タブを並びの index 番目へ移す。続けて移したとき（Alt+↑ を 2 回など）に前の並びから位置を数えないよう、
  // サーバーから並びが届く前に手元の並びも変えておく。届いた並びで置き換わる
  private move(id: string, index: number) {
    if (!this.state) return;
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    const moved = this.state.tabs.find((t) => t.id === id);
    if (!moved || index < 0 || index > tabs.length) return;
    tabs.splice(index, 0, moved);
    this.update({ ...this.state, tabs });
    this.actions.moveTab(id, index);
  }

  // 出ている方（サイドメニューかツールバー）のタブにキー入力の先を移す
  private focusTab(id: string) {
    const scope = this.visible ? this.element : this.strip;
    scope.querySelector<HTMLElement>(`[data-key="tab-${id}"]`)?.focus();
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
    const index = this.state.tabs.findIndex((t) => t.id === id) + step;
    if (index >= 0 && index < this.state.tabs.length) this.move(id, index);
    return true;
  }

  // タブの行（項目）をドラッグして並べ替えられるようにする。ほかのタブの前半に重ねるとその前、後半に重ねるとその後ろへ移し、
  // 移す位置に線を出す（data-drop）。ファイルやほかのページからのドラッグは受け付けない
  private enableDrag(element: HTMLElement, id: string, vertical: boolean) {
    element.draggable = true;
    const placeOf = (event: DragEvent) => {
      const rect = element.getBoundingClientRect();
      const first = vertical ? event.clientY - rect.top < rect.height / 2 : event.clientX - rect.left < rect.width / 2;
      return first ? "before" : "after";
    };
    element.addEventListener("dragstart", (event) => {
      this.dragged = id;
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
      this.clearDrop(element);
      if (this.dragged !== id) element.dataset.drop = placeOf(event);
    });
    element.addEventListener("dragleave", (event) => {
      if (!element.contains(event.relatedTarget as Node | null)) delete element.dataset.drop;
    });
    element.addEventListener("drop", (event) => {
      const dragged = this.dragged;
      if (dragged === undefined) return;
      event.preventDefault();
      const tabs = this.state?.tabs ?? [];
      const rest = tabs.map((t) => t.id).filter((t) => t !== dragged);
      const index = rest.indexOf(id) + (placeOf(event) === "after" ? 1 : 0);
      this.endDrag();
      if (dragged !== id && index >= 0) this.move(dragged, index);
    });
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
