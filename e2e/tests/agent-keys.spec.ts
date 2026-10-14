import { expect, test, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen } from "./terminal";

let accompany: Accompany | undefined;

// 偽のプログラムが表示した「keys: ...」の行（受け取った順）
async function receivedKeys(page: Page) {
  const rows = await page.locator(".xterm-rows > div").allTextContents();
  return rows.map((row) => row.replace(/\s+/g, " ").trim()).filter((row) => row.startsWith("keys:"));
}

test.afterEach(async () => {
  await accompany?.stop();
});

// Claude Code は ESC + CR を改行として扱う（/terminal-setup が VS Code などに入れる設定と同じ）
test("Shift+Enter を押すと、改行として ESC + CR がコマンドに届く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Key reporter ready");

  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Shift+Enter");
  // 余分な CR が届くと送信されてしまうので、確認用のキーを続けて押し、届いたものがちょうどこれだけかを確かめる
  await page.keyboard.press("a");

  await expect(terminalScreen(page)).toContainText("keys: 61");
  expect(await receivedKeys(page)).toEqual(["keys: 1b 0d", "keys: 61"]);
});

test("Enter だけを押したときは、これまでどおり CR が届く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Key reporter ready");

  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");

  await expect(terminalScreen(page)).toContainText("keys: 0d");
  await expect(terminalScreen(page)).not.toContainText("keys: 1b");
});
