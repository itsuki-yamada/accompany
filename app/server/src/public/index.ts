import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

const terminal = new Terminal();
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById("terminal")!);
terminal.focus();

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws`);
socket.binaryType = "arraybuffer";

// 端末の大きさは参加者のうち一番小さい画面に合わせるため、自分の画面に収まる大きさをサーバーに伝え、
// サーバーが決めた大きさで描く
const sendSize = () => {
  const size = fit.proposeDimensions();
  if (size && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
  }
};
socket.onopen = sendSize;
window.addEventListener("resize", sendSize);

socket.onmessage = (event) => {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data);
    if (message.type === "resize") terminal.resize(message.cols, message.rows);
  } else {
    terminal.write(new Uint8Array(event.data));
  }
};
terminal.onData((data) => socket.send(JSON.stringify({ type: "input", data })));
