import type { AgentStatus } from "./activity";
import { defaultMinWindow, type WindowSize } from "./min-window";
import { nameKey } from "./member-name";
import { maxQuickCommands, type QuickCommand, type QuickCommandInput } from "./quick-commands";
import type { SavedSession, SavedTerminal } from "./session-store";
import { groupColors, isGroupColor, type GroupColor } from "./tab-groups";
import { type Restored, TerminalSession } from "./terminal";

// 参加者ごとの表示。並べているタブ（ターミナル）を葉に持つ分割の木で、節は向き（row: 左右、column: 上下）と、
// 1 つ目の子が占める割合を持つ（docs/adr/100-terminal-tabs.md）
export type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

// 1 人が並べられるタブの数
export const maxPanes = 3;

// 参加者ごとの表示。layout はいま出している表示（タブ 1 つか、分割）。splits は、いまは出していない分割で、
// 分割のタブを選ぶとそのまま（並び・向き・割合）戻す。1 つのタブが入る分割は 1 つ（docs/adr/215-split-view.md）
export type Display = { layout: Layout; splits: Layout[] };

// 分割を作るときに、タブを置く端（ターミナルの領域の左・右・下）
export type Edge = "left" | "right" | "bottom";

// ターミナルの選択範囲。位置は列と、出力の始めからの行の番号（バッファの行に、スクロールバックから押し出された行の数を足したもの。
// 代替画面ではバッファの行）。end の列は含まない
export type Position = { x: number; y: number };
export type SelectionRange = { start: Position; end: Position };

// 参加者。認証がまだないので、接続順に番号を振り、色を割り当てる。name は画面に出す名前で、参加者が設定した名前、
// 設定していなければ「参加者 N」。ほかの参加者と同じ名前なら「名前（参加者 N）」にする（docs/adr/96-member-name.md）。
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

// タブ。ターミナル 1 つが 1 つのタブで、id はターミナルの ID。name は画面に出す名前で、参加者が付けた名前（custom）、
// 付けていなければ「ターミナル N」。付けた名前がほかのタブと見分けにくいときは「名前（ターミナル N）」にする
// （docs/adr/110-tab-name.md）
// group は、タブが入っているグループの ID（docs/adr/209-tab-groups.md）
export type Tab = { id: string; name: string; custom?: string; group?: string };

// タブのグループ。name は画面に出す名前で、参加者が付けた名前（custom）、付けていなければ「グループ N」。
// グループのタブは、タブの並びの中で必ず続けて並ぶ。グループの並びは、タブの並びの中での位置で決まる
export type Group = { id: string; name: string; custom?: string; color: GroupColor };

// 参加者に配るもの
export type WorkspaceEvent =
  | { type: "welcome"; you: number }
  // タブの並びと、タブのグループ（タブの並びの中で現れる順）。全員に配る
  | { type: "tabs"; tabs: Tab[]; groups: Group[] }
  // その参加者の表示と、いまは出していない分割。本人にだけ配る
  | { type: "view"; layout: Layout; splits: Layout[] }
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

// 参加者全員で共有する、タブ（ターミナル）の並びと、参加者ごとの表示（どのタブをどう並べているか）
export class Workspace {
  private terminals = new Map<string, TerminalSession>();
  // タブの並び（ターミナルの ID）。開いた順に後ろへ足し、参加者が並べ替える（docs/adr/139-tab-order.md）
  private order: string[] = [];
  // 参加者が付けたタブの名前（整えたもの）。付けていないタブは含めない（docs/adr/110-tab-name.md）
  private tabNames = new Map<string, string>();
  // タブのグループ（名前は付けたものだけ）と、タブ（ターミナルの ID）→ 入っているグループの ID（docs/adr/209-tab-groups.md）
  private groups = new Map<string, { name?: string; color: GroupColor }>();
  private tabGroups = new Map<string, string>();
  private nextGroupId = 1;
  private members = new Map<Listener, Member>();
  // 参加者ごとの表示
  private views = new Map<Member, Display>();
  // 参加者が設定した名前（整えたもの）。設定していない参加者は含めない
  private chosenNames = new Map<Member, string>();
  // ページが見えている参加者。フォーカス先と合わせて、未確認を消すか決める（docs/adr/74-unseen-done.md）
  private visibleMembers = new Set<Member>();
  private nextMemberId = 1;
  // ターミナルの番号は画面に出るので、分割の節とは別に数えて 1, 2, 3 と続ける
  private nextId = 1;
  private nextSplitId = 1;
  private titlesQueued = false;
  private nextCommandId = 1;
  // 止めている最中（killAll のあと）。コマンドが終わってもタブを閉じず、並びを変えない（docs/adr/197-sighup-on-close.md）
  private stopping = false;
  // 起動時のコマンドを動かしているターミナル
  private initialTerminal: string | undefined;
  commands: QuickCommand[] = [];
  // 端末の大きさの下限。参加者全員に効く設定（docs/adr/99-smallest-size.md）
  minWindow: WindowSize;
  // 保存する下限。起動オプションで渡した下限はその起動のあいだだけ使い、保存しない。設定の画面で変えたものは保存する
  private savedMinWindow: WindowSize | undefined;
  // 保存すべき変化（タブ・出力・よく使うコマンド）があったときに呼ぶ
  onChange: () => void = () => {};

