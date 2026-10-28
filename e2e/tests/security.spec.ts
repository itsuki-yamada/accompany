import { createServer, request, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";

const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];

let accompany: Accompany | undefined;
let embedder: Server | undefined;

test.afterEach(async () => {
  await accompany?.stop();
  await new Promise((resolve) => (embedder ? embedder.close(resolve) : resolve(undefined)));
  embedder = undefined;
});

// ブラウザによっては外部サイトから localhost への接続を止めるが、それに頼らずサーバー側で拒否することを確かめるため、
// ヘッダーを指定して WebSocket に直接接続し、応答のステータスを返す
function connect(path: string, port: string, headers: { Host: string; Origin: string }) {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
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

// 端末はサーバー上のコマンドを操作でき、配置の WebSocket からはターミナルを増やせるので、どちらも守る
for (const [name, path] of [
  ["ターミナル", "/ws/terminals/1"],
  ["画面の配置", "/ws/workspace"],
] as const) {
  test(`Accompany の画面からは、${name}の WebSocket につながる`, async () => {
    accompany = await startAccompany(fakeAgent);
    const { port } = new URL(accompany.url);

    const status = await connect(path, port, {
      Host: `localhost:${port}`,
      Origin: `http://localhost:${port}`,
    });

    expect(status).toBe(101);
  });

  test(`別のサイトのページからは、${name}の WebSocket につながらない`, async () => {
    accompany = await startAccompany(fakeAgent);
    const { port } = new URL(accompany.url);

    const status = await connect(path, port, {
      Host: `localhost:${port}`,
      Origin: "http://evil.test",
    });

    expect(status).toBe(403);
  });

  test(`localhost 以外のホスト名で届いた接続は、${name}の WebSocket につながらない（DNS rebinding 対策）`, async () => {
    accompany = await startAccompany(fakeAgent);
    const { port } = new URL(accompany.url);

    // DNS rebinding では Host と Origin が攻撃者のドメインでそろう
    const status = await connect(path, port, {
      Host: `evil.test:${port}`,
      Origin: `http://evil.test:${port}`,
    });

    expect(status).toBe(403);
  });
}

// ファイルをアップロードし、応答のステータスを返す。ブラウザを通さずに、Host と Origin を指定して直接送る
function upload(port: string, headers: { Host: string; Origin: string }) {
  const boundary = "accompany-e2e-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="files"; filename="note.txt"',
    "Content-Type: text/plain",
    "",
    "hello",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/uploads",
      headers: {
        ...headers,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": Buffer.byteLength(body),
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end(body);
  });
}

// アップロードしたファイルはサーバー上に保存され、パスがターミナルに貼り付けられるので、WebSocket と同じく守る
test("Accompany の画面からは、ファイルをアップロードできる", async () => {
  accompany = await startAccompany(fakeAgent);
  const { port } = new URL(accompany.url);

  const status = await upload(port, { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });

  expect(status).toBe(200);
});

test("別のサイトのページからは、ファイルをアップロードできない", async () => {
  accompany = await startAccompany(fakeAgent);
  const { port } = new URL(accompany.url);

  const status = await upload(port, { Host: `localhost:${port}`, Origin: "http://evil.test" });

  expect(status).toBe(403);
});

test("localhost 以外のホスト名で届いたアップロードは受け付けない（DNS rebinding 対策）", async () => {
  accompany = await startAccompany(fakeAgent);
  const { port } = new URL(accompany.url);

  const status = await upload(port, { Host: `evil.test:${port}`, Origin: `http://evil.test:${port}` });

  expect(status).toBe(403);
});

// 別のオリジン（localhost の別のポート）で、Accompany を iframe で埋め込むページを配り、そのページを開く。
// iframe の読み込みが終わる（埋め込みを拒まれたときも load は起きる）まで待つ
async function openEmbedder(page: Page, url: string) {
  const html = `<!doctype html><iframe src="${url}" onload="document.body.dataset.loaded = 'true'"></iframe>`;
  embedder = createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end(html));
  await new Promise<void>((resolve) => embedder!.listen(0, "127.0.0.1", resolve));
  const { port } = embedder.address() as { port: number };
  await page.goto(`http://localhost:${port}/`);
  await expect(page.locator("body[data-loaded]")).toHaveCount(1);
}

// 埋め込まれると、見えない形で重ねたボタン（run: true のクイックコマンドなど）を押させるクリックジャッキングができる（#185）
test("別のオリジンのページに iframe で埋め込まれても、Accompany の画面は表示されない", async ({ page }) => {
  accompany = await startAccompany(fakeAgent);

  await openEmbedder(page, accompany.url);

  await expect(page.frameLocator("iframe").locator("#workspace")).toHaveCount(0);
});

// VS Code の拡張は、webview（vscode-webview:）の中の iframe で Accompany を開く。frame-ancestors はすべての祖先を
// 確かめるので、workbench（vscode-file:）も許す（docs/adr/185-frame-ancestors.md）
test("--allow-vscode-webview を付けて起動すると、VS Code の webview の中には埋め込めるが、別のオリジンのページには埋め込めない", async ({
  page,
}) => {
  accompany = await startAccompany(["--allow-vscode-webview", ...fakeAgent]);

  const response = await fetch(accompany.url);
  expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self' vscode-webview: vscode-file:");

  await openEmbedder(page, accompany.url);
  await expect(page.frameLocator("iframe").locator("#workspace")).toHaveCount(0);
});
