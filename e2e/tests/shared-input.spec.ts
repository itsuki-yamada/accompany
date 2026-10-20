import { expect, test, type Browser } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { terminalScreen, typeInTerminal } from "./terminal";

const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

// 参加者ごとに別のブラウザコンテキストで開き、端末が表示されるまで待つ
async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(url);
  await expect(terminalScreen(page)).toBeVisible();
  return page;
}

test("参加者の入力がコマンドに届き、その応答が全員の画面に表示される", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await typeInTerminal(guest, "from guest\n");

  await expect(terminalScreen(guest)).toContainText("Agent received: from guest");
  await expect(terminalScreen(host)).toContainText("Agent received: from guest");
});

test("2 人が交互に入力すると、それぞれの行がそのままコマンドに届く", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await typeInTerminal(host, "first from host\n");
  await expect(terminalScreen(guest)).toContainText("Agent received: first from host");
  await typeInTerminal(guest, "second from guest\n");

  await expect(terminalScreen(host)).toContainText("Agent received: second from guest");
});
