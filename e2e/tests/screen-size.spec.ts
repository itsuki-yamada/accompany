import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { terminalScreen } from "./terminal";

const sizeReporter = ["--", "bun", "e2e/fixtures/size-reporter.ts"];
const large = { width: 1280, height: 720 };
const small = { width: 640, height: 400 };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string, viewport: typeof large) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(url);
  await expect(terminalScreen(page)).toContainText("size:");
  return page;
}

// コマンドから見えている端末のサイズ（偽のエージェントが最後に表示したもの）
async function commandSize(page: Page) {
  const sizes = [...((await terminalScreen(page).textContent()) ?? "").matchAll(/size: (\d+)x(\d+)/g)];
  const last = sizes.at(-1);
  return last ? `${last[1]}x${last[2]}` : "";
}

// 端末がブラウザの画面からはみ出していないか
async function expectTerminalToFitIn(page: Page) {
  const viewport = page.viewportSize()!;
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test("1 人で開くと、端末がブラウザの画面いっぱいの大きさになる", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);

  const host = await openAsParticipant(browser, accompany.url, large);

  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  await expectTerminalToFitIn(host);
  const box = (await host.locator(".xterm-screen").boundingBox())!;
  expect(box.width).toBeGreaterThan(large.width * 0.9);
  expect(box.height).toBeGreaterThan(large.height * 0.9);
});

test("画面の小さい人が参加すると、全員の端末がその人の画面に収まる同じ大きさになる", async ({
  browser,
}) => {
  accompany = await startAccompany(sizeReporter);
  const host = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const hostAlone = await commandSize(host);

  const guest = await openAsParticipant(browser, accompany.url, small);

  await expect.poll(() => commandSize(guest)).not.toBe(hostAlone);
  const shared = await commandSize(guest);
  await expect.poll(() => commandSize(host)).toBe(shared);
  await expectTerminalToFitIn(guest);
  // 2 人とも同じ行数の端末を描いている
  const rows = Number(shared.split("x")[1]);
  await expect(host.locator(".xterm-rows > div")).toHaveCount(rows);
  await expect(guest.locator(".xterm-rows > div")).toHaveCount(rows);
});

test("画面の小さい人が抜けると、残った人の画面に合わせた大きさに戻る", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const host = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const hostAlone = await commandSize(host);
  const guest = await openAsParticipant(browser, accompany.url, small);
  await expect.poll(() => commandSize(host)).not.toBe(hostAlone);

  await guest.context().close();

  await expect.poll(() => commandSize(host)).toBe(hostAlone);
});

test("ブラウザのウィンドウの大きさを変えると、端末の大きさも合わせて変わる", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const host = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const before = await commandSize(host);

  await host.setViewportSize(small);

  await expect.poll(() => commandSize(host)).not.toBe(before);
  await expectTerminalToFitIn(host);
});
