#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { websocket } from "hono/bun";
import { createApp } from "./app";
import index from "./public/index.html";
import { Workspace } from "./workspace";

// accompany [--port <port>] [-- <command...>]
const { values, positionals } = parseArgs({
  options: { port: { type: "string", default: "3000" } },
  allowPositionals: true,
});

const shell = [process.env.SHELL ?? "/bin/sh"];
const workspace = new Workspace(positionals.length > 0 ? positionals : shell, shell);
const app = createApp(workspace);

// 認証がないため、同じネットワークの他のマシンからは操作できないよう loopback だけで待ち受ける
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(values.port),
  development: false,
  // 本番モードの既定では同じポートで二重に待ち受けてしまい、接続がどちらのコマンドにつながるか分からなくなる
  reusePort: false,
  routes: { "/": index },
  fetch: app.fetch,
  websocket,
});

// PTY のコマンドは別セッションで動くため、Accompany を止めるときに明示的に止める
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    workspace.killAll();
    process.exit(0);
  });
}

// localhost は環境によって ::1 に解決されるため、待ち受けているアドレスをそのまま表示する
console.log(`Accompany: http://${server.hostname}:${server.port}`);
