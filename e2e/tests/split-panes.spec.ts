import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { addToView, boxOf, expectFillsArea, expectPaneToShow, pane, panes, tab, typeInPane } from "./panes";

// タブを複数選ぶと、選んだものが分割して並ぶ。並べるのは 3 つまで。分割と割合は参加者ごと（docs/adr/100-terminal-tabs.md）。
// 分割や新しいタブで増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" });
}

function toggle(page: Page, n: number) {
  return sidebar(page).getByRole("button", { name: `ターミナル ${n} を並べて表示` });
}

async function openNewTab(page: Page, n: number) {
  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, n, "Fake Shell ready");
}

// ターミナル 1〜3 のタブを開き、ターミナル 1 だけを表示している状態にする
async function openThreeTabs(page: Page) {
  await openNewTab(page, 2);
  await openNewTab(page, 3);
  await tab(page, 1).click();
  await expectPaneToShow(page, 1, "Fake Shell ready");
}

async function dragDivider(page: Page, x: number) {
  const divider = (await page.getByRole("separator").first().boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, divider.y + divider.height / 2, { steps: 5 });
  await page.mouse.up();
}

test("⌘ / Ctrl を押しながらタブを選ぶと、選んだタブが右に並び、3 つまで並べられる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);
  await openNewTab(page, 4);
  await tab(page, 1).click();

  await addToView(page, 2);

  await expect(panes(page)).toHaveCount(2);
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  for (const n of [1, 2]) await expect(tab(page, n)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "false");
  // 並べたタブにフォーカスが移り、それぞれ別に操作できる
  await expect(pane(page, 2).locator(".xterm-helper-textarea")).toBeFocused();
  await typeInPane(page, 2, "typed in right\n");
  await expectPaneToShow(page, 2, "typed in right");
  await expect(pane(page, 1).locator(".xterm-rows")).not.toContainText("typed in right");

  await addToView(page, 3);
  await expect(panes(page)).toHaveCount(3);

  // 4 つ目は並べられない
  await tab(page, 4).click({ modifiers: ["ControlOrMeta"] });
  await page.waitForTimeout(300);
  await expect(panes(page)).toHaveCount(3);
  await expect(pane(page, 4)).toHaveCount(0);
  await expect(toggle(page, 4)).toBeDisabled();
});

test("「並べて表示」のボタンでタブを並べ、もう一度押すと外して、残りのタブがその場所を埋める", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);
  // 表示しているタブが 1 つのときは、外せない
  await expect(toggle(page, 1)).toBeDisabled();
  await expect(toggle(page, 1)).toHaveAttribute("aria-pressed", "true");
  await expect(toggle(page, 2)).toHaveAttribute("aria-pressed", "false");

  await toggle(page, 2).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(panes(page)).toHaveCount(2);
  await expect(toggle(page, 2)).toHaveAttribute("aria-pressed", "true");
  await expect(toggle(page, 1)).toBeEnabled();

  await toggle(page, 1).click();

  await expect(pane(page, 1)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 2);
  // 外したタブは閉じずに残っていて、選べばまた出る
  await tab(page, 1).click();
  await expectPaneToShow(page, 1, "Fake Shell ready");
});

test("並べているときにタブを 1 つ選ぶと、そのタブだけの表示に戻る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);
  await addToView(page, 2);
  await addToView(page, 3);
  await expect(panes(page)).toHaveCount(3);

  await tab(page, 2).click();

  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 2);
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "false");
  await expect(pane(page, 2).locator(".xterm-helper-textarea")).toBeFocused();
});

test("右に分割すると、新しいタブが開いて右に並ぶ", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  await expect(sidebar(page).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  for (const n of [1, 2]) await expect(tab(page, n)).toHaveAttribute("aria-selected", "true");
});

test("下に分割すると、新しいタブが開いて下に並ぶ", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [top, bottom] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
});

test("3 つ並べているときは、それ以上分割できない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await pane(page, 2).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");

  for (const n of [1, 2, 3]) {
    await expect(pane(page, n).getByRole("button", { name: "右に分割" })).toBeDisabled();
    await expect(pane(page, n).getByRole("button", { name: "下に分割" })).toBeDisabled();
  }
  await pane(page, 1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+R");
  await page.waitForTimeout(300);
  await expect(panes(page)).toHaveCount(3);
  await expect(sidebar(page).getByRole("tab")).toHaveCount(3);
});

test("並べているタブを閉じると、残りのタブがその場所を埋める", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await pane(page, 2).getByRole("button", { name: "閉じる" }).click();

  await expect(panes(page)).toHaveCount(1);
  await expect(sidebar(page).getByRole("tab")).toHaveText([/ターミナル 1/]);
  await expectFillsArea(page, 1);
});

test("並べているタブのシェルを終了すると、そのタブが閉じる", async ({ browser }) => {
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

  await dragDivider(page, 1280 * 0.3);

  await expect.poll(async () => (await boxOf(page, 1)).width / 1280).toBeLessThan(0.35);
  expect((await boxOf(page, 2)).width / 1280).toBeGreaterThan(0.45);
});

test("どのタブを並べるかと割合は参加者ごとで、ほかの参加者の表示は変わらない。入力は同じタブを見ている全員に出る", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await expect(sidebar(guest).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await host.waitForTimeout(300);
  await expect(panes(guest)).toHaveCount(1);

  // guest も並べると、同じタブの入力が両方に出る
  await addToView(guest, 2);
  await typeInPane(guest, 2, "typed by guest\n");
  await expectPaneToShow(host, 2, "typed by guest");

  // host の割合の変更は、guest の表示には効かない
  await dragDivider(host, 1280 * 0.3);
  await expect.poll(async () => (await boxOf(host, 1)).width / 1280).toBeLessThan(0.35);
  await host.waitForTimeout(300);
  const guestLeft = await boxOf(guest, 1);
  const guestRight = await boxOf(guest, 2);
  expect(Math.abs(guestLeft.width - guestRight.width)).toBeLessThan(20);

  // host が分割をやめても、guest は並べたまま
  await tab(host, 1).click();
  await expect(panes(host)).toHaveCount(1);
  await host.waitForTimeout(300);
  await expect(panes(guest)).toHaveCount(2);
});

test("最後のタブは閉じられない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await expect(pane(page, 1).getByRole("button", { name: "閉じる" })).toBeDisabled();
});
