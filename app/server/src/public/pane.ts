import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IMarker } from "@xterm/xterm";
import { scrollback } from "../scrollback";
import { TrimmedLines } from "../trimmed-lines";
import { themeColors, type Appearance } from "./appearance";
import { acceptFileDrop } from "./file-drop";
import { isSearchKey, SearchBar } from "./search";
import { showContextMenu } from "./context-menu";
import type { WindowSize } from "./min-window";
import { firstLine, type QuickCommand } from "./quick-commands";
import { shortcutFor, withKeys, type Shortcut } from "./shortcuts";

const protocol = location.protocol === "https:" ? "wss:" : "ws:";

export type PaneActions = {
  split: (direction: "row" | "column") => void;
  close: () => void;
  // 拡大表示を外す／戻す。拡大は自分の画面だけの表示で、サーバーには伝えない（docs/adr/68-zoom.md）
  zoom: () => void;
  // 端末の大きさか表示領域が変わり、枠に収まるか（overflows）が変わったかもしれないとき
  resized: () => void;
  // キー入力の先がこのターミナルに移ったとき
  focused: () => void;
  // このターミナルにキー入力しているときに押されたキーボードショートカット
  shortcut: (shortcut: Shortcut) => void;
  // 参加者全員で共有している、よく使うコマンドの一覧と、その登録・編集・削除の画面を開く
  commands: () => QuickCommand[];
  manageCommands: () => void;
  // ほかの参加者とペアプロする（その人に追従している途中ならやめる）
  follow: (member: number) => void;
  // このターミナルでの自分の選択範囲が変わったとき。選択をやめたときやターミナルを抜けたときは undefined
  selected: (range: SelectionRange | undefined) => void;
  // スクロール位置が変わったとき。user は、自分でスクロールした（ホイール・スクロールバー）か
  scrolled: (user: boolean) => void;
  // 端末の大きさの下限（ウィンドウの大きさ）。サーバーから届くまでは undefined（docs/adr/99-smallest-size.md）
  minWindow: () => WindowSize | undefined;
};

// ターミナルの選択範囲。位置は列と、出力の始めからの行の番号（バッファの行に、スクロールバックから押し出された行の数を足したもの。
// 代替画面ではバッファの行）。end の列は含まない
export type SelectionRange = { start: { x: number; y: number }; end: { x: number; y: number } };

// ほかの参加者が、このターミナルで選択している範囲（docs/adr/94-remote-selection.md）
export type RemoteSelection = { name: string; color: string; range: SelectionRange };

// ほかの参加者の選択範囲を、受け取ったときの行に置いた印（marker）で覚えておく。
// 印は出力でスクロールバックが押し出されても、同じ行についていく。buffer は、受け取ったときの画面（通常・代替）、
// key は受け取った範囲（変わったものだけ置き直すため）
type PlacedSelection = {
  key: string;
  name: string;
  color: string;
  buffer: "normal" | "alternate";
  start: { x: number; marker: IMarker };
  end: { x: number; marker: IMarker };
};

// このターミナルで動いているエージェントの状態。サーバーが判定して全員に配る。
// 「入力待ち」はほかの参加者の入力を待っているようにも読めるので、エージェントが指示を待っていると書く（docs/adr/70-agent-detection.md）
// 作業が終わってまだ誰も見ていないものは「未確認」にする（docs/adr/74-unseen-done.md）
export type AgentStatus = "working" | "idle" | "done";
export const statusLabels: Record<AgentStatus, string> = { working: "作業中", done: "未確認", idle: "指示待ち" };
export const statusDescriptions: Record<AgentStatus, string> = {
  working: "エージェントが作業中",
  done: "作業が終わったが、まだ誰も見ていない",
  idle: "エージェントが指示を待っている",
};

// このターミナルにフォーカスしている参加者。following は、自分がペアプロモードでその人に追従しているか
export type Viewer = { id: number; name: string; color: string; self: boolean; following: boolean };

// 端末の大きさを決めるとき、各参加者の表示領域はこの大きさ（フル HD）までとみなす（docs/adr/51-largest-size.md）
const maxArea = { width: 1920, height: 1080 };
// xterm のスクロールバックのスクロールバーの幅（@xterm/addon-fit と同じ値）
const scrollbarWidth = 14;
// 画面に収めるために縮小するとき、フォントの大きさをどこまで小さくするか
const minFitFontSize = 2;
// ホイールやスクロールバーを操作してから、この時間のうちに変わったスクロール位置は、自分でスクロールしたものとみなす
const userScrollWindow = 500;
type CellSize = { width: number; height: number };

