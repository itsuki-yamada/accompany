import { expect, type Locator, type Page } from "@playwright/test";

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

// 端末の要素の位置と文字列。xterm は行を描き直すたびに要素を作り直すので、
// 位置と文字列を別々に取ると、その間に要素が消えて null になることがある。1 回の処理でまとめて取る
export async function boxAndText(locator: Locator) {
  return locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height, text: element.textContent ?? "" };
  });
}
