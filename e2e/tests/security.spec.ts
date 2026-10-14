import { request } from "node:http";
import { expect, test } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";

const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];

let accompany: Accompany | undefined;

test.afterEach(() => accompany?.stop());

// ブラウザによっては外部サイトから localhost への接続を止めるが、それに頼らずサーバー側で拒否することを確かめるため、
// ヘッダーを指定して端末の WebSocket に直接接続し、応答のステータスを返す
function connectTerminal(port: string, headers: { Host: string; Origin: string }) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/ws",
      headers: {
        ...headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", reject);
    req.end();
  });
}

test("Accompany の画面からは、端末の WebSocket につながる", async () => {
  accompany = await startAccompany(fakeAgent);
  const { port } = new URL(accompany.url);

  const status = await connectTerminal(port, {
    Host: `localhost:${port}`,
    Origin: `http://localhost:${port}`,
  });

  expect(status).toBe(101);
});

test("別のサイトのページからは、端末の WebSocket につながらない", async () => {
  accompany = await startAccompany(fakeAgent);
  const { port } = new URL(accompany.url);

  const status = await connectTerminal(port, {
    Host: `localhost:${port}`,
    Origin: "http://evil.test",
  });

  expect(status).toBe(403);
});

test("localhost 以外のホスト名で届いた接続は、端末の WebSocket につながらない（DNS rebinding 対策）", async () => {
  accompany = await startAccompany(fakeAgent);
  const { port } = new URL(accompany.url);

  // DNS rebinding では Host と Origin が攻撃者のドメインでそろう
  const status = await connectTerminal(port, {
    Host: `evil.test:${port}`,
    Origin: `http://evil.test:${port}`,
  });

  expect(status).toBe(403);
});
