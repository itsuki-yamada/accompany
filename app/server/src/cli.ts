#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { websocket } from "hono/bun";
import { createApp } from "./app";
import index from "./public/index.html";
import { TerminalSession } from "./terminal";

// accompany [--port <port>] [-- <command...>]
const { values, positionals } = parseArgs({
  options: { port: { type: "string", default: "3000" } },
  allowPositionals: true,
});

const command = positionals.length > 0 ? positionals : [process.env.SHELL ?? "/bin/sh"];
const session = new TerminalSession(command);
const app = createApp(session);

const server = Bun.serve({
  port: Number(values.port),
  development: false,
  routes: { "/": index },
  fetch: app.fetch,
  websocket,
});

// PTY のコマンドは別セッションで動くため、Accompany を止めるときに明示的に止める
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    session.kill();
    process.exit(0);
  });
}

console.log(`Accompany: http://localhost:${server.port}`);
