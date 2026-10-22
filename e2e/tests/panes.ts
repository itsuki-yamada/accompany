import { expect, type Page } from "@playwright/test";

// 画面に並べた各ターミナル（ペイン）の操作
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

// タブ（ターミナル 1 つが 1 つのタブ）。サイドメニューにあり、サイドメニューを隠しているときはツールバーにある
export function tab(page: Page, n: number) {
  return page.getByRole("tab", { name: `ターミナル ${n}`, exact: true });
}

export function tabs(page: Page) {
  return page.getByRole("tab");
}

// ⌘ / Ctrl を押しながらタブを選び、自分の表示に加える（フォーカスしているターミナルの右に並ぶ）
export async function addToView(page: Page, n: number) {
  await tab(page, n).click({ modifiers: ["ControlOrMeta"] });
  await expect(pane(page, n)).toBeVisible();
}

// ターミナルを並べる領域（サイドメニューを除く）いっぱいに出ている
export async function expectFillsArea(page: Page, n: number) {
  const area = (await page.getByRole("main").boundingBox())!;
  await expect.poll(async () => (await boxOf(page, n)).width).toBeGreaterThan(area.width * 0.95);
  expect((await boxOf(page, n)).height).toBeGreaterThan(area.height * 0.95);
}
