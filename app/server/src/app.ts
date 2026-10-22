import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { createMiddleware } from "hono/factory";
import { sanitizeName } from "./member-name";
import { parseMinWindow } from "./min-window";
import { parseQuickCommand } from "./quick-commands";
import { scrollback } from "./scrollback";
import { clampSize, maxSize, type Participant, type Requested } from "./terminal";
import { maxUploadBytes, type Uploads } from "./uploads";
import type { Position, SelectionRange, Workspace } from "./workspace";

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

// 端末はサーバー上のコマンドをそのまま操作できるため、Accompany 自身の画面からの接続だけを受け付ける
// - Host を loopback に限り、DNS rebinding で攻撃者のドメインから届く接続を拒否する
// - Origin を Host と同じオリジンに限り、別サイトのページからの接続を拒否する
const sameOriginOnly = createMiddleware(async (c, next) => {
  const host = c.req.header("Host") ?? "";
  const origin = c.req.header("Origin");
  const hostname = URL.parse(`http://${host}`)?.hostname ?? "";
  if (!loopbackHostnames.has(hostname) || origin !== `http://${host}`) {
    return c.text("Forbidden", 403);
  }
  await next();
});

// ブラウザから届く制御メッセージ。表示領域に収まる大きさ（cols・rows）は 1 以上、下限のウィンドウに収まる大きさ
// （minCols・minRows。docs/adr/99-smallest-size.md）は 0 以上の整数だけを受け付け、上限（maxSize）を超えるものは上限に丸める。
// 下限の大きさがない（下限を送らない古いブラウザ）ときは、min なしで受け付ける
function parseSize(message: Record<string, unknown>): Requested | undefined {
  const { cols, rows, minCols, minRows } = message;
  const valid = (n: unknown, min: number): n is number => Number.isSafeInteger(n) && (n as number) >= min;
  if (!valid(cols, 1) || !valid(rows, 1)) return;
  const fits = clampSize({ cols, rows });
  if (minCols === undefined && minRows === undefined) return { fits };
  if (!valid(minCols, 0) || !valid(minRows, 0)) return;
  return { fits, min: clampSize({ cols: minCols, rows: minRows }) };
}

// 選択範囲として受け付ける行の数。ブラウザの端末のバッファは、スクロールバックと画面の行数（上限は maxSize.rows）まで
const maxSelectionLines = scrollback + maxSize.rows;

// ブラウザから届く選択範囲。列は 0 以上で端末の列数の上限まで、行は 0 以上の整数（出力の始めからの行の番号なので、上限は設けない）。
// 範囲の行の数がバッファに収まらないもの、始まりが終わりより後ろのものは捨てる。
// start と end がどちらもなければ、選択をやめた（null）
function parseSelection(message: { start?: unknown; end?: unknown }): SelectionRange | null | undefined {
  const { start, end } = message;
  if (start === undefined && end === undefined) return null;
  const valid = (n: unknown, max: number): n is number =>
    Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
  const position = (value: unknown): Position | undefined => {
    const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
    return valid(x, maxSize.cols) && valid(y, Number.MAX_SAFE_INTEGER) ? { x, y } : undefined;
  };
  const from = position(start);
  const to = position(end);
  if (!from || !to || from.y > to.y || (from.y === to.y && from.x > to.x)) return undefined;
  if (to.y - from.y >= maxSelectionLines) return undefined;
  return { start: from, end: to };
}

// この大きさ以上のメッセージは、WebSocket の圧縮（permessage-deflate）をかけて送る。途中から開いた人に送る画面
// （スクロールバックを含み、全部で数百 KB になる）や、まとまった出力のため。打った文字のエコーのような小さいものは、
// 縮む量より手間のほうが大きいので、そのまま送る（docs/adr/111-loading.md）
const compressFrom = 1024;

function send(ws: WSContext, data: string | Uint8Array) {
  const size = typeof data === "string" ? data.length : data.byteLength;
  ws.send(data, { compress: size >= compressFrom });
}

function parseJson(data: unknown) {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined; // 制御メッセージとして読めないものは無視する
  }
}

