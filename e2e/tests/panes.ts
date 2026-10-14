import { expect, type Page } from "@playwright/test";

// 画面分割したときの、各ターミナル（ペイン）の操作
export function pane(page: Page, n: number) {
  return page.getByRole("region", { name: `ターミナル ${n}` });
}

export function panes(page: Page) {
  return page.getByRole("region", { name: /^ターミナル \d+$/ });
}

export async function typeInPane(page: Page, n: number, text: string) {
  await pane(page, n).locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(text);
}

export async function expectPaneToShow(page: Page, n: number, text: string) {
  await expect(pane(page, n).locator(".xterm-rows")).toContainText(text);
}

export async function boxOf(page: Page, n: number) {
  return (await pane(page, n).boundingBox())!;
}
