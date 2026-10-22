import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

// 長く使っていたら、ターミナルをスクロールできなくなった（#115）。
// ホイールでスクロールしたことのあるターミナルで、フォントの大きさ（1 行の高さ）が変わると、
// ホイール 1 回で何十行も飛び、一番下（最新の行）にも戻れなくなっていた。
// フォントの大きさは、表示の設定で変えたときのほか、「画面に収める（縮小）」でウィンドウや端末の大きさが変わるたびに変わる

const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const longOutput = ["--", "bun", "e2e/fixtures/long-output.ts"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
});

async function openAsParticipant(browser: Browser, url: string, viewport = { width: 1280, height: 720 }) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "line 200");
  return page;
}

function rows(page: Page) {
  return pane(page, 1).locator(".xterm-rows");
}

async function wheel(page: Page, deltaY: number, times = 1) {
  await pane(page, 1).locator(".xterm-screen").hover();
  for (let i = 0; i < times; i++) await page.mouse.wheel(0, deltaY);
}

// 少し読み返してから、一番下に戻る（ホイールでスクロールしたことのあるターミナルにする）
async function scrollBackAndForth(page: Page) {
  await wheel(page, -100, 3);
  await expect(rows(page)).not.toContainText("line 200");
  await wheel(page, 100, 10);
  await expect(rows(page)).toContainText("line 200");
}

// 一番下から、ホイールで少しだけ上に戻すと、すぐ上の行が見える（何十行も飛ばない）。下に回すと一番下に戻れる
async function expectToScrollLittleByLittle(page: Page) {
  await expect(rows(page)).toContainText("line 200");
  await wheel(page, -100);
  await expect(rows(page)).not.toContainText("line 200");
  await expect(rows(page)).toContainText("line 190");
  await wheel(page, 100, 5);
  await expect(rows(page)).toContainText("line 200");
}

async function openSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "表示の設定" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "表示の設定" }).click();
  return dialog;
}

test("スクロールしたあとにフォントを大きくしても、ホイールで少しずつスクロールでき、一番下に戻れる", async ({ browser }) => {
  accompany = await startAccompany(longOutput, fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await scrollBackAndForth(page);

  await (await openSettings(page)).getByLabel("フォントの大きさ").fill("24");
  await page.keyboard.press("Escape");
  await expect(rows(page)).toHaveCSS("font-size", "24px");

  await expectToScrollLittleByLittle(page);
});

test("画面に収める（縮小）で、スクロールしたあとにウィンドウを大きくしても、ホイールで少しずつスクロールでき、一番下に戻れる", async ({
  browser,
}) => {
  // 下限（高さ 1080 のウィンドウ）に収まる host と、それより低い guest。guest は縮小して表示する
  accompany = await startAccompany(longOutput, fakeShell, { minWindow: "480x1080" });
  await openAsParticipant(browser, accompany.url, { width: 1280, height: 1080 });
  const guest = await openAsParticipant(browser, accompany.url, { width: 1280, height: 500 });
  await (await openSettings(guest)).getByLabel("端末が画面より大きいとき").selectOption({ label: "画面に収める（縮小）" });
  await guest.keyboard.press("Escape");
  const fontSize = () => rows(guest).evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  await expect.poll(fontSize).toBeLessThan(15);
  const small = await fontSize();
  await scrollBackAndForth(guest);

  await guest.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(fontSize).toBeGreaterThan(small);

  await expectToScrollLittleByLittle(guest);
});
