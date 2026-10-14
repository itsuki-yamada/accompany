import { expect, type Page } from "@playwright/test";

// xterm.js が描画する端末の画面と入力欄
export function terminalScreen(page: Page) {
  return page.locator(".xterm-rows");
}

export async function typeInTerminal(page: Page, text: string) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(text);
}

export async function expectTerminalToShow(page: Page, text: string) {
  await expect(terminalScreen(page)).toContainText(text);
}
