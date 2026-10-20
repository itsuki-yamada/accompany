import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { terminalScreen } from "./terminal";

const ticker = ["--", "bun", "e2e/fixtures/ticker.ts"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

// 参加者ごとに別のブラウザコンテキストで開く
async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

// 画面に出ている最新の tick の番号
async function latestTick(page: Page) {
  const ticks = [...((await terminalScreen(page).textContent()) ?? "").matchAll(/tick (\d+)/g)];
  return Number(ticks.at(-1)?.[1] ?? 0);
}

test("2 人が同じ URL を開いていると、コマンドの出力が両方の画面にリアルタイムに表示される", async ({
  browser,
}) => {
  accompany = await startAccompany(ticker);
  const host = await openAsParticipant(browser, accompany.url);
  await expect(terminalScreen(host)).toContainText("tick");

  const guest = await openAsParticipant(browser, accompany.url);

  // 2 人目が開いたあとの出力が、2 人とも同じように進んで見える
  const target = (await latestTick(host)) + 3;
  await expect(terminalScreen(guest)).toContainText(`tick ${target}`);
  await expect(terminalScreen(host)).toContainText(`tick ${target}`);
});

test("1 人がブラウザを閉じても、もう 1 人の画面は動き続ける", async ({ browser }) => {
  accompany = await startAccompany(ticker);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expect(terminalScreen(guest)).toContainText("tick");

  await guest.context().close();

  const target = (await latestTick(host)) + 3;
  await expect(terminalScreen(host)).toContainText(`tick ${target}`);
});
