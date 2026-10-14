import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, panes, typeInPane } from "./panes";

// 新しいタブは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string, viewport = { width: 1280, height: 720 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

function tab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function tabs(page: Page) {
  return page.getByRole("tab");
}

async function openNewTab(page: Page) {
  await page.getByRole("button", { name: "新しいタブ" }).click();
}

async function exitShell(page: Page, n: number) {
  // 偽のシェル（cat）は、行頭の Ctrl+D で入力が終わると終了する
  await pane(page, n).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+D");
}

test("新しいタブを開くと、タブ 2 が追加されて表示され、新しいシェルを操作できる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(tabs(page)).toHaveText(["タブ 1"]);

  await openNewTab(page);

  await expect(tabs(page)).toHaveText(["タブ 1", "タブ 2"]);
  await expect(tab(page, "タブ 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(pane(page, 1)).toHaveCount(0);
  await typeInPane(page, 2, "typed in tab 2\n");
  await expectPaneToShow(page, 2, "typed in tab 2");
});

test("タブを切り替えると、切り替える前の画面がそのまま戻る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await typeInPane(page, 1, "typed in tab 1\n");
  await expectPaneToShow(page, 1, "typed in tab 1");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await tab(page, "タブ 1").click();

  await expect(tab(page, "タブ 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 1, "typed in tab 1");
  await expect(pane(page, 2)).toHaveCount(0);
});

test("各タブは、それぞれ独立した分割の配置を持つ", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await pane(page, 2).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");

  await tab(page, "タブ 1").click();
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(panes(page)).toHaveCount(1);

  await tab(page, "タブ 2").click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expect(panes(page)).toHaveCount(2);
});

test("タブを閉じると、そのタブがなくなり、残りのタブが表示される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await page.getByRole("button", { name: "タブ 2 を閉じる" }).click();

  await expect(tabs(page)).toHaveText(["タブ 1"]);
  await expect(tab(page, "タブ 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 1, "Fake Shell ready");
});

test("最後のタブは閉じられない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await expect(page.getByRole("button", { name: "タブ 1 を閉じる" })).toBeDisabled();
});

test("タブの最後のターミナルのシェルを終了すると、そのタブが閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await exitShell(page, 2);

  await expect(tabs(page)).toHaveText(["タブ 1"]);
  await expectPaneToShow(page, 1, "Fake Shell ready");
});

test("最後のタブの最後のターミナルのシェルを終了しても、タブとターミナルは残る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await exitShell(page, 1);

  // シェルが終了したことを画面から知る手がかりがないので、少し待ってから残っていることを確かめる
  await page.waitForTimeout(500);
  await expect(tabs(page)).toHaveText(["タブ 1"]);
  await expect(panes(page)).toHaveCount(1);
});

test("タブの追加・切り替え・閉じる操作が、参加者全員の画面に反映される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expectPaneToShow(guest, 1, "Fake Shell ready");

  await openNewTab(host);
  await expect(tabs(guest)).toHaveText(["タブ 1", "タブ 2"]);
  await expect(tab(guest, "タブ 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(guest, 2, "Fake Shell ready");

  await tab(guest, "タブ 1").click();
  await expect(tab(host, "タブ 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(host, 1, "Fake Shell ready");

  await host.getByRole("button", { name: "タブ 2 を閉じる" }).click();
  await expect(tabs(guest)).toHaveText(["タブ 1"]);
});

test("途中から参加した人に、タブの並びと表示中のタブ、その画面が復元される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await openNewTab(host);
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await typeInPane(host, 2, "before guest joins\n");
  await expectPaneToShow(host, 2, "before guest joins");

  const guest = await openAsParticipant(browser, accompany.url);

  await expect(tabs(guest)).toHaveText(["タブ 1", "タブ 2"]);
  await expect(tab(guest, "タブ 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(guest, 2, "before guest joins");
});

test("タブを切り替えても、ターミナルにフォーカスしている人の表示が出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expectPaneToShow(guest, 1, "Fake Shell ready");

  await openNewTab(host);
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await pane(host, 2).locator(".xterm-screen").click();
  await pane(guest, 2).locator(".xterm-screen").click();

  // 先に開いた host が参加者 1、あとから開いた guest が参加者 2
  const badge = (page: Page, name: string) => pane(page, 2).getByRole("status").getByText(name, { exact: true });
  await expect(badge(host, "あなた")).toBeVisible();
  await expect(badge(host, "参加者 2")).toBeVisible();
  await expect(badge(guest, "参加者 1")).toBeVisible();
  await expect(pane(host, 2)).toHaveAttribute("data-focused", "true");
});

test("新しいタブのターミナルも、参加者のうち一番小さい画面に合わせた大きさになる", async ({ browser }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/size-shell" });
  const host = await openAsParticipant(browser, accompany.url, { width: 1280, height: 720 });
  const small = { width: 640, height: 400 };
  const guest = await openAsParticipant(browser, accompany.url, small);
  await expectPaneToShow(host, 1, "size:");

  await openNewTab(host);

  // コマンドから見えている端末のサイズ（最後に表示したもの）が 2 人で同じになり、小さい画面に収まる
  const size = async (page: Page) => {
    const text = (await pane(page, 2).locator(".xterm-rows").textContent()) ?? "";
    return [...text.matchAll(/size: (\d+)x(\d+)/g)].at(-1)?.slice(1).join("x") ?? "";
  };
  await expect.poll(() => size(guest)).not.toMatch(/^(80x24)?$/);
  await expect.poll(async () => (await size(host)) === (await size(guest))).toBe(true);
  const box = (await pane(guest, 2).locator(".xterm-screen").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(small.width);
  expect(box.y + box.height).toBeLessThanOrEqual(small.height);
});
