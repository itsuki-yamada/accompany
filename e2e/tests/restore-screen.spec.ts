import { expect, test, type Browser } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen, typeInTerminal } from "./terminal";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

// 参加者ごとに別のブラウザコンテキストで開く
async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

test("途中から参加した人の画面に、参加前の出力が表示される", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-agent.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "Fake Agent ready");
  await typeInTerminal(host, "before guest joins\n");
  await expectTerminalToShow(host, "Agent received: before guest joins");

  const guest = await openAsParticipant(browser, accompany.url);

  await expectTerminalToShow(guest, "Fake Agent ready");
  await expectTerminalToShow(guest, "Agent received: before guest joins");
});

test("全画面の TUI でも、途中から参加した人に現在の画面が表示される", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-tui.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "count: 0");
  await typeInTerminal(host, "\n\n\n");
  await expectTerminalToShow(host, "count: 3");

  const guest = await openAsParticipant(browser, accompany.url);

  await expectTerminalToShow(guest, "Fake TUI");
  await expectTerminalToShow(guest, "count: 3");
  // 同じ位置に描き直しているので、古い値は残らない
  await expect(terminalScreen(guest)).not.toContainText("count: 2");
});

test("途中から参加した直後の出力も、取りこぼさずに表示される", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-agent.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "Fake Agent ready");

  const guest = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(guest, "Fake Agent ready");
  await typeInTerminal(host, "after guest joins\n");

  await expectTerminalToShow(guest, "Agent received: after guest joins");
});
