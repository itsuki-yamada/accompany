import type { AgentStatus } from "./activity";
import { defaultMinWindow, type WindowSize } from "./min-window";
import { maxQuickCommands, type QuickCommand, type QuickCommandInput } from "./quick-commands";
import type { SavedSession, SavedTerminal } from "./session-store";
import { type Restored, TerminalSession } from "./terminal";

// 画面の配置。分割の節は向き（row: 左右、column: 上下）と、1 つ目の子が占める割合を持つ
export type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

// ターミナルの選択範囲。位置は列と、出力の始めからの行の番号（バッファの行に、スクロールバックから押し出された行の数を足したもの。
// 代替画面ではバッファの行）。end の列は含まない
export type Position = { x: number; y: number };
export type SelectionRange = { start: Position; end: Position };

// 参加者。認証がまだないので、接続順に「参加者 N」と呼び、色を割り当てる。
// selections は、ターミナルごとの、その参加者が選択している範囲（docs/adr/94-remote-selection.md）。
// following はペアプロモードで追従している参加者、scroll はフォーカス先のターミナルのスクロール位置
// （一番下から何行戻しているか）。scroll は追従されているあいだだけ届く（docs/adr/93-pair-mode.md）
export type Member = {
  id: number;
  name: string;
  color: string;
  terminal?: string;
  selections: Record<string, SelectionRange>;
  following?: number;
  scroll?: { terminal: string; offset: number };
};

// タブ。それぞれが独立した分割の配置を持つ
export type Tab = { id: string; name: string; layout: Layout };

// 参加者に配るもの
export type WorkspaceEvent =
  | { type: "welcome"; you: number }
  | { type: "tabs"; tabs: Tab[]; active: string }
  | { type: "presence"; members: Member[] }
  // ターミナルごとの、コマンドが設定したタイトル（ターミナルの ID → タイトル。空のものは含めない）
  | { type: "titles"; titles: Record<string, string> }
  // ターミナルごとのエージェントの状態。エージェントが前面で動いているターミナルだけを含める。
  // 作業が終わってまだ誰も見ていないものは done（docs/adr/74-unseen-done.md）
  | { type: "status"; statuses: Record<string, AgentStatus> }
  // 参加者全員で共有する、よく使うコマンドの一覧
  | { type: "commands"; commands: QuickCommand[] }
  // 端末の大きさの下限（ウィンドウの大きさ。docs/adr/99-smallest-size.md）
  | ({ type: "min-window" } & WindowSize);
type Listener = (event: WorkspaceEvent) => void;

const colors = ["#4fc3f7", "#ffb74d", "#81c784", "#f06292", "#ba68c8", "#fff176"];

// 参加者全員で共有する、タブの並びと表示中のタブ、タブごとの分割の配置、ターミナルの一覧
export class Workspace {
  private terminals = new Map<string, TerminalSession>();
  private members = new Map<Listener, Member>();
  // ページが見えている参加者。フォーカス先と合わせて、未確認を消すか決める（docs/adr/74-unseen-done.md）
  private visibleMembers = new Set<Member>();
  private nextMemberId = 1;
  // ターミナルとタブの番号は画面に出るので、分割の節とは別に数えて 1, 2, 3 と続ける
  private nextId = 1;
  private nextSplitId = 1;
  private nextTabId = 1;
  private titlesQueued = false;
  private nextCommandId = 1;
  // 起動時のコマンドを動かしているターミナル
  private initialTerminal: string | undefined;
  commands: QuickCommand[] = [];
  // 端末の大きさの下限。参加者全員に効く設定（docs/adr/99-smallest-size.md）
  minWindow: WindowSize;
  tabs: Tab[] = [];
  active: string;
  // 保存すべき変化（配置・出力・よく使うコマンド）があったときに呼ぶ
  onChange: () => void = () => {};

