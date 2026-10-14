import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

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
  private terminal = new Terminal();
  private fit = new FitAddon();
  private socket: WebSocket;
  private resizeObserver: ResizeObserver;

  constructor(id: string, actions: PaneActions) {
    this.element.className = "pane";
    this.element.setAttribute("aria-label", `ターミナル ${id}`);

    const bar = document.createElement("div");
    bar.className = "pane-bar";
    const title = document.createElement("span");
    title.className = "pane-title";
    title.textContent = `ターミナル ${id}`;
    this.viewers.className = "pane-viewers";
    this.viewers.setAttribute("role", "status");
    bar.append(
      title,
      this.viewers,
      button("右に分割", "⇥", () => actions.split("row")),
      button("下に分割", "⤓", () => actions.split("column")),
      (this.closeButton = button("閉じる", "×", actions.close)),
    );
    const container = document.createElement("div");
    container.className = "pane-terminal";
    this.element.append(bar, container);

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
        event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (!shiftEnter) return true;
      if (event.type === "keydown") this.send("\x1b\r");
      event.preventDefault();
      return false;
    });
    this.terminal.textarea?.addEventListener("focus", actions.focused);

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

  setClosable(closable: boolean) {
    this.closeButton.disabled = !closable;
  }

  focus() {
    this.terminal.focus();
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.socket.close();
    this.terminal.dispose();
    this.element.remove();
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
