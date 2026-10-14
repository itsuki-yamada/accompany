import { TerminalSession } from "./terminal";

// 画面の配置。分割の節は向き（row: 左右、column: 上下）と、1 つ目の子が占める割合を持つ
export type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

type Listener = (layout: Layout) => void;

// 参加者全員で共有する、分割の配置とターミナルの一覧
export class Workspace {
  private terminals = new Map<string, TerminalSession>();
  private listeners = new Set<Listener>();
  private nextId = 1;
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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.layout);
    return () => this.listeners.delete(listener);
  }

  split(terminalId: string, direction: "row" | "column") {
    const target = findTerminal(this.layout, terminalId);
    if (!target) return;
    const added = this.createTerminal(this.shellCommand);
    this.replace(target, {
      type: "split",
      id: `split-${this.nextId++}`,
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
    this.listeners.forEach((l) => l(this.layout));
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
