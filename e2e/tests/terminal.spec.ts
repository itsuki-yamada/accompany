import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { accompanyCommand, newStateDir, startAccompany, testPort, type Accompany } from "./accompany";
import { expectTerminalToShow, typeInTerminal } from "./terminal";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

test("起動時に指定したコマンドの出力が、ブラウザの端末に表示される", async ({ page }) => {
  accompany = await startAccompany(fakeAgent);

  await page.goto(accompany.url);

  await expectTerminalToShow(page, "Fake Agent ready");
});

test("ブラウザの端末で入力すると、コマンドに届いて応答が表示される", async ({ page }) => {
  accompany = await startAccompany(fakeAgent);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Agent ready");

  await typeInTerminal(page, "hello agent\n");

  await expectTerminalToShow(page, "Agent received: hello agent");
});

test("コマンドを省略すると $SHELL が起動する", async ({ page }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });

  await page.goto(accompany.url);

  await expectTerminalToShow(page, "Fake Shell ready");
});

test("--port で指定したポートで起動する", async ({ page }) => {
  accompany = await startAccompany(["--port", testPort(1), ...fakeAgent]);

  expect(new URL(accompany.url).port).toBe(testPort(1));
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Agent ready");
});

// ポートが使われていたら、空いているポートまで 1 つずつ上げて起動する。同じポートで二重に待ち受けると、
// ブラウザの接続がどちらのコマンドにつながるか分からなくなるので、同じポートでは待ち受けない（docs/adr/152-free-port.md）
test("同じポートで Accompany が動いているときは、次の空いているポートで起動し、そのポートを表示する", async ({ page }) => {
  accompany = await startAccompany(["--port", testPort(2), ...fakeAgent]);

  const second = await startAccompany(["--port", testPort(2), "--", "bun", "e2e/fixtures/line-printer.ts"]);
  try {
    expect(new URL(second.url).port).toBe(testPort(3));
    await page.goto(second.url);
    await expectTerminalToShow(page, "Line printer ready");
    // 先に起動した Accompany は、元のポートでそのまま使える
    await page.goto(accompany.url);
    await expectTerminalToShow(page, "Fake Agent ready");
  } finally {
    await second.stop();
  }
});

test("指定したポートから上限（10 個）まですべて使われていると、エラーを表示して終了コード 1 で終わる", async () => {
  const ports = Array.from({ length: 10 }, (_, i) => testPort(2 + i));
  const servers = await Promise.all(ports.map(listen));
  try {
    const result = spawnSync(`${accompanyCommand()} --port ${testPort(2)} --min-window 0x0`, {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
      env: { ...process.env, ACCOMPANY_STATE_DIR: newStateDir() },
      timeout: 30_000,
    });

    expect(result.stderr).toContain(`Accompany: ポート ${ports[0]}〜${ports.at(-1)} はすべて使われています`);
    expect(result.stdout + result.stderr).not.toMatch(/https?:\/\//);
    expect(result.status).toBe(1);
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

// Accompany ではないプロセスが、port で待ち受ける
function listen(port: string) {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", () => resolve(server));
  });
}
