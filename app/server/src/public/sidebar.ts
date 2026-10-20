// サイドメニュー。上に Workspace の一覧、下にすべての Workspace のセッション（ターミナル）の一覧を出す。
// 出す・隠すは参加者ごとで、ブラウザに覚えておく（docs/adr/72-sidebar.md）
import { statusDescriptions, statusLabels, type AgentStatus } from "./pane";
import { shortcutFor, withKeys } from "./shortcuts";

// サーバーから届く、Workspace（コード・メッセージの上では tab）の並びと配置
type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };
type Tab = { id: string; name: string; layout: Layout };
type Member = { id: number; name: string; color: string; terminal?: string };

export type SidebarState = {
  tabs: Tab[];
  active: string;
  titles: Record<string, string>;
  statuses: Record<string, AgentStatus>;
  members: Member[];
  you: number | undefined;
};

export type SidebarActions = {
  // keepFocus はキーボードで選んだとき。続けてセッションを選べるよう、キー入力の先をサイドメニューに残す
  selectWorkspace: (id: string, keepFocus: boolean) => void;
  newWorkspace: () => void;
  closeWorkspace: (id: string) => void;
  // そのターミナルの Workspace に切り替えて、そのターミナルにフォーカスする
  focusTerminal: (id: string) => void;
  // サイドメニューから、表示中のターミナルにキー入力の先を戻す
  returnFocus: () => void;
};

// エージェントの状態の表記は、ターミナルのバーと同じ（docs/adr/70-agent-detection.md、docs/adr/74-unseen-done.md）。
// statuses に含まれないターミナルではエージェントが動いていないので、状態を出さず、件数にも数えない
const storageKey = "accompany.sidebar";

export class Sidebar {
  // ツールバーに置く、出す・隠すのボタン
  readonly toggleButton = document.createElement("button");
  private workspaces = document.createElement("div");
  private sessions = document.createElement("section");
  private summary = document.createElement("span");
  private groups = document.createElement("div");
  private state: SidebarState | undefined;

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

    const workspaceHeader = header("Workspace");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "+";
    add.setAttribute("aria-label", "新しい Workspace");
    add.title = withKeys("新しい Workspace");
    add.addEventListener("click", () => actions.newWorkspace());
    workspaceHeader.append(add);
    this.workspaces.className = "sidebar-workspaces";
    this.workspaces.setAttribute("role", "tablist");
    this.workspaces.setAttribute("aria-orientation", "vertical");
    this.workspaces.setAttribute("aria-label", "Workspace");

    this.sessions.className = "sidebar-sessions";
    this.sessions.setAttribute("aria-label", "セッション");
    const sessionHeader = header("セッション");
    this.summary.className = "sidebar-summary";
    sessionHeader.append(this.summary);
    this.sessions.append(sessionHeader, this.groups);

    element.append(workspaceHeader, this.workspaces, this.sessions);
    element.addEventListener("keydown", (event) => this.onKeyDown(event));
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

  // サイドメニューへ移る。隠していれば出す。自分がフォーカスしているターミナルの行、なければ最初の行に移る
  focus() {
    if (!this.visible) {
      this.setVisible(true);
      saveVisible(true);
    }
    const mine = this.state?.members.find((m) => m.id === this.state?.you)?.terminal;
    const rows = this.groups.querySelectorAll<HTMLButtonElement>("button[data-terminal]");
    ([...rows].find((row) => row.dataset.terminal === mine) ?? rows[0])?.focus();
  }

  update(state: SidebarState) {
    this.state = state;
    // 組み直すとキー入力の先の行がなくなるので、どの行だったかを覚えておき、あとで戻す
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && this.element.contains(active) ? active.dataset.key : undefined;
    this.renderWorkspaces(state);
    this.renderSessions(state);
    if (focused) this.element.querySelector<HTMLElement>(`[data-key="${focused}"]`)?.focus();
  }

  private setVisible(visible: boolean) {
    this.element.hidden = !visible;
    this.toggleButton.setAttribute("aria-expanded", String(visible));
  }

  private renderWorkspaces({ tabs, active, statuses }: SidebarState) {
    this.workspaces.replaceChildren(
      ...tabs.map((tab) => {
        const row = document.createElement("div");
        row.className = "workspace-row";
        const select = document.createElement("button");
        select.type = "button";
        select.className = "workspace-select";
        select.textContent = tab.name;
        select.dataset.key = `workspace-${tab.id}`;
        select.dataset.nav = "";
        select.setAttribute("role", "tab");
        select.setAttribute("aria-selected", String(tab.id === active));
        // マウスで選んだときは表示したターミナルに、キーボード（click の detail が 0）で選んだときはサイドメニューに残る
        select.addEventListener("click", (event) => this.actions.selectWorkspace(tab.id, event.detail === 0));
        const close = document.createElement("button");
        close.type = "button";
        close.className = "workspace-close";
        close.textContent = "×";
        close.dataset.key = `close-${tab.id}`;
        close.setAttribute("aria-label", `${tab.name} を閉じる`);
        close.title = `${tab.name} を閉じる`;
        // 最後の Workspace は閉じられない
        close.disabled = tabs.length === 1;
        close.addEventListener("click", () => this.actions.closeWorkspace(tab.id));
        row.append(select, counts(agentStatuses(terminalIds(tab.layout), statuses)), close);
        return row;
      }),
    );
  }

  private renderSessions({ tabs, active, titles, statuses, members, you }: SidebarState) {
    const all = agentStatuses(tabs.flatMap((tab) => terminalIds(tab.layout)), statuses);
    this.summary.replaceChildren(counts(all));
    this.groups.replaceChildren(
      ...tabs.map((tab) => {
        const group = document.createElement("div");
        group.className = "session-group";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", tab.name);
        if (tab.id === active) group.dataset.active = "true";
        const name = document.createElement("div");
        name.className = "session-group-name";
        name.textContent = tab.name;
        group.append(name);
        for (const id of terminalIds(tab.layout)) {
          const status = statuses[id];
          const row = document.createElement("button");
          row.type = "button";
          row.className = "session";
          row.dataset.key = `terminal-${id}`;
          row.dataset.terminal = id;
          row.dataset.nav = "";
          row.setAttribute("aria-label", `ターミナル ${id}`);
          const viewers = members.filter((m) => m.terminal === id);
          if (viewers.some((m) => m.id === you)) row.dataset.focused = "true";
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
          label.textContent = `ターミナル ${id}`;
          line.append(label);
          row.append(line);
          const title = titles[id];
          if (title) {
            const program = document.createElement("span");
            program.className = "session-title";
            program.textContent = title;
            row.title = title;
            row.append(program);
          }
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
            row.append(list);
          }
          row.addEventListener("click", () => this.actions.focusTerminal(id));
          group.append(row);
        }
        return group;
      }),
    );
  }

  // ↑↓ で Workspace とセッションの行を順に移る。Esc でターミナルに戻る。
  // サイドメニューの中でも、出す・隠す（隠してターミナルに戻る）と、サイドメニューへ移る（ターミナルに戻る）のショートカットは効く
  private onKeyDown(event: KeyboardEvent) {
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

// エージェントが動いているターミナルの状態だけを取り出す
function agentStatuses(ids: string[], statuses: Record<string, AgentStatus>) {
  return ids.flatMap((id) => (statuses[id] ? [statuses[id]] : []));
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

function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
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
