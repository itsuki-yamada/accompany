import { expect, test, type Browser } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes, typeInPane } from "./panes";

// 分割で増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

test("右に分割すると、新しいターミナルが右に並び、それぞれ別に操作できる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(Math.abs(right.y - left.y)).toBeLessThan(2);

  await typeInPane(page, 2, "typed in right\n");
  await expectPaneToShow(page, 2, "typed in right");
  await expect(pane(page, 1).locator(".xterm-rows")).not.toContainText("typed in right");
});

test("下に分割すると、新しいターミナルが下に並ぶ", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [top, bottom] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
});

test("ターミナルを閉じると、残りのターミナルがその場所を埋める", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await pane(page, 2).getByRole("button", { name: "閉じる" }).click();

  await expect(panes(page)).toHaveCount(1);
  expect((await boxOf(page, 1)).width).toBeGreaterThan(1280 * 0.95);
});

test("最後のターミナルは閉じられない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await expect(pane(page, 1).getByRole("button", { name: "閉じる" })).toBeDisabled();
});

test("ターミナルのシェルを終了すると、そのターミナルが閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  // 偽のシェル（cat）は、行頭の Ctrl+D で入力が終わると終了する
  await pane(page, 2).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+D");

  await expect(pane(page, 2)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(1);
});

test("境界をドラッグすると、並んだターミナルの大きさの割合が変わる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  const divider = (await page.getByRole("separator").boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(1280 * 0.3, divider.y + divider.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => (await boxOf(page, 1)).width / 1280).toBeLessThan(0.35);
  expect((await boxOf(page, 2)).width / 1280).toBeGreaterThan(0.65);
});

test("分割・入力・大きさの変更・閉じる操作が、参加者全員の画面に反映される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(guest, 2, "Fake Shell ready");

  await typeInPane(guest, 2, "typed by guest\n");
  await expectPaneToShow(host, 2, "typed by guest");

  const divider = (await host.getByRole("separator").boundingBox())!;
  await host.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await host.mouse.down();
  await host.mouse.move(1280 * 0.3, divider.y + divider.height / 2, { steps: 5 });
  await host.mouse.up();
  await expect.poll(async () => (await boxOf(guest, 1)).width / 1280).toBeLessThan(0.35);

  await pane(host, 2).getByRole("button", { name: "閉じる" }).click();
  await expect(panes(guest)).toHaveCount(1);
});
