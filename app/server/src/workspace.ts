import type { AgentStatus } from "./activity";
import { TerminalSession } from "./terminal";

// 画面の配置。分割の節は向き（row: 左右、column: 上下）と、1 つ目の子が占める割合を持つ
export type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

// 参加者。認証がまだないので、接続順に「参加者 N」と呼び、色を割り当てる
export type Member = { id: number; name: string; color: string; terminal?: string };

// タブ。それぞれが独立した分割の配置を持つ
export type Tab = { id: string; name: string; layout: Layout };

// 参加者に配るもの
export type WorkspaceEvent =
  | { type: "welcome"; you: number }
  | { type: "tabs"; tabs: Tab[]; active: string }
  | { type: "presence"; members: Member[] }
  // ターミナルごとの、コマンドが設定したタイトル（ターミナルの ID → タイトル。空のものは含めない）
  | { type: "titles"; titles: Record<string, string> }
  // ターミナルごとのエージェントの状態
  | { type: "status"; statuses: Record<string, AgentStatus> };
type Listener = (event: WorkspaceEvent) => void;

const colors = ["#4fc3f7", "#ffb74d", "#81c784", "#f06292", "#ba68c8", "#fff176"];

// 参加者全員で共有する、タブの並びと表示中のタブ、タブごとの分割の配置、ターミナルの一覧
export class Workspace {
  private terminals = new Map<string, TerminalSession>();
  private members = new Map<Listener, Member>();
  private nextMemberId = 1;
  // ターミナルとタブの番号は画面に出るので、分割の節とは別に数えて 1, 2, 3 と続ける
  private nextId = 1;
  private nextSplitId = 1;
  private nextTabId = 1;
  private titlesQueued = false;
  tabs: Tab[] = [];
  active: string;

  // 最初のターミナルは起動時のコマンド、分割や新しいタブで増やしたターミナルはシェルを起動する
  constructor(
    initialCommand: string[],
    private shellCommand: string[],
  ) {
    this.active = this.createTab(initialCommand).id;
  }

  terminal(id: string) {
    return this.terminals.get(id);
  }

  // 参加者として加わる。返り値でフォーカス先を伝えたり、抜けたりする
  join(listener: Listener) {
    const id = this.nextMemberId++;
    const member: Member = { id, name: `参加者 ${id}`, color: colors[(id - 1) % colors.length]! };
    this.members.set(listener, member);
    listener({ type: "welcome", you: id });
    listener(this.tabsEvent());
    listener(this.titlesEvent());
    listener({ type: "status", statuses: this.statuses() });
    this.notifyPresence();
    return {
      focus: (terminalId: string) => {
        member.terminal = terminalId;
        this.notifyPresence();
      },
      leave: () => {
        this.members.delete(listener);
        this.notifyPresence();
      },
    };
  }

  // 新しいタブはシェルのターミナル 1 つで始め、そのタブを表示する
  newTab() {
    this.active = this.createTab(this.shellCommand).id;
    this.notify();
  }

  selectTab(tabId: string) {
    if (!this.tabs.some((t) => t.id === tabId)) return;
    this.active = tabId;
    this.notify();
  }

  // タブを閉じ、そのタブのターミナルを終了する。最後の 1 つは閉じない
  closeTab(tabId: string) {
    const index = this.tabs.findIndex((t) => t.id === tabId);
    if (index < 0 || this.tabs.length === 1) return;
    const [tab] = this.tabs.splice(index, 1);
    for (const id of terminalIds(tab!.layout)) {
      this.terminals.get(id)?.kill();
      this.terminals.delete(id);
    }
    // 表示中のタブを閉じたときは、右隣（なければ左隣）のタブを表示する
    if (this.active === tabId) this.active = this.tabs[Math.min(index, this.tabs.length - 1)]!.id;
    this.notify();
  }

  split(terminalId: string, direction: "row" | "column") {
    const tab = this.tabOfTerminal(terminalId);
    const target = tab && findTerminal(tab.layout, terminalId);
    if (!tab || !target) return;
    const added = this.createTerminal(this.shellCommand);
    this.replace(tab, target, {
      type: "split",
      id: `split-${this.nextSplitId++}`,
      direction,
      ratio: 0.5,
      children: [target, added],
    });
  }