// 1 つのターミナルの表示。配置が変わっても同じ要素と接続を使い回す
export class Pane {
  readonly element = document.createElement("section");
  private bar = document.createElement("div");
  private closeButton: HTMLButtonElement;
  private zoomButton: HTMLButtonElement;
  private zoomLabel = document.createElement("span");
  // 拡大中に、分割での元の位置を取っておく要素。拡大中は、端末の大きさと枠に収まるかを、この要素の大きさで決める
  private placeholder: HTMLElement | undefined;
  private viewers = document.createElement("span");
  private viewersKey = "";
  private program = document.createElement("span");
  private status = document.createElement("span");
  private actions: PaneActions;
  private terminal: Terminal;
  private container = document.createElement("div");
  private appearance: Appearance;
  // 設定したフォントの大きさでの 1 文字の幅と高さ。縮小して表示している間も、伝える大きさはこれで計算する
  private cell: CellSize | undefined;
  private socket: WebSocket;
  private resizeObserver: ResizeObserver;
  private bottomObserver: ResizeObserver;
  private search: SearchBar;
  private notice = document.createElement("div");
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // 開いている右クリックメニューを閉じる。ターミナルがなくなったら、メニューも閉じる
  private closeMenu = () => {};
  // ほかの参加者の選択範囲。受け取ったものと、行に印を置いたもの、それを描く層
  private receivedSelections: RemoteSelection[] = [];
  private remoteSelectionsKey = "[]";
  private remoteSelections: PlacedSelection[] = [];
  private remoteLayer = document.createElement("div");
  // つないだときに届く現在の画面（スクロールバックを含む）を書き終えたか。書き終えるまでは、選択範囲の行に印を置けない
  private restored = false;
  // スクロールバックから押し出された行の数。選択範囲の行は、これを足した「出力の始めからの行の番号」でやりとりする
  private trimmed: TrimmedLines;
  private firstOutput = true;
  // 最後にサーバーに伝えた自分の選択範囲
  private sentSelection = "null";
  // 最後にホイールを回した（スクロールバーから手を離した）時刻と、スクロールバーを押しているか
  private userScrollAt = -Infinity;
  private draggingScrollbar = false;
  // 端末が表示領域からはみ出しているとき、枠のスクロールを一番下（最新の行が見える位置）に保つか。
  // 表示し直したターミナルは一番下から見せ、自分で上にスクロールしたら、一番下に戻すまで保たない（docs/adr/116-overflow-scroll-bottom.md）
  private stickToBottom = true;
  private releaseScrollbar = () => {
    if (!this.draggingScrollbar) return;
    this.draggingScrollbar = false;
    this.userScrollAt = performance.now();
  };

  constructor(id: string, actions: PaneActions, appearance: Appearance) {
    this.appearance = appearance;
    this.actions = actions;
    // 出力の URL（OSC 8 のハイパーリンクと、ただの文字列の URL）は、どちらも同じように確認なしで新しいタブに開く。
    // マウスがリンクの上にあるかを覚えておき、リンクのクリックをアプリに渡さないために使う（docs/adr/59-single-link-open.md）
    let overLink = false;
    const links = {
      activate: openLink,
      hover: () => (overLink = true),
      leave: () => (overLink = false),
    };
    // 配色とフォントの大きさは、作るときから渡す（あとから変えると、そのぶん描き直しが増える）
    this.terminal = new Terminal({
      // 検索のヒットの強調（decorations）に、xterm の試験的な API を使う
      allowProposedApi: true,
      // スクロールバックの行数は、サーバー側の画面と揃える（選択範囲のバッファの行の番号を合わせるため）
      scrollback,
      theme: themeColors(appearance),
      fontSize: appearance.fontSize,
      linkHandler: links,
      // マウスの報告モードを使うアプリ（Codex など）の上でも、macOS では Option を押しながらドラッグすると選択できるようにする。
      // Windows / Linux は、xterm の既定のまま Shift で選択できる（docs/adr/114-force-selection.md）
      macOptionClickForcesSelection: true,
    });
    this.search = new SearchBar(this.terminal, () => this.revealSelection());
    this.element.className = "pane";
    this.element.setAttribute("aria-label", `ターミナル ${id}`);

    const bar = this.bar;
    bar.className = "pane-bar";
    const title = document.createElement("span");
    title.className = "pane-title";
    title.textContent = `ターミナル ${id}`;
    // コマンドが設定したタイトル。長いものは CSS で省略し、全文はツールチップで出す
    this.program.className = "pane-program";
    this.program.hidden = true;
    this.viewers.className = "pane-viewers";
    this.viewers.setAttribute("role", "status");
    this.status.className = "pane-status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-label", "エージェントの状態");
    this.setStatus(undefined);
    this.zoomLabel.className = "pane-zoomed";
    this.zoomLabel.setAttribute("role", "status");
    this.zoomLabel.hidden = true;
    bar.append(
      title,
      this.program,
      this.status,
      this.viewers,
      this.zoomLabel,
      button("コマンド", "❯", (event) => this.openCommands(event.currentTarget as HTMLElement, actions)),
      button("検索", "⌕", () => this.search.open()),
      button("右に分割", "⇥", () => actions.split("row"), withKeys("右に分割")),
      button("下に分割", "⤓", () => actions.split("column"), withKeys("下に分割")),
      (this.zoomButton = button("拡大表示", "⤢", actions.zoom, withKeys("拡大表示の切り替え", "拡大表示"))),
      (this.closeButton = button("閉じる", "×", actions.close, withKeys("ターミナルを閉じる", "閉じる"))),
    );
    const container = this.container;
    container.className = "pane-terminal";
    container.dataset.overflow = appearance.overflow;
    this.notice.className = "pane-notice";
    this.notice.setAttribute("role", "alert");
    this.notice.hidden = true;
    this.element.append(bar, this.search.element, container, this.notice);