  // 最初のターミナルは起動時のコマンド、新しいタブや分割で増やしたターミナルはシェルを起動する。
  // 保存したもの（saved）があれば、タブの並びとスクロールバックを戻す。戻したターミナルはシェルを新しく起動し、
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
    this.savedMinWindow = saved?.minWindow;
    this.minWindow = minWindow ?? saved?.minWindow ?? defaultMinWindow;
    if (!saved) {
      this.initialTerminal = this.createTerminal(initialCommand ?? shellCommand);
      return;
    }
    for (const id of saved.tabs) {
      const restored: SavedTerminal = saved.terminals[id]!;
      if (restored.initial) this.initialTerminal = id;
      // 戻したシェルは保存したディレクトリで始める。起動時のコマンドを指定したときは、そのコマンドは起動したディレクトリで動かす
      // （docs/adr/151-restore-cwd.md）
      const runsInitial = restored.initial && initialCommand !== undefined;
      this.addTerminal(id, runsInitial ? initialCommand : shellCommand, restored, runsInitial ? undefined : restored.cwd);
    }
    for (const [id, name] of Object.entries(saved.names ?? {})) this.tabNames.set(id, name);
    for (const group of saved.groups ?? []) {
      this.groups.set(group.id, { color: group.color, ...(group.name !== undefined && { name: group.name }) });
      for (const tab of group.tabs) this.tabGroups.set(tab, group.id);
    }
    this.nextGroupId = Math.max(0, ...[...this.groups.keys()].map(Number)) + 1;
    this.normalizeGroups();
    this.commands = saved.commands;
    const next = (ids: string[]) => Math.max(0, ...ids.map(Number)) + 1;
    this.nextId = next(this.order);
    this.nextCommandId = next(this.commands.map((c) => c.id));
    // 指定した起動時のコマンドがどこでも動かないと、起動時の引数が無視されたように見える（docs/adr/34-session-restore.md）
    if (initialCommand && !this.initialTerminal) this.initialTerminal = this.createTerminal(initialCommand);
  }

  // 保存するために、タブの並びとターミナルごとの画面とカレントディレクトリ、よく使うコマンドを書き出す。参加者ごとの表示は保存しない。
  // refreshCwd は止めるときの保存で、カレントディレクトリを必ず調べ直す（docs/adr/151-restore-cwd.md）
  async snapshot(cwd: string, { refreshCwd = false } = {}): Promise<SavedSession> {
    const terminals: Record<string, SavedTerminal> = {};
    await Promise.all(
      [...this.terminals].map(async ([id, t]) => {
        const [screen, dir] = await Promise.all([t.snapshot(), t.savedCwd({ refresh: refreshCwd })]);
        terminals[id] = { ...screen, initial: id === this.initialTerminal, ...(dir && { cwd: dir }) };
      }),
    );
    return {
      version: 2,
      cwd,
      tabs: [...this.order],
      names: Object.fromEntries(this.tabNames),
      groups: [...this.groups].map(([id, { name, color }]) => ({
        id,
        ...(name !== undefined && { name }),
        color,
        tabs: this.order.filter((tab) => this.tabGroups.get(tab) === id),
      })),
      terminals,
      commands: this.commands,
      ...(this.savedMinWindow && { minWindow: this.savedMinWindow }),
    };
  }

  terminal(id: string) {
    return this.terminals.get(id);
  }

  // 参加者として加わる。最初は、起動時のコマンドを動かしているタブ（閉じていれば最初のタブ）だけを表示する。
  // 返り値で、自分の表示を変えたり、フォーカス先を伝えたり、抜けたりする
  join(listener: Listener) {
    const id = this.nextMemberId++;
    const member: Member = { id, name: defaultName(id), color: colors[(id - 1) % colors.length]!, selections: {} };
    this.members.set(listener, member);
    const first = this.initialTerminal && this.terminals.has(this.initialTerminal) ? this.initialTerminal : this.order[0]!;
    this.views.set(member, { layout: leaf(first), splits: [] });
    listener({ type: "welcome", you: id });
    listener(this.tabsEvent());
    listener(viewEvent(this.views.get(member)!));
    listener(this.titlesEvent());
    listener({ type: "status", statuses: this.statuses() });
    listener(this.commandsEvent());
    listener(this.minWindowEvent());
    this.notifyPresence();
    return {
      // 新しいタブを開いて、それだけを表示する。キーボードショートカットではキー入力の先のターミナル（terminalId）を、
      // それ以外では最後にフォーカスしたターミナルを、自分がフォーカスしているターミナルとする。
      // シェルはそのターミナルのカレントディレクトリで始め、ターミナルがない・分からないときは Accompany を起動したディレクトリで
      // 始める（docs/adr/109-inherit-cwd.md）
      newTab: async (terminalId?: string) => {
        const from = terminalId ?? member.terminal;
        const cwd = from === undefined ? undefined : await this.terminals.get(from)?.cwd();
        if (!this.views.has(member)) return;
        const added = this.createTerminal(this.shellCommand, cwd);
        this.notifyTabs();
        this.changeView(member, (display) => ({ layout: leaf(added), splits: parked(display) }));
      },
      // 新しいタブを開いて、terminalId のターミナルの右（row）・下（column）に並べる。並べられる数を超えるときは何もしない。
      // 分割したシェルは、分割元のターミナルのカレントディレクトリで始める（docs/adr/109-inherit-cwd.md）
      split: async (terminalId: string, direction: "row" | "column") => {
        if (!this.canAdd(member)) return;
        const cwd = await this.terminals.get(terminalId)?.cwd();
        // 調べている間に、表示が変わったり抜けたりしていることがあるので、調べたあとに確かめ直す
        if (!this.canAdd(member)) return;
        const added = this.createTerminal(this.shellCommand, cwd);
        this.notifyTabs();
        const changed = this.changeView(member, (display) => ({
          ...display,
          layout: this.placeBeside(display.layout, leaf(added), terminalId, direction),
        }));
        if (changed) this.gather(changed.layout, added);
      },
      // タブを選ぶ。いまの表示にあるタブなら変えない（ブラウザがそのタブにフォーカスする）。しまってある分割のタブなら、
      // その分割をそのまま出す。どの分割にも入っていないタブなら、そのタブだけを出す。いま出している分割はしまっておく
      // （docs/adr/215-split-view.md）
      selectTab: (tabId: string) => {
        if (!this.terminals.has(tabId)) return;
        this.changeView(member, (display) => {
          if (terminalIds(display.layout).includes(tabId)) return undefined;
          const split = display.splits.find((s) => terminalIds(s).includes(tabId));
          const rest = parked(display).filter((s) => s !== split);
          return { layout: split ?? leaf(tabId), splits: rest };
        });
      },
      // 開いているタブを、いまの表示に加えて分割にする。edge を渡したときは、表示全体の左・右・下に置く（タブを端へドラッグしたとき）。
      // 渡さないときは、terminalId のターミナルの右に置く（terminalId を表示していなければ全体の右）。
      // ほかの分割に入っていたタブは、その分割から抜ける（残りが 1 つになった分割はなくなる）
      addToView: (tabId: string, terminalId?: string, edge?: Edge) => {
        if (!this.terminals.has(tabId) || !this.canAdd(member)) return;
        const changed = this.changeView(member, (display) => {
          if (terminalIds(display.layout).includes(tabId)) return undefined;
          const layout = edge
            ? placeAtEdge(display.layout, leaf(tabId), edge, `split-${this.nextSplitId++}`)
            : this.placeBeside(display.layout, leaf(tabId), terminalId, "row");
          return { layout, splits: withoutTab(display.splits, tabId) };
        });
        if (changed) this.gather(changed.layout, tabId);
      },
      // 並べているタブを外す。表示しているタブが 1 つのときは外さない
      removeFromView: (tabId: string) => {
        this.changeView(member, (display) => {
          const ids = terminalIds(display.layout);
          return ids.length > 1 && ids.includes(tabId) ? { ...display, layout: removeLeaf(display.layout, tabId)! } : undefined;
        });
      },
      // タブが入っている分割を解除し、ふつうのタブに戻す。いま出している分割なら、自分がフォーカスしているタブ
      // （分割の中になければ、選んだタブ）だけを出す
      separate: (tabId: string) => {
        this.changeView(member, (display) => {
          const shown = terminalIds(display.layout);
          if (shown.includes(tabId)) {
            if (shown.length < 2) return undefined;
            const keep = member.terminal !== undefined && shown.includes(member.terminal) ? member.terminal : tabId;
            return { ...display, layout: leaf(keep) };
          }
          const split = display.splits.find((s) => terminalIds(s).includes(tabId));
          return split ? { ...display, splits: display.splits.filter((s) => s !== split) } : undefined;
        });
      },
      resizeSplit: (splitId: string, ratio: number) => {
        this.changeView(member, (display) =>
          mapLayouts(display, (view) =>
            findSplit(view, splitId) ? withRatio(view, splitId, Math.min(0.9, Math.max(0.1, ratio))) : undefined,
          ),
        );
      },
      // 並べている 2 つのタブの位置を入れ替える。どちらも自分の表示にあり、別のタブのときだけ（docs/adr/163-rearrange-panes.md）
      swapPanes: (tabId: string, otherId: string) => {
        const changed = this.changeView(member, (display) =>
          mapLayouts(display, (view) => {
            const ids = terminalIds(view);
            return tabId !== otherId && ids.includes(tabId) && ids.includes(otherId) ? swapLeaves(view, tabId, otherId) : undefined;
          }),
        );
        if (changed) this.gatherSplitOf(changed, (view) => terminalIds(view).includes(tabId));
      },
      // 分割の 2 つの子（左右・上下）を入れ替える。大きさも一緒に動く。しまってある分割にも効く（タブの右クリックのメニュー）
      flipSplit: (splitId: string) => {
        const changed = this.changeView(member, (display) =>
          mapLayouts(display, (view) =>
            findSplit(view, splitId)
              ? mapSplit(view, splitId, (s) => ({ ...s, ratio: 1 - s.ratio, children: [s.children[1], s.children[0]] }))
              : undefined,
          ),
        );
        if (changed) this.gatherSplitOf(changed, (view) => findSplit(view, splitId) !== undefined);
      },
      // 分割の向き（左右 ⇄ 上下）を変える。並び方が変わるので、割合は均等に戻す（同じ向きに並んだ 3 つは 3 等分）
      rotateSplit: (splitId: string) => {
        const changed = this.changeView(member, (display) =>
          mapLayouts(display, (view) =>
            findSplit(view, splitId)
              ? balance(mapSplit(view, splitId, (s) => ({ ...s, direction: s.direction === "row" ? "column" : "row" })))
              : undefined,
          ),
        );
        if (changed) this.gatherSplitOf(changed, (view) => findSplit(view, splitId) !== undefined);
      },
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
      // ペアプロモードで追従する参加者を変える。自分といない参加者は追従できないので、やめたものとする。
      // 追従し始めたら、相手の表示（どのタブをどう並べているか）を自分の表示に写す（docs/adr/100-terminal-tabs.md）
      follow: (memberId: number | undefined) => {
        const target = [...this.members.values()].find((m) => m.id === memberId && m !== member);
        if (member.following === target?.id) return;
        const previous = member.following;
        member.following = target?.id;
        this.forgetScroll(previous);
        this.notifyPresence();
        if (target) this.setView(member, this.views.get(target)!);
      },
      scroll: (terminalId: string, offset: number) => {
        if (member.scroll?.terminal === terminalId && member.scroll.offset === offset) return;
        member.scroll = { terminal: terminalId, offset };
        this.notifyPresence();
      },
      // 名前を変える。name は整えたもので、undefined なら設定をやめて「参加者 N」に戻す
      rename: (name: string | undefined) => {
        if (this.chosenNames.get(member) === name) return;
        if (name === undefined) this.chosenNames.delete(member);
        else this.chosenNames.set(member, name);
        this.notifyPresence();
      },
      // 抜けた参加者に追従していた人は、ペアプロモードをやめたものとする（表示はそのまま残る）
      leave: () => {
        this.members.delete(listener);
        this.views.delete(member);
        this.chosenNames.delete(member);
        this.visibleMembers.delete(member);
        this.members.forEach((m) => {
          if (m.following === member.id) m.following = undefined;
        });
        this.forgetScroll(member.following);
        this.notifyPresence();
      },
    };
  }

  // タブを閉じ、そのターミナルを終了する。最後の 1 つは閉じない。そのタブを表示していた参加者の表示から外し、
  // 表示するものがなくなった参加者には、閉じたタブの右隣（なければ左隣）のタブを出す
  close(terminalId: string) {
    // 止めている最中は、コマンドが終わっても閉じない。打ち切ったあとも続いている保存に、タブが抜けた並びを書かないため
    if (this.stopping) return;
    const index = this.order.indexOf(terminalId);
    if (index < 0 || this.order.length === 1) return;
    this.order.splice(index, 1);
    this.removeTerminal(terminalId);
    const neighbor = this.order[Math.min(index, this.order.length - 1)]!;
    this.notifyTabs();
    for (const [listener, member] of this.members) {
      const display = this.views.get(member);
      if (!display) continue;
      const inLayout = terminalIds(display.layout).includes(terminalId);
      const inSplits = display.splits.some((s) => terminalIds(s).includes(terminalId));
      if (!inLayout && !inSplits) continue;
      // 表示するものがなくなったとき、隣のタブがしまってある分割に入っていれば、その分割を出す
      let splits = withoutTab(display.splits, terminalId);
      let layout = display.layout;
      if (inLayout) {
        const rest = removeLeaf(display.layout, terminalId);
        const split = rest ? undefined : splits.find((s) => terminalIds(s).includes(neighbor));
        layout = rest ?? split ?? leaf(neighbor);
        splits = splits.filter((s) => s !== split);
      }
      const next: Display = { layout, splits };
      this.views.set(member, next);
      listener(viewEvent(next));
    }
    this.updateSeen();
  }

  // タブを並びの index 番目（並べ替えたあとの位置）へ移す。並びは全員で共有するので、全員に配って保存する。
  // 参加者ごとの表示とペアプロモードの追従は変えない（docs/adr/139-tab-order.md）。
  // group を渡したときは、移したタブをそのグループに入れる（null ならグループから外す。docs/adr/209-tab-groups.md）
  // tabs が複数のときは（分割したタブ）、並びの順のまま続けて移す（docs/adr/215-split-view.md）。index は、移すタブを除いた並びでの位置
  moveTab(tabs: string[], index: number, group?: string | null) {
    if (!this.validTabs(tabs)) return;
    const moving = this.order.filter((id) => tabs.includes(id));
    const rest = this.order.filter((id) => !tabs.includes(id));
    if (!Number.isSafeInteger(index) || index < 0 || index > rest.length) return;
    if (typeof group === "string" && !this.groups.has(group)) return;
    // グループに入れるときは、位置をそのグループの範囲（前後の境目を含む）に収める。古い並びを見て送られた位置で、
    // グループのほうがタブに合わせて動いてしまわないように
    let to = index;
    if (typeof group === "string") {
      const span = rest.flatMap((id, i) => (this.tabGroups.get(id) === group ? [i] : []));
      if (span.length > 0) to = Math.min(Math.max(index, span[0]!), span.at(-1)! + 1);
    }
    const next = [...rest.slice(0, to), ...moving, ...rest.slice(to)];
    const changesGroup = group !== undefined && moving.some((id) => (this.tabGroups.get(id) ?? null) !== group);
    if (!changesGroup && next.every((id, i) => id === this.order[i])) return;
    this.order = next;
    for (const id of moving) {
      if (group === null) this.tabGroups.delete(id);
      else if (group !== undefined) this.tabGroups.set(id, group);
    }
    this.notifyTabs();
  }

  // タブを新しいグループに入れる。色は、ほかのグループが使っていない色から選ぶ。タブはその場に残る
  // （ほかのグループの途中にあったときは、そのグループの後ろに出る）。分割したタブは、まとめて入れる
  newGroup(tabs: string[]) {
    if (!this.validTabs(tabs)) return;
    const used = new Set([...this.groups.values()].map((g) => g.color));
    const color = groupColors.find((c) => !used.has(c)) ?? groupColors[this.groups.size % groupColors.length]!;
    const id = String(this.nextGroupId++);
    this.groups.set(id, { color });
    for (const tab of tabs) this.tabGroups.set(tab, id);
    this.notifyTabs();
  }

  // タブを既存のグループの最後に入れる
  addToGroup(tabs: string[], groupId: string) {
    if (!this.validTabs(tabs) || !this.groups.has(groupId) || tabs.every((t) => this.tabGroups.get(t) === groupId)) return;
    const moving = this.order.filter((id) => tabs.includes(id));
    this.order = this.order.filter((id) => !tabs.includes(id));
    const last = this.order.findLastIndex((id) => this.tabGroups.get(id) === groupId);
    this.order.splice(last + 1, 0, ...moving);
    for (const tab of moving) this.tabGroups.set(tab, groupId);
    this.notifyTabs();
  }

  // タブをグループから外し、グループのすぐ後ろに出す
  removeFromGroup(tabs: string[]) {
    if (!this.validTabs(tabs)) return;
    let changed = false;
    // 後ろのタブから外して、外したタブが並びの順のまま、グループの後ろに並ぶようにする
    for (const terminalId of this.order.filter((id) => tabs.includes(id)).reverse()) {
      const groupId = this.tabGroups.get(terminalId);
      if (groupId === undefined) continue;
      changed = true;
      this.tabGroups.delete(terminalId);
      const from = this.order.indexOf(terminalId);
      this.order.splice(from, 1);
      const last = this.order.findLastIndex((id) => this.tabGroups.get(id) === groupId);
      this.order.splice(last < 0 ? from : last + 1, 0, terminalId);
    }
    if (changed) this.notifyTabs();
  }

  // グループのタブをまとめて、グループのタブを除いた並びの index 番目へ移す
  moveGroup(groupId: string, index: number) {
    if (!this.groups.has(groupId)) return;
    const inGroup = this.order.filter((id) => this.tabGroups.get(id) === groupId);
    const rest = this.order.filter((id) => this.tabGroups.get(id) !== groupId);
    if (!Number.isSafeInteger(index) || index < 0 || index > rest.length) return;
    const next = [...rest.slice(0, index), ...inGroup, ...rest.slice(index)];
    if (next.every((id, i) => id === this.order[i])) return;
    this.order = next;
    this.notifyTabs();
  }

  // グループに名前を付ける。name は整えたもので、undefined なら「グループ N」に戻す
  renameGroup(groupId: string, name: string | undefined) {
    const group = this.groups.get(groupId);
    if (!group || group.name === name) return;
    if (name === undefined) delete group.name;
    else group.name = name;
    this.notifyTabs();
  }

  recolorGroup(groupId: string, color: string) {
    const group = this.groups.get(groupId);
    if (!group || !isGroupColor(color) || group.color === color) return;
    group.color = color;
    this.notifyTabs();
  }

  // グループを解除する。タブはその場に残る
  ungroup(groupId: string) {
    if (!this.groups.delete(groupId)) return;
    for (const [tab, id] of this.tabGroups) if (id === groupId) this.tabGroups.delete(tab);
    this.notifyTabs();
  }

  // グループのタブをまとめて閉じる。すべてのタブが入っているグループは閉じない（最後のタブは閉じないので）
  closeGroup(groupId: string) {
    const tabs = this.order.filter((id) => this.tabGroups.get(id) === groupId);
    if (tabs.length === 0 || tabs.length === this.order.length) return;
    for (const id of tabs) this.close(id);
  }

  // タブに名前を付ける。name は整えたもので、undefined なら付けた名前をやめて「ターミナル N」に戻す。
  // 名前は全員で共有するので、全員に配って保存する（docs/adr/110-tab-name.md）
  renameTab(terminalId: string, name: string | undefined) {
    if (!this.terminals.has(terminalId) || this.tabNames.get(terminalId) === name) return;
    if (name === undefined) this.tabNames.delete(terminalId);
    else this.tabNames.set(terminalId, name);
    this.notifyTabs();
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
    this.savedMinWindow = minWindow;
    if (minWindow.width === this.minWindow.width && minWindow.height === this.minWindow.height) return this.onChange();
    this.minWindow = minWindow;
    const event = this.minWindowEvent();
    this.members.forEach((_, l) => l(event));
    this.onChange();
  }

  // 全部のターミナルを閉じ、コマンドと前面のコマンドが終わるのを待つ（上限はターミナルごとの kill による。
  // docs/adr/197-sighup-on-close.md）
  async killAll() {
    this.stopping = true;
    await Promise.all([...this.terminals.values()].map((t) => t.kill()));
  }

  private createTerminal(command: string[], cwd?: string) {
    const id = String(this.nextId++);
    this.addTerminal(id, command, undefined, cwd);
    return id;
  }

  private addTerminal(id: string, command: string[], restored?: Restored, cwd?: string) {
    this.order.push(id);
    this.terminals.set(
      id,
      new TerminalSession(
        command,
        () => this.close(id),
        () => this.notifyTitles(),
        () => this.notifyStatus(),
        { restored, onOutput: () => this.onChange(), cwd },
      ),
    );
  }

  // ターミナルを終了し、参加者がそのターミナルで選択していた範囲も消す。ブラウザもターミナルを抜けたときに
  // 選択をやめたと伝えてくるが、伝え返さない参加者の分が残らないように、ここでも消す
  private removeTerminal(id: string) {
    // 閉じるタブのコマンドが終わるのは待たない
    void this.terminals.get(id)?.kill();
    this.terminals.delete(id);
    this.tabNames.delete(id);
    this.tabGroups.delete(id);
    let changed = false;
    for (const member of this.members.values()) {
      if (!Object.hasOwn(member.selections, id)) continue;
      delete member.selections[id];
      changed = true;
    }
    if (changed) this.notifyPresence();
  }

  // まだタブを並べられるか（抜けた参加者は並べられない）
  private canAdd(member: Member) {
    const display = this.views.get(member);
    return display !== undefined && terminalIds(display.layout).length < maxPanes;
  }

  // 1 つ以上、並べられる数まで、別々の開いているタブか
  private validTabs(tabs: string[]) {
    return tabs.length > 0 && tabs.length <= maxPanes && new Set(tabs).size === tabs.length && tabs.every((t) => this.terminals.has(t));
  }

  // added を、terminalId のターミナルの右・下に並べる。terminalId を表示していなければ、全体の右・下に並べる。
  // 同じ向きに並んだものは均等な大きさにする（左右に 3 つなら 3 等分。Chrome の画面分割と同じ）
  private placeBeside(view: Layout, added: Layout, terminalId: string | undefined, direction: "row" | "column") {
    const split = (target: Layout): Layout => ({
      type: "split",
      id: `split-${this.nextSplitId++}`,
      direction,
      ratio: 0.5,
      children: [target, added],
    });
    if (terminalId === undefined || !terminalIds(view).includes(terminalId)) return balance(split(view));
    return balance(replaceLeaf(view, terminalId, split(leaf(terminalId))));
  }

  // 参加者が自分で表示を変える。change が undefined を返したら変えない。ペアプロモードで追従していればやめる
  // （自分で選んだ表示が、相手の表示で上書きされないように。docs/adr/100-terminal-tabs.md）
  // 変えたときは、変えたあとの表示を返す
  private changeView(member: Member, change: (display: Display) => Display | undefined) {
    const view = this.views.get(member);
    const next = view && change(view);
    if (!next) return undefined;
    if (member.following !== undefined) {
      const previous = member.following;
      member.following = undefined;
      this.forgetScroll(previous);
      this.notifyPresence();
    }
    this.setView(member, next);
    return next;
  }

  // 分割を作る・並べ方を変えたときに、分割したタブを、全員で共有する並びでも表示の並び（左から・上から）のまま隣り合わせる。
  // 「隣に持ってきて分割表示する」操作とみなす（docs/adr/215-split-view.md）。置く場所は、分割の相手（added 以外のタブ）のうち
  // 並びで一番前のタブの位置。グループは、そのタブのグループにそろえる（入っていなければ、グループから外す）
  private gather(layout: Layout, added?: string) {
    const ids = terminalIds(layout);
    if (ids.length < 2) return;
    const anchor = this.order.find((id) => ids.includes(id) && id !== added);
    if (anchor === undefined) return;
    const group = this.tabGroups.get(anchor);
    const at = this.order.indexOf(anchor);
    const next = [
      ...this.order.slice(0, at).filter((id) => !ids.includes(id)),
      ...ids,
      ...this.order.slice(at).filter((id) => !ids.includes(id)),
    ];
    const sameGroup = ids.every((id) => this.tabGroups.get(id) === group);
    if (sameGroup && next.every((id, i) => id === this.order[i])) return;
    this.order = next;
    for (const id of ids) {
      if (group === undefined) this.tabGroups.delete(id);
      else this.tabGroups.set(id, group);
    }
    this.notifyTabs();
  }

  // 表示（いま出しているものと、しまってある分割）のうち、has に当てはまる分割のタブを隣り合わせる
  private gatherSplitOf(display: Display, has: (layout: Layout) => boolean) {
    const layout = [display.layout, ...display.splits].find(has);
    if (layout) this.gather(layout);
  }

  // 参加者の表示を変えて本人に配り、その参加者に追従している人の表示にも写す（追従の連鎖も順に写し、輪になっていても止まる）
  private setView(member: Member, view: Display) {
    const visited = new Set<Member>();
    const apply = (target: Member) => {
      visited.add(target);
      this.views.set(target, view);
      for (const [listener, m] of this.members) if (m === target) listener(viewEvent(view));
      for (const follower of this.members.values()) {
        if (follower.following === target.id && !visited.has(follower)) apply(follower);
      }
    };
    apply(member);
    // 表示が変わると、見ているターミナルも変わる
    this.updateSeen();
  }

  // 付けた名前が次のどれかなら、番号を添えて見分けられるようにする（docs/adr/110-tab-name.md）
  // - ほかのタブの名前（付けた名前と「ターミナル N」）と同じ
  // - ほかの番号の「ターミナル N」と同じ
  // - 番号を添えた形（「名前（ターミナル N）」）をまねている
  // 同じかは参加者の名前と同じ nameKey で比べ、さらに空白を無視する（「ターミナル2」「ターミナル　２」も「ターミナル 2」とみなす）
  private tabsEvent(): WorkspaceEvent {
    const toKey = (name: string) => nameKey(name).replace(/\s/g, "");
    const keys = new Map(this.order.map((id) => [id, toKey(this.tabNames.get(id) ?? defaultTabName(id))]));
    const tabs = this.order.map((id): Tab => {
      const custom = this.tabNames.get(id);
      if (custom === undefined) return { id, name: defaultTabName(id) };
      const key = keys.get(id)!;
      const looksDefault = key.match(/^ターミナル(\d+)$/);
      const clash =
        (looksDefault !== null && looksDefault[1] !== id) ||
        // NFKC で全角の括弧も半角になる
        /\(ターミナル\d+\)$/.test(key) ||
        this.order.some((other) => other !== id && keys.get(other) === key);
      return { id, name: clash ? `${custom}（${defaultTabName(id)}）` : custom, custom };
    });
    for (const tab of tabs) {
      const group = this.tabGroups.get(tab.id);
      if (group !== undefined) tab.group = group;
    }
    const groups: Group[] = [];
    for (const id of new Set(this.order.flatMap((tab) => this.tabGroups.get(tab) ?? []))) {
      const { name, color } = this.groups.get(id)!;
      groups.push({ id, name: name ?? defaultGroupName(id), ...(name !== undefined && { custom: name }), color });
    }
    return { type: "tabs", tabs, groups };
  }

  // タブのないグループを消し、グループのタブが続けて並ぶようにする。グループの途中に別のタブが入ったときは、
  // グループの最初のタブの位置にグループのタブをまとめる（途中に入ったタブは、グループの後ろに出る）
  private normalizeGroups() {
    for (const [tab, group] of this.tabGroups) {
      if (!this.groups.has(group) || !this.terminals.has(tab)) this.tabGroups.delete(tab);
    }
    const used = new Set(this.tabGroups.values());
    for (const id of this.groups.keys()) if (!used.has(id)) this.groups.delete(id);
    const placed = new Set<string>();
    const order: string[] = [];
    for (const id of this.order) {
      if (placed.has(id)) continue;
      const group = this.tabGroups.get(id);
      const run = group === undefined ? [id] : this.order.filter((t) => this.tabGroups.get(t) === group);
      for (const t of run) {
        placed.add(t);
        order.push(t);
      }
    }
    this.order = order;
  }

  // タブの並びが変わったら全員に配り、保存する
  private notifyTabs() {
    this.normalizeGroups();
    const event = this.tabsEvent();
    this.members.forEach((_, l) => l(event));
    this.onChange();
  }

  private titlesEvent(): WorkspaceEvent {
    const titles: Record<string, string> = {};
    this.terminals.forEach((terminal, id) => {
      if (terminal.title) titles[id] = terminal.title;
    });
    return { type: "titles", titles };
  }

  // タイトルはタブの並びとは別に配る。シェルのプロンプトなどで頻繁に変わるので、そのたびに表示を組み直さない。
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

  // 誰か 1 人でも見ているターミナルの未確認を消す。見ている = その参加者の表示にあり、その参加者がフォーカスしていて、
  // ページが見えている。消したものがあれば true
  private clearSeen() {
    let changed = false;
    for (const member of this.visibleMembers) {
      const id = member.terminal;
      const view = this.views.get(member)?.layout;
      if (id && view && terminalIds(view).includes(id) && this.terminals.get(id)?.markSeen()) changed = true;
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

  // 画面に出す名前を決め直す。同じ名前（既定の「参加者 N」も含む）の参加者が複数いれば、番号を添えて見分けられるようにする
  private updateNames() {
    const members = [...this.members.values()];
    const chosen = (m: Member) => this.chosenNames.get(m) ?? defaultName(m.id);
    const counts = new Map<string, number>();
    for (const m of members) counts.set(nameKey(chosen(m)), (counts.get(nameKey(chosen(m))) ?? 0) + 1);
    for (const m of members) {
      const name = chosen(m);
      m.name = counts.get(nameKey(name))! > 1 ? `${name}（${defaultName(m.id)}）` : name;
    }
  }

  private notifyPresence() {
    this.updateNames();
    const members = [...this.members.values()];
    this.members.forEach((_, l) => l({ type: "presence", members }));
  }
}

function defaultName(id: number) {
  return `参加者 ${id}`;
}

function defaultTabName(id: string) {
  return `ターミナル ${id}`;
}

function defaultGroupName(id: string) {
  return `グループ ${id}`;
}

type Split = Extract<Layout, { type: "split" }>;

function viewEvent(display: Display): WorkspaceEvent {
  return { type: "view", layout: display.layout, splits: display.splits };
}

// いま出している表示が分割なら、しまってある分割に加えたもの
function parked(display: Display) {
  return display.layout.type === "split" ? [...display.splits, display.layout] : display.splits;
}

// しまってある分割から、タブを抜く。残りが 1 つになった分割はなくす
function withoutTab(splits: Layout[], tab: string) {
  return splits.flatMap((split) => {
    if (!terminalIds(split).includes(tab)) return [split];
    const rest = removeLeaf(split, tab);
    return rest && rest.type === "split" ? [rest] : [];
  });
}

// いまの表示か、しまってある分割のうち、change で変わる最初のものを変える。どれも変わらなければ undefined
function mapLayouts(display: Display, change: (layout: Layout) => Layout | undefined): Display | undefined {
  const layout = change(display.layout);
  if (layout) return { ...display, layout };
  for (const [i, split] of display.splits.entries()) {
    const next = change(split);
    if (next) return { ...display, splits: display.splits.with(i, next) };
  }
  return undefined;
}

// added を、表示全体の左・右・下に置く。同じ向きに並んだものは均等な大きさにする
function placeAtEdge(view: Layout, added: Layout, edge: Edge, id: string): Layout {
  return balance({
    type: "split",
    id,
    direction: edge === "bottom" ? "column" : "row",
    ratio: 0.5,
    children: edge === "left" ? [added, view] : [view, added],
  });
}

// 表示の木は、写した相手と共有しても壊れないよう、変えるときは作り直す
function leaf(id: string): Layout {
  return { type: "terminal", id };
}

export function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
}

