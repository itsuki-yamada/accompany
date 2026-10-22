import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { boxOf, pane, panes } from "./panes";
import { terminalScreen } from "./terminal";

// 分割した画面で、フォーカスしているターミナルが自分の枠に収まらなくても、勝手に拡大しない。
// はみ出した部分は、スクロールか縮小（表示の設定）で見る（docs/adr/126-no-zoom.md）

// 分割で増えるターミナルは $SHELL を起動する。端末のサイズを表示し続けるもの（size-shell）を使う
const sizeShell = { SHELL: "e2e/fixtures/size-shell" };
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const large = { width: 1280, height: 720 };
const small = { width: 800, height: 720 };
// 端末の大きさの下限（ウィンドウの大きさ）。幅 480 のウィンドウに収まる列数は、host の分割した枠には収まり、
// guest の分割した枠には収まらない（docs/adr/99-smallest-size.md）
const minWindow = "480x0";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
});

async function openAsParticipant(browser: Browser, url: string, viewport = large) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  await expect(panes(page).first().locator(".xterm-rows")).not.toBeEmpty();
  return page;
}

function input(page: Page, n: number) {
  return pane(page, n).locator(".xterm-helper-textarea");
}

// 画面の大きい人（host）と小さい人（guest）が参加し、host が右に分割した状態にする。
// 端末の大きさは、host の枠に入る範囲で下限まで広げるので、guest の画面では分割した枠に収まらない
async function openLargeAndSmall(browser: Browser) {
  accompany = await startAccompany([], sizeShell, { minWindow });
  const host = await openAsParticipant(browser, accompany.url, large);
  const guest = await openAsParticipant(browser, accompany.url, small);
  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expect(panes(guest)).toHaveCount(2);
  await input(guest, 1).focus();
  // 端末が下限の大きさになり、guest の枠に収まらなくなるのを待つ
  await expect.poll(() => fitsInPane(guest, 1)).toBe(false);
  return { host, guest };
}

// ターミナルの表示領域に、端末が収まっている（スクロールバーが出ていない）
function fitsInPane(page: Page, n: number) {
  return pane(page, n)
    .locator(".pane-terminal")
    .evaluate((e) => e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight);
}

// 分割したまま、どのターミナルも見えていて、拡大の表示がない
async function expectSplit(page: Page) {
  const area = (await page.locator("#workspace").boundingBox())!;
  for (const n of [1, 2]) {
    await expect(pane(page, n)).toBeVisible();
    expect((await boxOf(page, n)).width).toBeLessThan(area.width / 2 + 2);
  }
  await expect(page.getByText("拡大中")).toHaveCount(0);
  await expect(page.getByText("拡大を外しています")).toHaveCount(0);
}

test("分割した枠に端末が収まらなくても拡大せず、はみ出した分はスクロールで見る", async ({ browser }) => {
  const { guest } = await openLargeAndSmall(browser);

  // 以前は収まらない状態が 300ms 続くと拡大していた。それより長く待っても分割したまま
  await guest.waitForTimeout(1000);
  await expectSplit(guest);
  expect(await fitsInPane(guest, 1)).toBe(false);
  await expect(input(guest, 1)).toBeFocused();

  // 拡大を切り替えるボタンも、右クリックメニューの項目もない
  await expect(guest.getByRole("button", { name: "拡大表示" })).toHaveCount(0);
  const box = (await pane(guest, 1).locator(".xterm-screen").boundingBox())!;
  await guest.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const menu = guest.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /拡大/ })).toHaveCount(0);
});

test("⌘⇧Z / Ctrl+Shift+Z を押しても、分割したままで何も起きない", async ({ browser }) => {
  const { guest } = await openLargeAndSmall(browser);

  for (const key of ["Meta+Shift+Z", "Control+Shift+Z"]) {
    await guest.keyboard.press(key);
    await guest.waitForTimeout(500);
    await expectSplit(guest);
    await expect(input(guest, 1)).toBeFocused();
  }
});

test("⌘⇧Z / Ctrl+Shift+Z は、ほかの割り当てのない Ctrl+Shift+文字と同じく、シェルに何も送らない", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expect(terminalScreen(page)).toContainText("Key reporter ready");
  await page.locator(".xterm-helper-textarea").focus();

  await page.keyboard.press("Meta+Shift+Z");
  await page.keyboard.press("Control+Shift+Z");
  // 後から押したキーが届いたことで、その前のキーが届いていないことを確かめる
  await page.keyboard.press("Control+A");
  await expect(terminalScreen(page)).toContainText("keys: 01");
  await expect(terminalScreen(page)).not.toContainText("1a");
  await expect(terminalScreen(page)).not.toContainText(/keys: (?!01)/);
});

test("ショートカットの一覧に、拡大表示の切り替えがない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toBeVisible();
  await expect(list).toContainText("右に分割");
  await expect(list).not.toContainText("拡大");
  await expect(list).not.toContainText("⌘⇧Z");
  await expect(list).not.toContainText("Ctrl+Shift+Z");
});