    // 検索バーを開くキーとキーボードショートカットは、xterm やブラウザ（ページ内検索など）より先に拾う
    this.element.addEventListener(
      "keydown",
      (event) => {
        const shortcut = shortcutFor(event);
        if (!isSearchKey(event) && !shortcut) return;
        event.preventDefault();
        event.stopPropagation();
        if (shortcut === "ignore") return;
        if (shortcut) actions.shortcut(shortcut);
        else this.search.open();
      },
      { capture: true },
    );

    this.paintBackground(container, appearance);
    this.terminal.loadAddon(new WebLinksAddon(links.activate, { hover: links.hover, leave: links.leave }));
    this.terminal.open(container);
    // Claude Code などマウスの報告モードを使うアプリは、クリックを受け取るとその位置のリンクを自分でも開くので、
    // リンクの上での押下はアプリに報告しない（ブラウザとアプリの両方で開いて二重になる）。
    // xterm はリンクの押下を画面の要素で、アプリへの報告を外側の要素で受け取るので、その間で止める。
    // 外側の要素で xterm が行うことのうち、キー入力の先をこのターミナルに保つことは、ここで代わりに行う
    this.terminal.element?.querySelector(".xterm-screen")?.addEventListener("mousedown", (event) => {
      if (!overLink || this.terminal.modes.mouseTrackingMode === "none") return;
      event.stopPropagation();
      event.preventDefault();
      this.terminal.focus();
    });
    // ほかの参加者の選択範囲は、自分の選択範囲（xterm の .xterm-selection）と同じく、文字の上に半透明で重ねる。
    // 描き直し（スクロール・出力・フォントの大きさの変更）のたびに位置を計算し直す
    this.remoteLayer.className = "remote-selections";
    this.remoteLayer.setAttribute("aria-hidden", "true");
    this.terminal.element?.querySelector(".xterm-screen")?.append(this.remoteLayer);
    this.terminal.onRender(() => {
      this.drawRemoteSelections();
      this.remeasure();
    });
    this.trimmed = new TrimmedLines(this.terminal);
    this.terminal.onSelectionChange(() => this.sendSelection());
    // スクロールバックがいっぱいのとき、xterm は古い行を押し出して選択範囲の行を詰めるが、選択の変化は知らせない。
    // 選択した行が押し出されて選択がなくなったときも知らせないので、出力のたびに読み直し、変わっていれば送り直す
    this.terminal.onWriteParsed(() => this.sendSelection());

