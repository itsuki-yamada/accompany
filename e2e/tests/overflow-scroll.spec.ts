import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, tab } from "./panes";

// 端末が自分の画面より大きく、はみ出した部分をペインの枠のスクロールで見ているとき、ターミナルを表示し直しても
// （タブの切り替え・ページの開き直し）、枠のスクロールは一番下（最新の行が見える位置）にある（#116）

// 新しいタブは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const longOutput = ["--", "bun", "e2e/fixtures/long-output.ts"];
// 下限（高さ 1080 のウィンドウ）に収まる host と、それより低い guest。端末は下限まで広がり、guest の枠から縦にはみ出す
const minWindow = "480x1080";
const host = { width: 1280, height: 1080 };
const guest = { width: 1280, height: 600 };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
});

async function openAsParticipant(browser: Browser, url: string, viewport: { width: number; height: number }) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

function frame(page: Page, n: number) {
  return pane(page, n).locator(".pane-terminal");
}

// ペインの枠の縦のスクロール。はみ出しているか、一番下にあるか
function frameScroll(page: Page, n: number) {
  return frame(page, n).evaluate((e) => ({
    overflows: e.scrollHeight > e.clientHeight,
    atBottom: e.scrollTop + e.clientHeight >= e.scrollHeight - 1,
  }));
}

// guest の枠から縦にはみ出し、枠を一番上までスクロールした状態にする
async function openGuestScrolledToTop(browser: Browser, url: string) {
  await openAsParticipant(browser, url, host);
  const page = await openAsParticipant(browser, url, guest);
  await expectPaneToShow(page, 1, "line 200");
  await expect.poll(async () => (await frameScroll(page, 1)).overflows).toBe(true);
  await frame(page, 1).evaluate((e) => e.scrollTo({ top: 0 }));
  expect(await frameScroll(page, 1)).toEqual({ overflows: true, atBottom: false });
  return page;
}

test("枠からはみ出しているとき、タブを切り替えて戻ると、枠のスクロールが一番下にある", async ({ browser }) => {
  accompany = await startAccompany(longOutput, fakeShell, { minWindow });
  const page = await openGuestScrolledToTop(browser, accompany.url);

  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  await tab(page, 1).click();

  await expectPaneToShow(page, 1, "line 200");
  await expect.poll(() => frameScroll(page, 1)).toEqual({ overflows: true, atBottom: true });
});

test("枠からはみ出しているとき、ページを開き直すと、枠のスクロールが一番下にある", async ({ browser }) => {
  accompany = await startAccompany(longOutput, {}, { minWindow });
  const page = await openGuestScrolledToTop(browser, accompany.url);

  await page.reload();

  await expectPaneToShow(page, 1, "line 200");
  await expect.poll(() => frameScroll(page, 1)).toEqual({ overflows: true, atBottom: true });
});
