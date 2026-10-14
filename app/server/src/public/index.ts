import { Terminal } from "@xterm/xterm";

const terminal = new Terminal();
terminal.open(document.getElementById("terminal")!);
terminal.focus();

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws`);
socket.binaryType = "arraybuffer";
socket.onmessage = (event) => terminal.write(new Uint8Array(event.data));
terminal.onData((data) => socket.send(data));
