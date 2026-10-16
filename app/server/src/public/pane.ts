import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { themeColors, type Appearance } from "./appearance";
import { acceptFileDrop } from "./file-drop";
import { isSearchKey, SearchBar } from "./search";
import { showContextMenu } from "./context-menu";
import { firstLine, type QuickCommand } from "./quick-commands";
import { shortcutFor, withKeys, type Shortcut } from "./shortcuts";

const protocol = location.protocol === "https:" ? "wss:" : "ws:";

export type PaneActions = {
  split: (direction: "row" | "column") => void;
  close: () => void;
  // キー入力の先がこのターミナルに移ったとき
  focused: () => void;
  // このターミナルにキー入力しているときに押されたキーボードショートカット
  shortcut: (shortcut: Shortcut) => void;
  // 参加者全員で共有している、よく使うコマンドの一覧と、その登録・編集・削除の画面を開く
  commands: () => QuickCommand[];
  manageCommands: () => void;
};

// このターミナルで動いているエージェントの状態。サーバーが判定して全員に配る
export type AgentStatus = "working" | "idle";
const statusLabels: Record<AgentStatus, string> = { working: "作業中", idle: "入力待ち" };

// このターミナルにフォーカスしている参加者
export type Viewer = { name: string; color: string; self: boolean };

// 端末の大きさを決めるとき、各参加者の表示領域はこの大きさ（フル HD）までとみなす（docs/adr/51-largest-size.md）
const maxArea = { width: 1920, height: 1080 };
// xterm のスクロールバックのスクロールバーの幅（@xterm/addon-fit と同じ値）
const scrollbarWidth = 14;
// 画面に収めるために縮小するとき、フォントの大きさをどこまで小さくするか
const minFitFontSize = 2;
type CellSize = { width: number; height: number };

// 1 つのターミナルの表示。配置が変わっても同じ要素と接続を使い回す
export class Pane {
  readonly element = document.createElement("section");
  private closeButton: HTMLButtonElement;
  private viewers = document.createElement("span");
  private program = document.createElement("span");
  private status = document.createElement("span");
  private terminal: Terminal;
  private container = document.createElement("div");
  private appearance: Appearance;
  // 設定したフォントの大きさでの 1 文字の幅と高さ。縮小して表示している間も、伝える大きさはこれで計算する
  private cell: CellSize | undefined;
  private socket: WebSocket;
  private resizeObserver: ResizeObserver;
  private search: SearchBar;
  private notice = document.createElement("div");
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // 開いている右クリックメニューを閉じる。ターミナルがなくなったら、メニューも閉じる
  private closeMenu = () => {};

  constructor(id: string, actions: PaneActions, appearance: Appearance) {
    this.appearance = appearance;
    // 配色とフォントの大きさは、作るときから渡す（あとから変えると、そのぶん描き直しが増える）
    this.terminal = new Terminal({
      // 検索のヒットの強調（decorations）に、xterm の試験的な API を使う
      allowProposedApi: true,
      theme: themeColors(appearance),
      fontSize: appearance.fontSize,
    });
    this.search = new SearchBar(this.terminal, () => this.revealSelection());
    this.element.className = "pane";
    this.element.setAttribute("aria-label", `ターミナル ${id}`);

    const bar = document.createElement("div");
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
    this.setStatus("idle");
    bar.append(
      title,
      this.program,
      this.status,
      this.viewers,
      button("コマンド", "❯", (event) => this.openCommands(event.currentTarget as HTMLElement, actions)),
      button("検索", "⌕", () => this.search.open()),
      button("右に分割", "⇥", () => actions.split("row"), withKeys("右に分割")),
      button("下に分割", "⤓", () => actions.split("column"), withKeys("下に分割")),
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
    // 出力の URL をクリックで開く。開いたページから元のページを操作されないよう、opener を切って新しいタブで開く
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.open(container);

    this.socket = new WebSocket(`${protocol}//${location.host}/ws/terminals/${id}`);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.sendSize();
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "resize") {
          this.terminal.resize(message.cols, message.rows);
          this.fitToArea();
        }
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

    // 端末の大きさは参加者のうち一番大きい表示領域に合わせるため、自分の表示領域に収まる大きさをサーバーに伝え、
    // サーバーが決めた大きさで描く。表示領域に収まらない部分は、スクロールするか縮小して見る
    this.resizeObserver = new ResizeObserver(() => {
      this.sendSize();
      this.fitToArea();
    });
    this.resizeObserver.observe(container);
  }

  // フォーカスしている参加者を、バーに名前で出す。自分がフォーカスしていれば枠を自分の色で強調する
  setViewers(viewers: Viewer[]) {
    this.viewers.replaceChildren(
      ...viewers.map((viewer) => {
        const badge = document.createElement("span");
        badge.className = "viewer";
        badge.textContent = viewer.self ? "あなた" : viewer.name;
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

  setStatus(status: AgentStatus) {
    this.status.textContent = statusLabels[status];
    this.status.dataset.status = status;
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

  setClosable(closable: boolean) {
    this.closeButton.disabled = !closable;
  }

  focus() {
    this.terminal.focus();
  }

  dispose() {
    clearTimeout(this.noticeTimer);
    this.closeMenu();
    this.resizeObserver.disconnect();
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

  private send(data: string) {
    this.socket.send(JSON.stringify({ type: "input", data }));
  }

  // 自分の表示領域（フル HD まで）に、設定したフォントの大きさで収まる列数・行数を伝える
  private sendSize() {
    if (this.terminal.options.fontSize === this.appearance.fontSize) this.cell = cellSize(this.terminal) ?? this.cell;
    const area = this.area();
    if (!this.cell || !area || this.socket.readyState !== WebSocket.OPEN) return;
    const cols = Math.max(2, Math.floor((Math.min(area.width, maxArea.width) - scrollbarWidth) / this.cell.width));
    const rows = Math.max(1, Math.floor(Math.min(area.height, maxArea.height) / this.cell.height));
    this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
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

  // 自分の表示領域の大きさ。スクロールバーが出ていても変わらないよう、スクロールバーを含めた大きさを使う
  private area() {
    const { offsetWidth: width, offsetHeight: height } = this.container;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
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