export function createApp(workspace: Workspace, uploads: Uploads) {
  const app = new Hono();

  app.use("/ws/*", sameOriginOnly);
  app.use("/api/*", sameOriginOnly);

  // タブの並び、参加者ごとの名前・フォーカス先と選択範囲・ペアプロモードで追従している相手・スクロール位置、
  // よく使うコマンドの一覧を全員に、その参加者の表示（どのタブをどう並べているか）を本人に配る。
  // 自分の表示の変更（新しいタブ・分割・タブを選ぶ・並べる・外す・割合の変更）、タブの並べ替えと閉じる、フォーカスの移動・選択範囲・
  // ページが見えているか、名前の変更、ペアプロモードの開始・終了とスクロール位置、よく使うコマンドの登録・編集・削除、
  // 端末の大きさの下限の変更を受け付ける（docs/adr/100-terminal-tabs.md）
  app.get(
    "/ws/workspace",
    upgradeWebSocket(() => {
      let member: ReturnType<Workspace["join"]> | undefined;
      return {
        onOpen: (_event, ws) => {
          member = workspace.join((event) => send(ws, JSON.stringify(event)));
        },
        onMessage: (event) => {
          const message = parseJson(event.data);
          const terminal = typeof message?.terminal === "string" ? message.terminal : undefined;
          if (message?.type === "split" && (message.direction === "row" || message.direction === "column")) {
            void member?.split(String(message.terminal), message.direction);
          } else if (message?.type === "move-tab" && typeof message.tab === "string" && Number.isSafeInteger(message.index)) {
            // ないタブや範囲外の位置は、workspace が無視する
            workspace.moveTab(message.tab, message.index);
          } else if (message?.type === "close") {
            workspace.close(String(message.terminal));
          } else if (message?.type === "resize-split" && typeof message.ratio === "number") {
            member?.resizeSplit(String(message.split), message.ratio);
          } else if (message?.type === "new-tab") {
            void member?.newTab(terminal);
          } else if (message?.type === "select-tab") {
            member?.selectTab(String(message.tab));
          } else if (message?.type === "add-to-view") {
            member?.addToView(String(message.tab), terminal);
          } else if (message?.type === "remove-from-view") {
            member?.removeFromView(String(message.tab));
          } else if (message?.type === "focus") {
            member?.focus(String(message.terminal));
          } else if (message?.type === "select") {
            const range = parseSelection(message);
            if (range !== undefined) member?.select(String(message.terminal), range ?? undefined);
          } else if (message?.type === "visibility") {
            member?.visible(message.visible === true);
          } else if (message?.type === "name" && typeof message.name === "string") {
            // 全員に配るので、サーバーで整える。空なら「参加者 N」に戻す
            member?.rename(sanitizeName(message.name));
          } else if (message?.type === "follow") {
            // 参加者の番号でないもの（null など）は、ペアプロモードをやめたものとする
            member?.follow(Number.isSafeInteger(message.member) ? message.member : undefined);
          } else if (message?.type === "scroll" && Number.isSafeInteger(message.offset) && message.offset >= 0) {
            // 全員に配るので、あるターミナルのものだけを受け付ける
            const terminal = String(message.terminal);
            if (workspace.terminal(terminal)) member?.scroll(terminal, message.offset);
          } else if (message?.type === "add-command" || message?.type === "update-command") {
            const command = parseQuickCommand(message);
            if (!command) return;
            if (message.type === "add-command") workspace.addCommand(command);
            else workspace.updateCommand(String(message.id), command);
          } else if (message?.type === "remove-command") {
            workspace.removeCommand(String(message.id));
          } else if (message?.type === "set-min-window") {
            const minWindow = parseMinWindow(message);
            if (minWindow) workspace.setMinWindow(minWindow);
          }
        },
        onClose: () => member?.leave(),
      };
    }),
  );

  // ターミナルごとの入出力とリセット。出力はバイナリで、端末の大きさの変更は JSON で送る
  app.get(
    "/ws/terminals/:id",
    async (c, next) => (workspace.terminal(c.req.param("id")) ? next() : c.text("Not Found", 404)),
    upgradeWebSocket((c) => {
      const session = workspace.terminal(c.req.param("id"))!;
      let participant: Participant | undefined;
      return {
        onOpen: (_event, ws) => {
          participant = session.attach((message) =>
            message.type === "output"
              ? send(ws, message.data)
              : send(ws, JSON.stringify(message.type === "resize" ? { type: "resize", ...message.size } : message)),
          );
        },
        onMessage: (event) => {
          const message = parseJson(event.data);
          if (message?.type === "input" && typeof message.data === "string") {
            session.write(message.data);
          } else if (message?.type === "reset") {
            session.reset();
          } else if (message?.type === "resize") {
            const size = parseSize(message);
            if (size) participant?.resize(size);
          }
        },
        onClose: () => participant?.detach(),
      };
    }),
  );

  // ターミナルにドロップされたファイルを保存し、保存先のパスを返す。パスはブラウザがターミナルに貼り付ける
  app.post(
    "/api/uploads",
    bodyLimit({ maxSize: maxUploadBytes, onError: (c) => c.text("Payload Too Large", 413) }),
    async (c) => {
      const form = await c.req.formData().catch(() => undefined);
      const files = form?.getAll("files").filter((f): f is File => f instanceof File) ?? [];
      if (files.length === 0) return c.text("Bad Request", 400);
      return c.json({ paths: await uploads.save(files) });
    },
  );

  return app;
}
