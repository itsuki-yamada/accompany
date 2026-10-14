import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { createMiddleware } from "hono/factory";
import type { Participant, Size } from "./terminal";
import type { Workspace } from "./workspace";

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

// ブラウザから届く制御メッセージ。大きさは、端末として扱える範囲の整数だけを受け付ける
function parseSize(message: { cols?: unknown; rows?: unknown }): Size | undefined {
  const { cols, rows } = message;
  const valid = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;
  return valid(cols) && valid(rows) ? { cols, rows } : undefined;
}

function parseJson(data: unknown) {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined; // 制御メッセージとして読めないものは無視する
  }
}

export function createApp(workspace: Workspace) {
  const app = new Hono();

  app.use("/ws/*", sameOriginOnly);

  // 分割の配置と、参加者ごとのフォーカス先を全員に配り、分割・閉じる・割合の変更・フォーカスの移動を受け付ける
  app.get(
    "/ws/workspace",
    upgradeWebSocket(() => {
      let member: ReturnType<Workspace["join"]> | undefined;
      return {
        onOpen: (_event, ws) => {
          member = workspace.join((event) => ws.send(JSON.stringify(event)));
        },
        onMessage: (event) => {
          const message = parseJson(event.data);
          if (message?.type === "split" && (message.direction === "row" || message.direction === "column")) {
            workspace.split(String(message.terminal), message.direction);
          } else if (message?.type === "close") {
            workspace.close(String(message.terminal));
          } else if (message?.type === "resize-split" && typeof message.ratio === "number") {
            workspace.resizeSplit(String(message.split), message.ratio);
          } else if (message?.type === "focus") {
            member?.focus(String(message.terminal));
          }
        },
        onClose: () => member?.leave(),
      };
    }),
  );

  // ターミナルごとの入出力。出力はバイナリで、端末の大きさの変更は JSON で送る
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
              ? ws.send(message.data)
              : ws.send(JSON.stringify({ type: "resize", ...message.size })),
          );
        },
        onMessage: (event) => {
          const message = parseJson(event.data);
          if (message?.type === "input" && typeof message.data === "string") {
            session.write(message.data);
          } else if (message?.type === "resize") {
            const size = parseSize(message);
            if (size) participant?.resize(size);
          }
        },
        onClose: () => participant?.detach(),
      };
    }),
  );

  return app;
}
