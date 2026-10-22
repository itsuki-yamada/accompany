import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen } from "./terminal";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

function loading(page: Page) {
  return page.getByRole("status", { name: "読み込み中" });
}

// サーバーからページへのメッセージを、release を呼ぶまで止めておく中継。ページからサーバーへのものはそのまま送る
async function holdServerMessages(page: Page, url: RegExp) {
  let holding = true;
  const held: { ws: WebSocketRoute; message: string | Buffer }[] = [];
  await page.routeWebSocket(url, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => (holding ? held.push({ ws, message }) : ws.send(message)));
  });
  return {
    release() {
      holding = false;
      held.splice(0).forEach(({ ws, message }) => ws.send(message));
    },
  };
}

test("開いた直後から読み込み中と表示し、Workspace とターミナルの最初の画面が届いたら消す", async ({ page }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });

  // 画面の JS の読み込みを止めておき、JS が動く前から表示が出ていることを確かめる
  let releaseScript = () => {};
  const scriptHeld = new Promise<void>((resolve) => (releaseScript = resolve));
  await page.route(/\.js$/, async (route) => {
    await scriptHeld;
    await route.continue();
  });
  const workspace = await holdServerMessages(page, /\/ws\/workspace$/);
  const terminals = await holdServerMessages(page, /\/ws\/terminals\//);

  await page.goto(accompany.url, { waitUntil: "commit" });
  await expect(loading(page)).toBeVisible();

  // JS が動いても、Workspace の配置が届くまでは読み込み中
  releaseScript();
  // モジュールのスクリプトは、DOMContentLoaded の前に動き終わる
  await page.waitForLoadState("domcontentloaded");
  await expect(loading(page)).toBeVisible();

  // 配置が届いてターミナルを組み立てても、ターミナルの最初の画面が届くまでは読み込み中
  workspace.release();
  await expect(page.locator(".pane")).toHaveCount(1);
  await expect(loading(page)).toBeVisible();

  terminals.release();
  await expectTerminalToShow(page, "Fake Shell ready");
  await expect(loading(page)).toBeHidden();
});

test("サーバーとの接続が切れると、切れたことと再読み込みのボタンを表示する", async ({ page }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await expect(page.getByRole("alert").filter({ hasText: "接続が切れました" })).toHaveCount(0);

  await accompany.stop();
  accompany = undefined;

  const alert = page.getByRole("alert").filter({ hasText: "接続が切れました" });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "再読み込み" })).toBeVisible();
  // 切れる前の画面は、そのまま見られる
  await expect(terminalScreen(page)).toContainText("Fake Shell ready");
});

test("読み込みの途中で接続が切れると、読み込み中の代わりに切れたことを表示する", async ({ page }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });
  // 配置を届けないまま、サーバーを止める
  await holdServerMessages(page, /\/ws\/workspace$/);
  await page.goto(accompany.url);
  await expect(loading(page)).toBeVisible();

  await accompany.stop();
  accompany = undefined;

  await expect(page.getByRole("alert").filter({ hasText: "接続が切れました" })).toBeVisible();
  await expect(loading(page)).toBeHidden();
});
