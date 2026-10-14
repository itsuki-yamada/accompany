import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const protocol = location.protocol === "https:" ? "wss:" : "ws:";

export type PaneActions = {
  split: (direction: "row" | "column") => void;
  close: () => void;
};

// 1 つのターミナルの表示。配置が変わっても同じ要素と接続を使い回す
export class Pane {
  readonly element = document.createElement("section");
  private closeButton: HTMLButtonElement;
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
    title.textContent = `ターミナル ${id}`;
    bar.append(
      title,
      button("右に分割", "⇥", () => actions.split("row")),
      button("下に分割", "⤓", () => actions.split("column")),
      (this.closeButton = button("閉じる", "×", actions.close)),
    );
    const container = document.createElement("div");
    container.className = "pane-terminal";
    this.element.append(bar, container);

    this.terminal.loadAddon(this.fit);
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
    this.terminal.onData((data) => this.socket.send(JSON.stringify({ type: "input", data })));

    // 端末の大きさは参加者のうち一番小さい表示領域に合わせるため、自分の表示領域に収まる大きさをサーバーに伝え、
    // サーバーが決めた大きさで描く
    this.resizeObserver = new ResizeObserver(() => this.sendSize());
    this.resizeObserver.observe(container);
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