  close(terminalId: string) {
    const tab = this.tabOfTerminal(terminalId);
    if (!tab) return;
    // タブの最後の 1 つを閉じるときはタブごと閉じる。最後のタブの最後の 1 つは閉じない
    if (tab.layout.type === "terminal") return this.closeTab(tab.id);
    const parent = findParentOf(tab.layout, terminalId);
    if (!parent) return;
    const sibling = parent.children.find((c) => !(c.type === "terminal" && c.id === terminalId))!;
    this.terminals.get(terminalId)?.kill();
    this.terminals.delete(terminalId);
    this.replace(tab, parent, sibling);
  }

  resizeSplit(splitId: string, ratio: number) {
    const split = this.tabs.map((t) => findSplit(t.layout, splitId)).find((s) => s);
    if (!split) return;
    split.ratio = Math.min(0.9, Math.max(0.1, ratio));
    this.notify();
  }

  killAll() {
    this.terminals.forEach((t) => t.kill());
  }

  private createTab(command: string[]) {
    const id = String(this.nextTabId++);
    const tab: Tab = { id, name: `タブ ${id}`, layout: this.createTerminal(command) };
    this.tabs.push(tab);
    return tab;
  }

  private createTerminal(command: string[]): Layout {
    const id = String(this.nextId++);
    this.terminals.set(
      id,
      new TerminalSession(
        command,
        () => this.close(id),
        () => this.notifyTitles(),
        () => this.notifyStatus(),
      ),
    );
    return { type: "terminal", id };
  }

  private tabOfTerminal(terminalId: string) {
    return this.tabs.find((t) => findTerminal(t.layout, terminalId));
  }

  private replace(tab: Tab, target: Layout, replacement: Layout) {
    if (tab.layout === target) {
      tab.layout = replacement;
    } else {
      const parent = findParent(tab.layout, target);
      if (!parent) return;
      parent.children[parent.children.indexOf(target)] = replacement;
    }
    this.notify();
  }

  private tabsEvent(): WorkspaceEvent {
    return { type: "tabs", tabs: this.tabs, active: this.active };
  }

  private notify() {
    const event = this.tabsEvent();
    this.members.forEach((_, l) => l(event));
  }

  private titlesEvent(): WorkspaceEvent {
    const titles: Record<string, string> = {};
    this.terminals.forEach((terminal, id) => {
      if (terminal.title) titles[id] = terminal.title;
    });
    return { type: "titles", titles };
  }

  // タイトルは画面の配置とは別に配る。シェルのプロンプトなどで頻繁に変わるので、そのたびに配置を組み直さない。
  // 1 回の出力の中で何度も変わったときは、最後のタイトルだけを 1 回で配る
  private notifyTitles() {
    if (this.titlesQueued) return;
    this.titlesQueued = true;
    queueMicrotask(() => {
      this.titlesQueued = false;
      const event = this.titlesEvent();
      this.members.forEach((_, l) => l(event));
    });
  }

  private statuses() {
    return Object.fromEntries([...this.terminals].map(([id, t]) => [id, t.status]));
  }

  private notifyStatus() {
    const statuses = this.statuses();
    this.members.forEach((_, l) => l({ type: "status", statuses }));
  }

  private notifyPresence() {
    const members = [...this.members.values()];
    this.members.forEach((_, l) => l({ type: "presence", members }));
  }
}

type Split = Extract<Layout, { type: "split" }>;

function* walk(node: Layout): Generator<Layout> {
  yield node;
  if (node.type === "split") for (const child of node.children) yield* walk(child);
}

function findTerminal(root: Layout, id: string) {
  return [...walk(root)].find((n) => n.type === "terminal" && n.id === id);
}

function findSplit(root: Layout, id: string) {
  return [...walk(root)].find((n): n is Split => n.type === "split" && n.id === id);
}

function findParent(root: Layout, target: Layout) {
  return [...walk(root)].find((n): n is Split => n.type === "split" && n.children.includes(target));
}

function findParentOf(root: Layout, terminalId: string) {
  const target = findTerminal(root, terminalId);
  return target && findParent(root, target);
}

function terminalIds(root: Layout) {
  return [...walk(root)].flatMap((n) => (n.type === "terminal" ? [n.id] : []));
}