    this.socket = new WebSocket(`${protocol}//${location.host}/ws/terminals/${id}`);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.sendSize();
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "resize") {
          this.terminal.resize(message.cols, message.rows);
          this.fitToArea();
          actions.resized();
        } else if (message.type === "trimmed" && this.firstOutput) {
          // 途中から開いたときは、サーバー側の画面がそれまでに押し出していた行の数から数え始める
          this.trimmed.count = message.lines;
        }
      } else if (this.firstOutput) {
        this.firstOutput = false;
        this.terminal.write(new Uint8Array(event.data), () => {
          this.restored = true;
          this.keepAtBottom();
          this.placeRemoteSelections();
        });
      } else {
        this.terminal.write(new Uint8Array(event.data));
      }
    };
    this.terminal.onData((data) => this.send(data));
    // Shift+Enter は、Claude Code などが改行として扱う ESC + CR を送る（/terminal-setup が VS Code などに入れる設定と同じ）
    this.terminal.attachCustomKeyEventHandler((event) => {
      const shiftEnter =
        event.key === "Enter" &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        // 日本語入力で変換を確定する Enter は IME に任せる
        !event.isComposing;
      if (!shiftEnter) return true;
      if (event.type === "keydown") this.send("\x1b\r");
      event.preventDefault();
      return false;
    });
    this.terminal.textarea?.addEventListener("focus", actions.focused);
    // 検索バーに入力しているときも、このターミナルにフォーカスしているものとして表示する
    this.search.element.addEventListener("focusin", actions.focused);
    // スクロール位置を、ペアプロモードで追従している人に伝えるために知らせる。xterm はスクロールの原因を教えないので、
    // 直前にホイールを回したか、スクロールバーを押している（押してから離すまで）なら、自分でスクロールしたものとみなす
    // （docs/adr/93-pair-mode.md）
    this.element.addEventListener("wheel", () => (this.userScrollAt = performance.now()), { capture: true, passive: true });
    container.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target instanceof Element && event.target.closest(".scrollbar")) this.draggingScrollbar = true;
      },
      { capture: true },
    );
    window.addEventListener("pointerup", this.releaseScrollbar);
    window.addEventListener("pointercancel", this.releaseScrollbar);
    this.terminal.onScroll(() =>
      actions.scrolled(this.draggingScrollbar || performance.now() - this.userScrollAt < userScrollWindow),
    );
    // ドロップしたファイルのパスは、このターミナルの入力として貼り付ける
    acceptFileDrop(this.element, (text) => this.terminal.paste(text));

    // 右クリックでは Accompany のメニューを出す。TUI がマウスの報告モードを有効にしていても、
    // 右クリックはアプリに渡さない（xterm.js より先に受け取って止める）
    container.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 2) return;
        event.stopPropagation();
        // キー入力の先を動かさない
        event.preventDefault();
      },
      true,
    );
    container.addEventListener(
      "contextmenu",
      (event) => {
        event.stopPropagation();
        event.preventDefault();
        // キーボードのコンテキストメニューキーで開いたときは、入力欄（カーソル）の位置に出す
        const at = event.clientX || event.clientY ? event : this.terminal.textarea?.getBoundingClientRect();
        this.openMenu(at?.x ?? 0, at?.y ?? 0, actions);
      },
      true,
    );

    // 端末の大きさは参加者のうち一番小さい表示領域に合わせるため、自分の表示領域に収まる大きさ（下限より小さければ下限）を
    // サーバーに伝え、サーバーが決めた大きさで描く。表示領域に収まらない部分は、スクロールするか縮小して見る
    this.resizeObserver = new ResizeObserver(() => {
      this.sendSize();
      this.fitToArea();
      actions.resized();
    });
    this.resizeObserver.observe(container);
    // 表示領域や、端末の大きさ（サーバーが決める）・フォントの大きさが変わって、はみ出す量が変わったときも、一番下に保つ
    this.bottomObserver = new ResizeObserver(() => this.keepAtBottom());
    this.bottomObserver.observe(container);
    if (this.terminal.element) this.bottomObserver.observe(this.terminal.element);
    container.addEventListener("scroll", () => (this.stickToBottom = isAtBottom(container)), { passive: true });
  }

  // フォーカスしている参加者を、バーに名前で出す。自分がフォーカスしていれば枠を自分の色で強調する。
  // ほかの参加者の名前は、押すとその人とペアプロする（その人の画面に追従する）ボタンにする（docs/adr/93-pair-mode.md）
  setViewers(viewers: Viewer[]) {
    // 参加者の情報は誰かが動くたびに届く。変わっていなければ作り直さない（ペアプロのボタンを押している途中などに失わないため）
    const key = JSON.stringify(viewers);
    if (key === this.viewersKey) return;
    this.viewersKey = key;
    this.viewers.replaceChildren(
      ...viewers.map((viewer) => {
        const badge = viewer.self
          ? document.createElement("span")
          : button(
              `${viewer.name} とペアプロ`,
              viewer.name,
              () => this.actions.follow(viewer.id),
              viewer.following ? "ペアプロをやめる" : `${viewer.name} とペアプロ（その人の画面に追従する）`,
            );
        badge.className = "viewer";
        if (viewer.self) badge.textContent = "あなた";
        else badge.setAttribute("aria-pressed", String(viewer.following));
        badge.style.setProperty("--viewer-color", viewer.color);
        return badge;
      }),
    );
    const self = viewers.find((v) => v.self);
    if (self) {
      this.element.dataset.focused = "true";
      this.element.style.setProperty("--focus-color", self.color);
    } else {
      delete this.element.dataset.focused;
    }
  }

  // コマンドが設定したタイトルを出す。空なら「ターミナル N」だけにする
  setTitle(text: string) {
    this.program.textContent = text;
    this.program.title = text;
    this.program.hidden = text === "";
  }

  // エージェントの状態を出す。エージェントが動いていなければ（undefined）状態を出さず、目立たせる表示もやめる
  setStatus(status: AgentStatus | undefined) {
    this.status.hidden = status === undefined;
    this.status.textContent = status ? statusLabels[status] : "";
    this.status.title = status ? statusDescriptions[status] : "";
    if (status) {
      this.status.dataset.status = status;
      this.element.dataset.agent = "true";
    } else {
      delete this.status.dataset.status;
      delete this.element.dataset.agent;
    }
  }

  // 配色とフォントの大きさ、はみ出したときの見せ方を変える。フォントの大きさで表示領域に収まる列数・行数が変わるので、
  // 設定した大きさで測り直してサーバーに伝え直す
  setAppearance(appearance: Appearance) {
    this.appearance = appearance;
    this.terminal.options.theme = themeColors(appearance);
    this.setFontSize(appearance.fontSize);
    this.container.dataset.overflow = appearance.overflow;
    this.paintBackground(this.container, appearance);
    this.sendSize();
    this.fitToArea();
  }

  // 端末の大きさの下限が変わったので、伝える大きさを計算し直す
  refit() {
    this.sendSize();
  }

  setClosable(closable: boolean) {
    this.closeButton.disabled = !closable;
  }

  // 拡大表示の状態を出す。placeholder は拡大中に分割での元の位置を取っておく要素（拡大していなければ undefined）、
  // hidden は分割しているほかのターミナルの数、off は自分で拡大を外していて、このターミナルにフォーカスしていること。
  // 拡大を外す／戻すは、拡大しているか、分割していて枠に収まらないときにできる
  setZoom(zoom: { placeholder?: HTMLElement; hidden: number; off: boolean }) {
    if (zoom.placeholder !== this.placeholder) {
      if (this.placeholder) this.resizeObserver.unobserve(this.placeholder);
      this.placeholder = zoom.placeholder;
      if (this.placeholder) this.resizeObserver.observe(this.placeholder);
    }
    const zoomed = this.placeholder !== undefined;
    const overflows = zoom.hidden > 0 && this.overflows();
    this.zoomButton.setAttribute("aria-pressed", String(zoomed));
    this.zoomButton.disabled = !zoomed && !overflows;
    this.zoomLabel.hidden = !zoomed && !(zoom.off && overflows);
    this.zoomLabel.dataset.state = zoomed ? "zoomed" : "off";
    this.zoomLabel.textContent = zoomed ? "拡大中" : "拡大を外しています";
    this.zoomLabel.title = zoomed
      ? `枠に収まらないので拡大しています（ほか ${zoom.hidden} 個のターミナルを隠しています）。${withKeys("拡大表示の切り替え", "外すと分割の全体を見られます")}`
      : `枠に収まりませんが、拡大を外しています。${withKeys("拡大表示の切り替え", "拡大に戻せます")}`;
  }

  // 端末が、分割での自分の枠に収まらない（スクロールバーが出る）か。設定したフォントの大きさで比べる
  overflows() {
    const area = this.splitArea();
    if (!this.cell || !area) return false;
    return (
      this.terminal.cols * this.cell.width + scrollbarWidth > area.width ||
      this.terminal.rows * this.cell.height > area.height
    );
  }

  focus() {
    this.terminal.focus();
  }

  // ほかの参加者の選択範囲を出す。参加者の情報は誰かが動くたびに届くので、変わったときだけ置き直す
  setRemoteSelections(selections: RemoteSelection[]) {
    const key = JSON.stringify(selections);
    if (key === this.remoteSelectionsKey) return;
    this.remoteSelectionsKey = key;
    this.receivedSelections = selections;
    if (this.restored) this.placeRemoteSelections();
  }

  // スクロール位置。参加者によってスクロールバックの行数が違うことがあるので、一番下から何行戻しているかで表す
  scrollOffset() {
    const { baseY, viewportY } = this.terminal.buffer.active;
    return baseY - viewportY;
  }

  // 相手の位置に合わせたスクロールを、自分でスクロールしたものと取り違えないよう、直前の操作を忘れる
  scrollToOffset(offset: number) {
    this.userScrollAt = -Infinity;
    const { baseY } = this.terminal.buffer.active;
    this.terminal.scrollToLine(Math.max(0, baseY - offset));
  }

  dispose() {
    // ターミナルを抜けると自分の選択もなくなるので、ほかの参加者の画面からも消す
    this.sendSelection(true);
    this.disposeRemoteSelections();
    clearTimeout(this.noticeTimer);
    this.closeMenu();
    this.resizeObserver.disconnect();
    this.bottomObserver.disconnect();
    window.removeEventListener("pointerup", this.releaseScrollbar);
    window.removeEventListener("pointercancel", this.releaseScrollbar);
    this.socket.close();
    this.terminal.dispose();
    this.element.remove();
  }

  private openMenu(x: number, y: number, actions: PaneActions) {
    this.closeMenu = showContextMenu(
      x,
      y,
      `${this.element.getAttribute("aria-label")} のメニュー`,
      [
        { label: "コピー", disabled: !this.terminal.hasSelection(), action: () => this.copy() },
        { label: "ペースト", action: () => this.paste() },
        { label: "すべて選択", action: () => this.terminal.selectAll() },
        "separator",
        // 参加者全員の画面とサーバー側の画面をリセットする（docs/adr/33-context-menu.md）
        { label: "ターミナルのリセット", action: () => this.socket.send(JSON.stringify({ type: "reset" })) },
        "separator",
        // 自分の画面だけの表示の切り替え（docs/adr/68-zoom.md）
        {
          label: this.placeholder ? "拡大を解除" : "拡大表示",
          disabled: this.zoomButton.disabled,
          action: actions.zoom,
        },
        "separator",
        { label: "右に分割", action: () => actions.split("row") },
        { label: "下に分割", action: () => actions.split("column") },
      ],
      () => this.terminal.focus(),
    );
  }

  // よく使うコマンドの一覧を、ボタンの下にメニューで出す
  private openCommands(anchor: HTMLElement, actions: PaneActions) {
    const commands = actions.commands();
    const { left, bottom } = anchor.getBoundingClientRect();
    this.closeMenu = showContextMenu(
      left,
      bottom,
      `${this.element.getAttribute("aria-label")} のコマンド`,
      [
        ...(commands.length > 0
          ? commands.map((command) => ({
              label: command.name,
              // 名前と内容が食い違っていても、押す前に何が送られるかを確かめられるように、内容の 1 行目と印を出す
              detail: firstLine(command.content),
              mark: command.run ? "⏎" : undefined,
              title: `${command.content}\n\n${command.run ? "選ぶと Enter まで送る（すぐ実行）" : "選ぶと入力だけする"}`,
              ariaLabel: `${command.name}、${firstLine(command.content)}${command.run ? "、Enter まで送る" : ""}`,
              action: () => this.runCommand(command),
            }))
          : [{ label: "登録したコマンドはありません", disabled: true, action: () => {} }]),
        "separator",
        { label: "コマンドを管理…", action: actions.manageCommands },
      ],
      () => this.terminal.focus(),
    );
  }

  // 内容は貼り付けと同じく入力する。改行は CR になり、コマンドがブラケットペーストを有効にしていれば、
  // 全体をブラケットペーストで囲む（docs/adr/35-quick-commands.md）。すぐ実行するものは、続けて Enter を送る
  private runCommand(command: QuickCommand) {
    this.terminal.paste(command.content);
    if (command.run) this.send("\r");
  }

  private async copy() {
    try {
      await navigator.clipboard.writeText(this.terminal.getSelection());
    } catch {
      this.showNotice("クリップボードに書き込めませんでした");
    }
  }

  // クリップボードの読み取りはブラウザの許可が要る。許可されないときは、許可なしで使えるキーボードでのペーストを案内する
  private async paste() {
    try {
      this.terminal.paste(await navigator.clipboard.readText());
    } catch {
      this.showNotice(
        "クリップボードを読み取れませんでした。キーボードでペーストしてください（Mac は Cmd+V、Windows・Linux は Ctrl+V）",
      );
    }
  }

  private showNotice(text: string) {
    this.notice.textContent = text;
    this.notice.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice.hidden = true), 5000);
  }

  // 端末の大きさに満たない余白も、ターミナルの背景色で塗る
  private paintBackground(container: HTMLElement, appearance: Appearance) {
    container.style.background = themeColors(appearance).background ?? "";
  }

  // 自分の選択範囲を、行を出力の始めからの行の番号にして伝える。leaving はターミナルを抜けるとき（選択をやめたと伝える）
  private sendSelection(leaving = false) {
    const position = leaving ? undefined : this.terminal.getSelectionPosition();
    const offset = this.trimmedOffset();
    const range = position && {
      start: { x: position.start.x, y: position.start.y + offset },
      end: { x: position.end.x, y: position.end.y + offset },
    };
    const key = JSON.stringify(range ?? null);
    if (key === this.sentSelection) return;
    this.sentSelection = key;
    this.actions.selected(range);
  }

  // 受け取った選択範囲の行に印を置く。印は、カーソルの行からの相対で置く
  // 範囲が変わっていない参加者の分は、置いてある印をそのまま使う。受け取ったときの行で置き直すと、
  // そのあとにスクロールバックが押し出された分だけ、違う行に出る
  private placeRemoteSelections() {
    const previous = new Map(this.remoteSelections.map((placed) => [placed.key, placed]));
    this.remoteSelections = [];
    const buffer = this.terminal.buffer.active;
    const mark = (y: number) =>
      this.terminal.registerMarker(y - this.trimmedOffset() - (buffer.baseY + buffer.cursorY));
    for (const selection of this.receivedSelections) {
      const { name, color, range } = selection;
      const key = JSON.stringify(selection);
      const kept = previous.get(key);
      if (kept) {
        previous.delete(key);
        this.remoteSelections.push(kept);
        continue;
      }
      const start = mark(range.start.y);
      const end = mark(range.end.y);
      if (!start || !end) {
        start?.dispose();
        end?.dispose();
        continue;
      }
      this.remoteSelections.push({
        key,
        name,
        color,
        buffer: buffer.type,
        start: { x: range.start.x, marker: start },
        end: { x: range.end.x, marker: end },
      });
    }
    for (const { start, end } of previous.values()) {
      start.marker.dispose();
      end.marker.dispose();
    }
    this.drawRemoteSelections();
  }

  // バッファの行と、出力の始めからの行の番号の差。代替画面にはスクロールバックがないので 0
  private trimmedOffset() {
    return this.terminal.buffer.active.type === "normal" ? this.trimmed.count : 0;
  }

  private disposeRemoteSelections() {
    for (const { start, end } of this.remoteSelections) {
      start.marker.dispose();
      end.marker.dispose();
    }
    this.remoteSelections = [];
  }

  // 表示領域に入っている行だけ、行ごとに 1 つの要素で描く。選択した画面（通常・代替）と違う画面を表示しているときや、
  // 終わりの行がスクロールバックから押し出されたときは出さない。始まりの行だけが押し出されたときは、先頭の行から描く
  private drawRemoteSelections() {
    const cell = cellSize(this.terminal);
    const buffer = this.terminal.buffer.active;
    const { cols, rows } = this.terminal;
    const elements: HTMLElement[] = [];
    for (const selection of this.remoteSelections) {
      const { start, end } = selection;
      if (!cell || selection.buffer !== buffer.type || end.marker.isDisposed) continue;
      const startY = start.marker.isDisposed ? 0 : start.marker.line;
      const startX = start.marker.isDisposed ? 0 : start.x;
      const endY = end.marker.line;
      for (let y = Math.max(startY, buffer.viewportY); y <= Math.min(endY, buffer.viewportY + rows - 1); y++) {
        const from = Math.min(y === startY ? startX : 0, cols);
        const to = Math.min(y === endY ? end.x : cols, cols);
        if (to <= from) continue;
        const element = document.createElement("div");
        element.className = "remote-selection";
        element.dataset.member = selection.name;
        element.style.left = `${from * cell.width}px`;
        element.style.top = `${(y - buffer.viewportY) * cell.height}px`;
        element.style.width = `${(to - from) * cell.width}px`;
        element.style.height = `${cell.height}px`;
        element.style.setProperty("--selection-color", selection.color);
        // 参加者の色（#rrggbb）を半透明にして重ね、下の文字が読めるようにする
        element.style.backgroundColor = `${selection.color}59`;
        elements.push(element);
      }
    }
    if (elements.length === 0 && this.remoteLayer.childElementCount === 0) return;
    this.remoteLayer.replaceChildren(...elements);
  }

  private send(data: string) {
    this.socket.send(JSON.stringify({ type: "input", data }));
  }

  // 1 文字の大きさは、開いた直後に測ったものと、描いたあとに測り直したものとで違うことがある（Linux の Chromium で、
  // 9px と 9.03px など）。開いた直後の大きさで伝えたままだと、端末が表示領域から 1 文字分近くはみ出すので、変わったら伝え直す
  private remeasure() {
    if (this.terminal.options.fontSize !== this.appearance.fontSize) return;
    const cell = cellSize(this.terminal);
    if (!cell || (cell.width === this.cell?.width && cell.height === this.cell.height)) return;
    this.sendSize();
  }

  // 自分の表示領域（フル HD まで）に、設定したフォントの大きさで収まる列数・行数と、下限のウィンドウで開いたときの
  // 表示領域に収まる列数・行数を伝える。サーバーは、一番小さい参加者に収まる大きさを、一番大きい参加者に収まる大きさを
  // 超えない範囲で下限まで広げる（docs/adr/99-smallest-size.md）。
  // 拡大中は、拡大で広がった表示領域ではなく、元の分割での表示領域で計算する。広がった表示領域を伝えると、
  // ほかの参加者の端末まで大きくなる（docs/adr/68-zoom.md）
  private sendSize() {
    if (this.terminal.options.fontSize === this.appearance.fontSize) this.cell = cellSize(this.terminal) ?? this.cell;
    const area = this.splitArea();
    if (!this.cell || !area || this.socket.readyState !== WebSocket.OPEN) return;
    const fits = cellsIn(area, this.cell);
    const min = cellsIn(this.minArea(), this.cell);
    this.socket.send(
      JSON.stringify({
        type: "resize",
        cols: Math.max(2, fits.cols),
        rows: Math.max(1, fits.rows),
        minCols: min.cols,
        minRows: min.rows,
      }),
    );
  }

  // 下限のウィンドウで Accompany を開いたときの、ターミナルの表示領域。ウィンドウの大きさから、ブラウザの枠
  // （タブやアドレスバーなど。ウィンドウの外寸と内寸の差）と、Accompany のツールバーとペインのバーの実寸を引く。
  // サイドメニューは、狭いウィンドウでは隠して使うものとして引かない。幅・高さが 0 になる向きには下限を掛けない
  private minArea() {
    const min = this.actions.minWindow();
    if (!min) return { width: 0, height: 0 };
    const toolbar = document.getElementById("tabs")?.offsetHeight ?? 0;
    const width = min.width - Math.max(0, window.outerWidth - window.innerWidth) - (this.element.offsetWidth - this.container.offsetWidth);
    const height = min.height - Math.max(0, window.outerHeight - window.innerHeight) - toolbar - this.bar.offsetHeight;
    return { width: Math.max(0, width), height: Math.max(0, height) };
  }

  // 枠のスクロールを一番下に保つときは、一番下までスクロールする
  private keepAtBottom() {
    if (this.stickToBottom) this.container.scrollTop = this.container.scrollHeight;
  }

  // 「画面に収める（縮小）」のときは、端末全体が表示領域に収まるまでフォントを小さくして描く。
  // CSS の transform で縮めると、xterm がマウスの位置から文字の位置を求める計算がずれるので、フォントの大きさで縮める
  private fitToArea() {
    const configured = this.appearance.fontSize;
    const area = this.area();
    if (this.appearance.overflow !== "fit" || !this.cell || !area) {
      if (this.terminal.options.fontSize !== configured) this.setFontSize(configured);
      return;
    }
    const { cols, rows } = this.terminal;
    const scale = Math.min(
      1,
      (area.width - scrollbarWidth) / (cols * this.cell.width),
      area.height / (rows * this.cell.height),
    );
    let fontSize = Math.max(minFitFontSize, Math.floor(configured * scale * 2) / 2);
    this.setFontSize(fontSize);
    // 1 文字の幅はフォントの大きさにぴったり比例しないので、はみ出していれば少しずつ小さくする
    const fits = () => {
      const cell = cellSize(this.terminal);
      return !cell || (cols * cell.width + scrollbarWidth <= area.width && rows * cell.height <= area.height);
    };
    while (!fits() && fontSize > minFitFontSize) {
      fontSize = Math.max(minFitFontSize, fontSize - 0.5);
      this.setFontSize(fontSize);
    }
  }

  // xterm（6.0）は、フォントの大きさを変えただけではスクロールバックのスクロールバーの高さを計算し直さない。
  // 古い高さのスクロールバーがはみ出して、表示領域のスクロールが余分に出るので、計算し直させる（xterm の内部の API）
  private setFontSize(fontSize: number) {
    this.terminal.options.fontSize = fontSize;
    const viewport = (this.terminal as any)._core._viewport;
    if (typeof viewport?.queueSync === "function") viewport.queueSync();
  }

  // 選んでいる文字（検索のヒット）が表示領域の外にあれば、表示領域の中央に来るようにスクロールする
  private revealSelection() {
    const selection = this.terminal.getSelectionPosition();
    const cell = cellSize(this.terminal);
    const screen = this.terminal.element?.querySelector(".xterm-screen");
    if (!selection || !cell || !screen) return;
    const origin = screen.getBoundingClientRect();
    const area = this.container.getBoundingClientRect();
    const row = selection.start.y - this.terminal.buffer.active.viewportY;
    const target = {
      left: origin.left + selection.start.x * cell.width,
      right: origin.left + selection.end.x * cell.width,
      top: origin.top + row * cell.height,
      bottom: origin.top + (row + 1) * cell.height,
    };
    const visible = {
      left: area.left,
      right: area.left + this.container.clientWidth,
      top: area.top,
      bottom: area.top + this.container.clientHeight,
    };
    if (target.left < visible.left || target.right > visible.right) {
      this.container.scrollLeft += (target.left + target.right - visible.left - visible.right) / 2;
    }
    if (target.top < visible.top || target.bottom > visible.bottom) {
      this.container.scrollTop += (target.top + target.bottom - visible.top - visible.bottom) / 2;
    }
  }

  // 分割での自分の枠の表示領域。拡大中は、元の位置に置いた要素の大きさから、バーなどの分を引いて求める
  private splitArea() {
    if (!this.placeholder) return this.area();
    const width = this.placeholder.offsetWidth - (this.element.offsetWidth - this.container.offsetWidth);
    const height = this.placeholder.offsetHeight - (this.element.offsetHeight - this.container.offsetHeight);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  // 自分の表示領域の大きさ。スクロールバーが出ていても変わらないよう、スクロールバーを含めた大きさを使う
  private area() {
    const { offsetWidth: width, offsetHeight: height } = this.container;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
}

// 出力の URL を新しいタブで開く。開いたページから元のページを操作されないよう、opener を切る。
// javascript: などでスクリプトが動かないよう、xterm.js の絞り込みとは別に、http・https の URL だけを開く（docs/adr/61-link-scheme-check.md）
function openLink(_event: MouseEvent, uri: string) {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const opened = window.open();
  if (!opened) return;
  opened.opener = null;
  opened.location.href = url.href;
}

// 枠のスクロールが一番下にあるか（はみ出していないときも含む）
function isAtBottom(element: HTMLElement) {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
}

// 表示領域（フル HD まで）に収まる列数・行数。xterm のスクロールバックのスクロールバーの分をあける。
// 収まらないときは 0（呼び出し側で、端末の最小の大きさにする）
function cellsIn(area: { width: number; height: number }, cell: CellSize) {
  return {
    cols: Math.max(0, Math.floor((Math.min(area.width, maxArea.width) - scrollbarWidth) / cell.width)),
    rows: Math.max(0, Math.floor(Math.min(area.height, maxArea.height) / cell.height)),
  };
}

// 1 文字の幅と高さ。@xterm/addon-fit と同じく、xterm の内部の値を使う
function cellSize(terminal: Terminal): CellSize | undefined {
  const { width, height } = (terminal as any)._core._renderService.dimensions.css.cell;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function button(label: string, text: string, onClick: (event: MouseEvent) => void, title = label) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = title;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", onClick);
  return element;
}
