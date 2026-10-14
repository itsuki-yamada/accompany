import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { createMiddleware } from "hono/factory";
import type { TerminalSession } from "./terminal";

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

export function createApp(session: TerminalSession) {
  const app = new Hono();

  app.get(
    "/ws",
    sameOriginOnly,
    upgradeWebSocket(() => {
      let detach: (() => void) | undefined;
      return {
        onOpen: (_event, ws) => {
          detach = session.attach((data) => ws.send(data));
        },
        onMessage: (event) => session.write(String(event.data)),
        onClose: () => detach?.(),
      };
    }),
  );

  return app;
}