function findSplit(node: Layout, id: string): Split | undefined {
  if (node.type === "terminal") return;
  return node.id === id ? node : (findSplit(node.children[0], id) ?? findSplit(node.children[1], id));
}

function mapChildren(node: Split, f: (child: Layout) => Layout): Layout {
  return { ...node, children: [f(node.children[0]), f(node.children[1])] };
}

function replaceLeaf(node: Layout, id: string, replacement: Layout): Layout {
  if (node.type === "terminal") return node.id === id ? replacement : node;
  return mapChildren(node, (child) => replaceLeaf(child, id, replacement));
}

// 葉を外し、残った兄弟がその場所を埋める。外すと何も残らなければ undefined
function removeLeaf(node: Layout, id: string): Layout | undefined {
  if (node.type === "terminal") return node.id === id ? undefined : node;
  const first = removeLeaf(node.children[0], id);
  const second = removeLeaf(node.children[1], id);
  if (!first || !second) return first ?? second;
  return { ...node, children: [first, second] };
}

function withRatio(node: Layout, splitId: string, ratio: number): Layout {
  return mapSplit(node, splitId, (split) => ({ ...split, ratio }));
}

// splitId の節を change で作り直す
function mapSplit(node: Layout, splitId: string, change: (split: Split) => Split): Layout {
  if (node.type === "terminal") return node;
  if (node.id === splitId) return change(node);
  return mapChildren(node, (child) => mapSplit(child, splitId, change));
}

// 2 つの葉の位置を入れ替える。節（向きと割合）はそのまま
function swapLeaves(node: Layout, a: string, b: string): Layout {
  if (node.type === "terminal") return node.id === a ? leaf(b) : node.id === b ? leaf(a) : node;
  return mapChildren(node, (child) => swapLeaves(child, a, b));
}

// 同じ向きの分割が続くところ（左右に 3 つなど）は、並んでいるものが均等な大きさになるよう割合を決め直す
function balance(node: Layout): Layout {
  if (node.type === "terminal") return node;
  const children = node.children.map(balance) as [Layout, Layout];
  const [first, second] = children.map((child) => slots(child, node.direction));
  return { ...node, ratio: first! / (first! + second!), children };
}

// その向きに並ぶものの数。同じ向きの分割は、中に並ぶものを数える
function slots(node: Layout, direction: "row" | "column"): number {
  if (node.type === "terminal" || node.direction !== direction) return 1;
  return slots(node.children[0], direction) + slots(node.children[1], direction);
}