  // 最初のターミナルは起動時のコマンド、分割や新しいタブで増やしたターミナルはシェルを起動する。
  // 保存したもの（saved）があれば、配置とスクロールバックを戻す。戻したターミナルはシェルを新しく起動し、
  // 起動時のコマンドを動かしていたターミナルだけは、今回の起動時のコマンドを動かす。
  // 起動時のコマンドが指定されていて（initialCommand）、そのターミナルを閉じていたときは、新しいタブで動かす。
  // initialCommand を省略したときは、起動時のコマンドもシェルにする。
  // 端末の大きさの下限は、起動オプション（minWindow）、保存したもの、既定の順に使う
  constructor(
    initialCommand: string[] | undefined,
    private shellCommand: string[],
    saved?: SavedSession,
    minWindow?: WindowSize,
  ) {
    this.minWindow = minWindow ?? saved?.minWindow ?? defaultMinWindow;
    if (!saved) {
      const tab = this.createTab(initialCommand ?? shellCommand);
      this.active = tab.id;
      this.initialTerminal = terminalIds(tab.layout)[0];
      return;
    }
    for (const { id, layout } of saved.tabs) {
      for (const node of walk(layout)) {
        if (node.type === "split") continue;
        const restored: SavedTerminal = saved.terminals[node.id]!;
        if (restored.initial) this.initialTerminal = node.id;
        this.addTerminal(node.id, restored.initial ? (initialCommand ?? shellCommand) : shellCommand, restored);
      }
      this.tabs.push({ id, name: `Workspace ${id}`, layout });
    }
    this.active = saved.active;
    this.commands = saved.commands;
    const next = (ids: string[]) => Math.max(0, ...ids.map((id) => Number(id.replace(/^split-/, "")))) + 1;
    this.nextId = next([...this.terminals.keys()]);
    this.nextTabId = next(this.tabs.map((t) => t.id));
    this.nextSplitId = next(this.tabs.flatMap((t) => [...walk(t.layout)].filter((n) => n.type === "split").map((n) => n.id)));
    this.nextCommandId = next(this.commands.map((c) => c.id));
    // 指定した起動時のコマンドがどこでも動かないと、起動時の引数が無視されたように見える（docs/adr/34-session-restore.md）
    if (initialCommand && !this.initialTerminal) {
      const tab = this.createTab(initialCommand);
      this.active = tab.id;
      this.initialTerminal = terminalIds(tab.layout)[0];
    }
  }

  // 保存するために、配置とターミナルごとの画面、よく使うコマンドを書き出す
  async snapshot(cwd: string): Promise<SavedSession> {
    const terminals: Record<string, SavedTerminal> = {};
    await Promise.all(
      [...this.terminals].map(async ([id, t]) => {
        terminals[id] = { ...(await t.snapshot()), initial: id === this.initialTerminal };
      }),
    );
    return {
      version: 1,
      cwd,
      tabs: this.tabs.map(({ id, layout }) => ({ id, layout })),
      active: this.active,
      terminals,
      commands: this.commands,
      minWindow: this.minWindow,
    };
  }

  terminal(id: string) {
    return this.terminals.get(id);
  }

