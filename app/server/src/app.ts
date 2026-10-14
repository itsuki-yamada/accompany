import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { TerminalSession } from "./terminal";

export function createApp(session: TerminalSession) {
  const app = new Hono();

  app.get(
    "/ws",
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
