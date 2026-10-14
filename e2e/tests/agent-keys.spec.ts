import { expect, test } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen } from "./terminal";

let accompany: Accompany | undefined;

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

  await expect(terminalScreen(page)).toContainText("keys: 1b 0d");
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
