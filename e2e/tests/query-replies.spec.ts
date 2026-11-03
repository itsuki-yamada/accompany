import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen, typeInTerminal } from "./terminal";

const queryReporter = ["--", "bun", "e2e/fixtures/query-reporter.ts"];

// query-reporter.ts が出す問い合わせの種類
const kinds = ["DA1", "DA2", "DSR", "CPR", "DECRQM", "DECRQSS", "OSC 10", "OSC 11", "OSC 12"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(url);
  await expectTerminalToShow(page, "Query reporter ready");
  return page;
}

// q を押して問い合わせを出させ、どの種類の返事も 1 回だけ届いたことを確かめる
async function expectEachQueryAnsweredOnce(asker: Page, viewer: Page) {
  await typeInTerminal(asker, "q");
  await expectTerminalToShow(viewer, "Query report done");
  for (const kind of kinds) {
    await expect(terminalScreen(viewer)).toContainText(new RegExp(`${kind} replies: 1(?!\\d)`));
  }
  // 色の問い合わせには、既定の配色（暗い）の色で答える
  await expect(terminalScreen(viewer)).toContainText("OSC 10 replies: 1 rgb:cccc/cccc/cccc");
  await expect(terminalScreen(viewer)).toContainText("OSC 11 replies: 1 rgb:0000/0000/0000");
  await expect(terminalScreen(viewer)).toContainText("OSC 12 replies: 1 rgb:ffff/ffff/ffff");
}

test("2 人がつながっていても、端末からの問い合わせへの返事はコマンドに 1 回だけ届く", async ({ browser }) => {
  accompany = await startAccompany(queryReporter);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await expectEachQueryAnsweredOnce(guest, host);
  await expect(terminalScreen(host)).not.toContainText("other:");
});

test("1 人のときも、端末からの問い合わせに返事が届く", async ({ page }) => {
  accompany = await startAccompany(queryReporter);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Query reporter ready");

  await expectEachQueryAnsweredOnce(page, page);
});

test("2 人がつながっていても、参加者の入力とフォーカスの報告は今までどおりコマンドに届く", async ({ browser }) => {
  accompany = await startAccompany(queryReporter);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await typeInTerminal(guest, "hello from guest\r");
  await expectTerminalToShow(host, "typed: hello from guest");
  await expect(terminalScreen(host)).not.toContainText("focus: out");
  await guest.locator(".xterm-helper-textarea").blur();
  await expectTerminalToShow(host, "focus: out");
});