  // 参加者として加わる。返り値でフォーカス先を伝えたり、抜けたりする
  join(listener: Listener) {
    const id = this.nextMemberId++;
    const member: Member = { id, name: `参加者 ${id}`, color: colors[(id - 1) % colors.length]!, selections: {} };
    this.members.set(listener, member);
    listener({ type: "welcome", you: id });
    listener(this.tabsEvent());
    listener(this.titlesEvent());
    listener({ type: "status", statuses: this.statuses() });
    listener(this.commandsEvent());
    listener(this.minWindowEvent());
    this.notifyPresence();
    return {
      focus: (terminalId: string) => {
        member.terminal = terminalId;
        this.notifyPresence();
        this.updateSeen();
      },
      // ページが見えているか。参加したときは、届くまで見えていないとみなす
      visible: (visible: boolean) => {
        if (visible) this.visibleMembers.add(member);
        else this.visibleMembers.delete(member);
        this.updateSeen();
      },
      // ターミナルでの選択範囲を、ほかの参加者にも見せる。range がなければ選択をやめた
      // （閉じたターミナルの選択も、ブラウザがやめたと伝えてくるので消す）
      select: (terminalId: string, range: SelectionRange | undefined) => {
        if (range && this.terminals.has(terminalId)) member.selections[terminalId] = range;
        else if (!range && Object.hasOwn(member.selections, terminalId)) delete member.selections[terminalId];
        else return;
        this.notifyPresence();
      },
      // ペアプロモードで追従する参加者を変える。自分といない参加者は追従できないので、やめたものとする
      follow: (memberId: number | undefined) => {
        const target = [...this.members.values()].find((m) => m.id === memberId && m !== member);
        if (member.following === target?.id) return;
        const previous = member.following;
        member.following = target?.id;
        this.forgetScroll(previous);
        this.notifyPresence();
      },
      scroll: (terminalId: string, offset: number) => {
        if (member.scroll?.terminal === terminalId && member.scroll.offset === offset) return;
        member.scroll = { terminal: terminalId, offset };
        this.notifyPresence();
      },
      // 抜けた参加者に追従していた人は、ペアプロモードをやめたものとする
      leave: () => {
        this.members.delete(listener);
        this.visibleMembers.delete(member);
        this.members.forEach((m) => {
          if (m.following === member.id) m.following = undefined;
        });
        this.forgetScroll(member.following);
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
    for (const id of terminalIds(tab!.layout)) this.removeTerminal(id);
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
    this.removeTerminal(terminalId);
    this.replace(tab, parent, sibling);
  }

  resizeSplit(splitId: string, ratio: number) {
    const split = this.tabs.map((t) => findSplit(t.layout, splitId)).find((s) => s);
    if (!split) return;
    split.ratio = Math.min(0.9, Math.max(0.1, ratio));
    this.notify();
  }

  // よく使うコマンドの登録・編集・削除。変わるたびに一覧を全員に配る
  addCommand(command: QuickCommandInput) {
    if (this.commands.length >= maxQuickCommands) return;
    this.commands.push({ id: String(this.nextCommandId++), ...command });
    this.notifyCommands();
  }

  updateCommand(id: string, command: QuickCommandInput) {
    const index = this.commands.findIndex((c) => c.id === id);
    if (index < 0) return;
    this.commands[index] = { id, ...command };
    this.notifyCommands();
  }

  removeCommand(id: string) {
    const before = this.commands.length;
    this.commands = this.commands.filter((c) => c.id !== id);
    if (this.commands.length !== before) this.notifyCommands();
  }

  // 端末の大きさの下限を変え、全員に配る。各ブラウザが列数・行数に直して、ターミナルに伝え直す
  setMinWindow(minWindow: WindowSize) {
    if (minWindow.width === this.minWindow.width && minWindow.height === this.minWindow.height) return;
    this.minWindow = minWindow;
    const event = this.minWindowEvent();
    this.members.forEach((_, l) => l(event));
    this.onChange();
  }

  killAll() {
    this.terminals.forEach((t) => t.kill());
  }

  private createTab(command: string[]) {
    const id = String(this.nextTabId++);
    const tab: Tab = { id, name: `Workspace ${id}`, layout: this.createTerminal(command) };
    this.tabs.push(tab);
    return tab;
  }

  private createTerminal(command: string[]): Layout {
    const id = String(this.nextId++);
    this.addTerminal(id, command);
    return { type: "terminal", id };
  }

  private addTerminal(id: string, command: string[], restored?: Restored) {
    this.terminals.set(
      id,
      new TerminalSession(
        command,
        () => this.close(id),
        () => this.notifyTitles(),
        () => this.notifyStatus(),
        { restored, onOutput: () => this.onChange() },
      ),
    );
  }

  // ターミナルを終了し、参加者がそのターミナルで選択していた範囲も消す。ブラウザもターミナルを抜けたときに
  // 選択をやめたと伝えてくるが、伝え返さない参加者の分が残らないように、ここでも消す
  private removeTerminal(id: string) {
    this.terminals.get(id)?.kill();
    this.terminals.delete(id);
    let changed = false;
    for (const member of this.members.values()) {
      if (!Object.hasOwn(member.selections, id)) continue;
      delete member.selections[id];
      changed = true;
    }
    if (changed) this.notifyPresence();
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
    this.onChange();
    // 表示中のタブが変わると、見ているターミナルも変わる
    this.updateSeen();
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
    const statuses: Record<string, AgentStatus> = {};
    this.terminals.forEach((terminal, id) => {
      if (terminal.status) statuses[id] = terminal.status;
    });
    return statuses;
  }

  // 作業が終わったときに見ている人がいれば、未確認にしないで配る
  private notifyStatus() {
    this.clearSeen();
    const statuses = this.statuses();
    this.members.forEach((_, l) => l({ type: "status", statuses }));
  }

  private updateSeen() {
    if (this.clearSeen()) this.notifyStatus();
  }

  // 誰か 1 人でも見ているターミナルの未確認を消す。見ている = 表示中のタブにあり、その参加者がフォーカスしていて、
  // ページが見えている。消したものがあれば true
  private clearSeen() {
    const tab = this.tabs.find((t) => t.id === this.active);
    const shown = new Set(tab ? terminalIds(tab.layout) : []);
    let changed = false;
    for (const member of this.visibleMembers) {
      const id = member.terminal;
      if (id && shown.has(id) && this.terminals.get(id)?.markSeen()) changed = true;
    }
    return changed;
  }

  private commandsEvent(): WorkspaceEvent {
    return { type: "commands", commands: this.commands };
  }

  private minWindowEvent(): WorkspaceEvent {
    return { type: "min-window", ...this.minWindow };
  }

  private notifyCommands() {
    const event = this.commandsEvent();
    this.members.forEach((_, l) => l(event));
    this.onChange();
  }

  // 誰にも追従されなくなった参加者のスクロール位置は古くなるので消す。残すと、次に追従し始めた人が、
  // いまの位置が届くまでの間、古い位置へ一瞬飛ぶ
  private forgetScroll(memberId: number | undefined) {
    const members = [...this.members.values()];
    const target = members.find((m) => m.id === memberId);
    if (target && !members.some((m) => m.following === memberId)) target.scroll = undefined;
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
