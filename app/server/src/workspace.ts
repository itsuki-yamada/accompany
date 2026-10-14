import { TerminalSession } from "./terminal";

// 画面の配置。分割の節は向き（row: 左右、column: 上下）と、1 つ目の子が占める割合を持つ
export type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

// 参加者。認証がまだないので、接続順に「参加者 N」と呼び、色を割り当てる
export type Member = { id: number; name: string; color: string; terminal?: string };

// 参加者に配るもの
export type WorkspaceEvent =
  | { type: "welcome"; you: number }
  | { type: "layout"; layout: Layout }
  | { type: "presence"; members: Member[] };
type Listener = (event: WorkspaceEvent) => void;

const colors = ["#4fc3f7", "#ffb74d", "#81c784", "#f06292", "#ba68c8", "#fff176"];

// 参加者全員で共有する、分割の配置とターミナルの一覧
export class Workspace {
  private terminals = new Map<string, TerminalSession>();
  private members = new Map<Listener, Member>();
  private nextMemberId = 1;
  // ターミナルの番号は画面に出るので、分割の節とは別に数えて 1, 2, 3 と続ける
  private nextId = 1;
  private nextSplitId = 1;
  layout: Layout;

  // 最初のターミナルは起動時のコマンド、分割で増やしたターミナルはシェルを起動する
  constructor(
    initialCommand: string[],
    private shellCommand: string[],
  ) {
    this.layout = this.createTerminal(initialCommand);
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
    listener({ type: "layout", layout: this.layout });
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

  split(terminalId: string, direction: "row" | "column") {
    const target = findTerminal(this.layout, terminalId);
    if (!target) return;
    const added = this.createTerminal(this.shellCommand);
    this.replace(target, {
      type: "split",
      id: `split-${this.nextSplitId++}`,
      direction,
      ratio: 0.5,
      children: [target, added],
    });
  }

  close(terminalId: string) {
    // 最後の 1 つは閉じない
    if (this.layout.type === "terminal") return;
    const parent = findParentOf(this.layout, terminalId);
    if (!parent) return;
    const sibling = parent.children.find((c) => !(c.type === "terminal" && c.id === terminalId))!;
    this.terminals.get(terminalId)?.kill();
    this.terminals.delete(terminalId);
    this.replace(parent, sibling);
  }

  resizeSplit(splitId: string, ratio: number) {
    const split = findSplit(this.layout, splitId);
    if (!split) return;
    split.ratio = Math.min(0.9, Math.max(0.1, ratio));
    this.notify();
  }

  killAll() {
    this.terminals.forEach((t) => t.kill());
  }

  private createTerminal(command: string[]): Layout {
    const id = String(this.nextId++);
    this.terminals.set(id, new TerminalSession(command, () => this.close(id)));
    return { type: "terminal", id };
  }

  private replace(target: Layout, replacement: Layout) {
    if (this.layout === target) {
      this.layout = replacement;
    } else {
      const parent = findParent(this.layout, target);
      if (!parent) return;
      parent.children[parent.children.indexOf(target)] = replacement;
    }
    this.notify();
  }

  private notify() {
    this.members.forEach((_, l) => l({ type: "layout", layout: this.layout }));
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
