import { expect, test } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen } from "./terminal";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

// シェルやエージェントでよく使う Ctrl キー。ブラウザの操作（検索・印刷・タブを閉じるなど）に取られずに届く
const controlKeys = [
  { key: "Control+F", byte: "06", use: "1 文字進む" },
  { key: "Control+P", byte: "10", use: "前の履歴" },
  { key: "Control+W", byte: "17", use: "単語を消す" },
  { key: "Control+A", byte: "01", use: "行頭へ" },
  { key: "Control+H", byte: "08", use: "1 文字消す" },
  { key: "Control+J", byte: "0a", use: "改行" },
];

for (const { key, byte, use } of controlKeys) {
  test(`${key}（${use}）がコマンドに届く`, async ({ page }) => {
    accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
    await page.goto(accompany.url);
    await expectTerminalToShow(page, "Key reporter ready");

    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press(key);

    await expect(terminalScreen(page)).toContainText(`keys: ${byte}`);
  });
}
