import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { acceptFileDrop } from "./file-drop";
import { isSearchKey, SearchBar } from "./search";
import { showContextMenu } from "./context-menu";

const protocol = location.protocol === "https:" ? "wss:" : "ws:";

export type PaneActions = {
  split: (direction: "row" | "column") => void;
  close: () => void;
  // キー入力の先がこのターミナルに移ったとき
  focused: () => void;
};

// このターミナルにフォーカスしている参加者
export type Viewer = { name: string; color: string; self: boolean };

// 1 つのターミナルの表示。配置が変わっても同じ要素と接続を使い回す
export class Pane {
  readonly element = document.createElement("section");
  private closeButton: HTMLButtonElement;
  private viewers = document.createElement("span");
  private program = document.createElement("span");
  // 検索のヒットの強調（decorations）に、xterm の試験的な API を使う
  private terminal = new Terminal({ allowProposedApi: true });
  private fit = new FitAddon();
  private socket: WebSocket;
  private resizeObserver: ResizeObserver;
  private search = new SearchBar(this.terminal);
  private notice = document.createElement("div");
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // 開いている右クリックメニューを閉じる。ターミナルがなくなったら、メニューも閉じる
  private closeMenu = () => {};

  constructor(id: string, actions: PaneActions) {
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
    bar.append(
      title,
      this.program,
      this.viewers,
      button("検索", "⌕", () => this.search.open()),
      button("右に分割", "⇥", () => actions.split("row")),
      button("下に分割", "⤓", () => actions.split("column")),
      (this.closeButton = button("閉じる", "×", actions.close)),
    );
    const container = document.createElement("div");
    container.className = "pane-terminal";
    this.notice.className = "pane-notice";
    this.notice.setAttribute("role", "alert");
    this.notice.hidden = true;
    this.element.append(bar, this.search.element, container, this.notice);

    // 検索バーを開くキーは、xterm やブラウザ（ページ内検索）より先に拾う
    this.element.addEventListener(
      "keydown",
      (event) => {
        if (!isSearchKey(event)) return;
        event.preventDefault();
        event.stopPropagation();
        this.search.open();
      },
      { capture: true },
    );

    this.terminal.loadAddon(this.fit);
    // 出力の URL をクリックで開く。開いたページから元のページを操作されないよう、opener を切って新しいタブで開く
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.open(container);

    this.socket = new WebSocket(`${protocol}//${location.host}/ws/terminals/${id}`);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => this.sendSize();
    this.socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "resize") this.terminal.resize(message.cols, message.rows);
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

    // 端末の大きさは参加者のうち一番小さい表示領域に合わせるため、自分の表示領域に収まる大きさをサーバーに伝え、
    // サーバーが決めた大きさで描く
    this.resizeObserver = new ResizeObserver(() => this.sendSize());
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

  private send(data: string) {
    this.socket.send(JSON.stringify({ type: "input", data }));
  }

  private sendSize() {
    const size = this.fit.proposeDimensions();
    if (size && size.cols > 0 && size.rows > 0 && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    }
  }
}

function button(label: string, text: string, onClick: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = label;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", onClick);
  return element;
}
