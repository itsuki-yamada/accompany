import { Pane, type Viewer } from "./pane";

type Layout =
  | { type: "terminal"; id: string }
  | { type: "split"; id: string; direction: "row" | "column"; ratio: number; children: [Layout, Layout] };

const root = document.getElementById("workspace")!;
const panes = new Map<string, Pane>();

// 参加者とそのフォーカス先。自分が誰かはサーバーが最初に教えてくれる
type Member = { id: number; name: string; color: string; terminal?: string };
let you: number | undefined;
let members: Member[] = [];

const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws/workspace`);
const send = (message: object) => socket.send(JSON.stringify(message));

// 分割の配置は参加者全員で共有する。サーバーから届くたびに組み直す。
// ただし境界をドラッグしている間は、組み直すとドラッグ中の境界がなくなるので、手を離すまで待つ
let dragging = false;
let deferredLayout: Layout | undefined;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "welcome") {
    you = message.you;
  } else if (message.type === "presence") {
    members = message.members;
    showViewers();
  } else if (message.type === "layout") {
    if (dragging) deferredLayout = message.layout;
    else render(message.layout);
  }
};

function render(layout: Layout) {
  const ids = new Set(terminalIds(layout));
  for (const [id, pane] of panes) {
    if (!ids.has(id)) {
      pane.dispose();
      panes.delete(id);
    }
  }
  const isFirstRender = panes.size === 0;
  const element = build(layout);
  // 分割の子だったときの割合が残らないよう、一番外側は画面いっぱいに広げる
  element.style.flex = "1 1 0";
  root.replaceChildren(element);
  panes.forEach((pane) => pane.setClosable(ids.size > 1));
  showViewers();
  if (isFirstRender) panes.values().next().value?.focus();
}

function build(node: Layout): HTMLElement {
  if (node.type === "terminal") return paneFor(node.id).element;

  const split = document.createElement("div");
  split.className = `split split-${node.direction}`;
  const [first, second] = node.children.map(build);
  first.style.flex = `${node.ratio} 1 0`;
  second.style.flex = `${1 - node.ratio} 1 0`;
  split.append(first, divider(split, node, first, second), second);
  return split;
}

function paneFor(id: string) {
  let pane = panes.get(id);
  if (!pane) {
    pane = new Pane(id, {
      split: (direction) => send({ type: "split", terminal: id, direction }),
      close: () => send({ type: "close", terminal: id }),
      focused: () => send({ type: "focus", terminal: id }),
    });
    panes.set(id, pane);
  }
  return pane;
}

// 境界をドラッグして割合を変える。手元ではすぐに反映し、サーバー経由で全員に配る
function divider(split: HTMLElement, node: Extract<Layout, { type: "split" }>, first: HTMLElement, second: HTMLElement) {
  const element = document.createElement("div");
  element.className = "divider";
  element.setAttribute("role", "separator");
  element.setAttribute("aria-orientation", node.direction === "row" ? "vertical" : "horizontal");
  element.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    element.setPointerCapture(down.pointerId);
    dragging = true;
    const move = (event: PointerEvent) => {
      const rect = split.getBoundingClientRect();
      const ratio =
        node.direction === "row"
          ? (event.clientX - rect.left) / rect.width
          : (event.clientY - rect.top) / rect.height;
      const clamped = Math.min(0.9, Math.max(0.1, ratio));
      first.style.flex = `${clamped} 1 0`;
      second.style.flex = `${1 - clamped} 1 0`;
      send({ type: "resize-split", split: node.id, ratio: clamped });
    };
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      dragging = false;
      if (deferredLayout) render(deferredLayout);
      deferredLayout = undefined;
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
  });
  return element;
}

function showViewers() {
  for (const [id, pane] of panes) {
    const viewers: Viewer[] = members
      .filter((m) => m.terminal === id)
      .map((m) => ({ name: m.name, color: m.color, self: m.id === you }));
    pane.setViewers(viewers);
  }
}

function terminalIds(node: Layout): string[] {
  return node.type === "terminal" ? [node.id] : node.children.flatMap(terminalIds);
}
