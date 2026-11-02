import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, tab, typeInPane } from "./panes";

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

// 端末が枠からはみ出しているとき、画面がいっぱいでなくても（開いたばかり・clear の直後など）、出力でカーソルが動けば、
// 枠のスクロールはカーソルの行（最新の出力）を追う。自分で枠をスクロールしてカーソルを見えなくしたら、追わない（#227）

// プロンプト（「$ 」）を出し、「lines 数 文字列」で「文字列 1」…を出すシェル。開いたときのプロンプトは画面の一番上にある
const promptShell = ["--", "bun", "e2e/fixtures/prompt-shell.ts"];

// その文字だけの行（最後のもの）が、枠のスクロールで見えている範囲にあるか
function rowVisibleInFrame(page: Page, n: number, text: string) {
  return pane(page, n).evaluate((element, text) => {
    const frame = element.querySelector(".pane-terminal")!.getBoundingClientRect();
    const rows = [...element.querySelectorAll(".xterm-rows > div")].filter((row) => row.textContent?.trim() === text);
    const row = rows.at(-1)?.getBoundingClientRect();
    return row !== undefined && row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1;
  }, text);
}

async function openHostAndGuest(browser: Browser, url: string) {
  const hostPage = await openAsParticipant(browser, url, host);
  const guestPage = await openAsParticipant(browser, url, guest);
  await expectPaneToShow(guestPage, 1, "Prompt shell ready");
  await expect.poll(async () => (await frameScroll(guestPage, 1)).overflows).toBe(true);
  return { hostPage, guestPage };
}

test("枠からはみ出しているとき、ほかの参加者のコマンドの出力が画面の上のほうに出ても、枠のスクロールがその行まで動く", async ({ browser }) => {
  accompany = await startAccompany(promptShell, {}, { minWindow });
  const { hostPage, guestPage } = await openHostAndGuest(browser, accompany.url);

  await typeInPane(hostPage, 1, "lines 5 short\n");

  await expectPaneToShow(guestPage, 1, "short 5");
  await expect.poll(() => rowVisibleInFrame(guestPage, 1, "short 5")).toBe(true);
});

test("枠からはみ出しているとき、自分で打ったコマンドの出力が枠の下まで流れても、枠のスクロールが最新の行まで動く", async ({ browser }) => {
  accompany = await startAccompany(promptShell, {}, { minWindow });
  const { guestPage } = await openHostAndGuest(browser, accompany.url);

  // 打つと、ブラウザが入力欄（画面の上のほうのカーソル）を見せるために枠を上へスクロールする
  await typeInPane(guestPage, 1, "lines 45 long\n");

  await expectPaneToShow(guestPage, 1, "long 45");
  await expect.poll(() => rowVisibleInFrame(guestPage, 1, "long 45")).toBe(true);
});

test("枠からはみ出しているとき、自分で枠をスクロールしてカーソルの行を見えなくしたら、出力が来ても引き戻さない", async ({ browser }) => {
  accompany = await startAccompany(promptShell, {}, { minWindow });
  const { hostPage, guestPage } = await openHostAndGuest(browser, accompany.url);
  await typeInPane(hostPage, 1, "lines 80 filled\n");
  await expectPaneToShow(guestPage, 1, "filled 80");
  await expect.poll(() => rowVisibleInFrame(guestPage, 1, "filled 80")).toBe(true);

  await frame(guestPage, 1).evaluate((e) => e.scrollTo({ top: 0 }));
  await expect.poll(async () => (await frameScroll(guestPage, 1)).atBottom).toBe(false);
  await typeInPane(hostPage, 1, "lines 3 more\n");

  await expectPaneToShow(guestPage, 1, "more 3");
  await guestPage.waitForTimeout(500);
  expect(await frame(guestPage, 1).evaluate((e) => e.scrollTop)).toBe(0);
});
