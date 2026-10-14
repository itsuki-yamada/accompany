import { expect, test, type Browser } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

// ターミナルのバーに出る、そのターミナルにフォーカスしている人の表示
function focusBadge(page: Parameters<typeof pane>[0], n: number, name: string) {
  return pane(page, n).getByRole("status").getByText(name, { exact: true });
}

test("自分がフォーカスしているターミナルに「あなた」と出て、フォーカスを移すと表示も移る", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await pane(page, 1).locator(".xterm-screen").click();
  await expect(focusBadge(page, 1, "あなた")).toBeVisible();
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");

  await pane(page, 2).locator(".xterm-screen").click();
  await expect(focusBadge(page, 2, "あなた")).toBeVisible();
  await expect(pane(page, 2)).toHaveAttribute("data-focused", "true");
  await expect(focusBadge(page, 1, "あなた")).toHaveCount(0);
  await expect(pane(page, 1)).not.toHaveAttribute("data-focused", "true");
});

test("他の参加者がフォーカスしているターミナルに、その人の名前が出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 2, "Fake Shell ready");
  const guest = await openAsParticipant(browser, accompany.url);

  await pane(host, 2).locator(".xterm-screen").click();
  await pane(guest, 1).locator(".xterm-screen").click();

  // 先に開いた host が参加者 1、あとから開いた guest が参加者 2
  await expect(focusBadge(guest, 2, "参加者 1")).toBeVisible();
  await expect(focusBadge(host, 1, "参加者 2")).toBeVisible();
  await expect(focusBadge(host, 2, "あなた")).toBeVisible();

  await pane(host, 1).locator(".xterm-screen").click();
  await expect(focusBadge(guest, 1, "参加者 1")).toBeVisible();
  await expect(focusBadge(guest, 2, "参加者 1")).toHaveCount(0);
});

test("参加者がブラウザを閉じると、その人の表示が消える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await pane(guest, 1).locator(".xterm-screen").click();
  await expect(focusBadge(host, 1, "参加者 2")).toBeVisible();

  await guest.context().close();

  await expect(focusBadge(host, 1, "参加者 2")).toHaveCount(0);
});
