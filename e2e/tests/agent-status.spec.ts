import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

// 出力を出してから止まる偽のエージェント。分割で増やしたターミナルは偽のシェルにする
const busyAgent = ["--", "bun", "e2e/fixtures/busy-agent.ts"];
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

type Permission = "default" | "granted" | "denied";

// ブラウザの通知（Notification API）を差し替え、出した通知と許可を求めた回数を記録する。
// ページが見えているかどうか（document.hidden）も、テストから切り替えられるようにする。
// バーに出たエージェントの状態は、一瞬で変わったものも見逃さないよう、変わるたびに記録する
async function openAsParticipant(
  browser: Browser,
  url: string,
  permission: Permission = "granted",
  initiallyHidden = false,
  ready = "Busy Agent ready",
) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(([initial, initiallyHidden]: [Permission, boolean]) => {
    const w = window as any;
    w.notifications = [];
    w.permissionRequests = 0;
    w.FakeNotification = class {
      static permission = initial;
      static async requestPermission() {
        w.permissionRequests++;
        return w.FakeNotification.permission;
      }
      onclick: (() => void) | null = null;
      constructor(
        readonly title: string,
        readonly options?: NotificationOptions,
      ) {
        w.notifications.push(this);
      }
      close() {}
    };
    Object.defineProperty(window, "Notification", { value: w.FakeNotification });

    let hidden = initiallyHidden;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
    w.setHidden = (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };

    w.statusHistory = [];
    new MutationObserver(() => {
      document.querySelectorAll('[role="status"][aria-label="エージェントの状態"]').forEach((e) => {
        if (w.statusHistory.at(-1) !== e.textContent) w.statusHistory.push(e.textContent);
      });
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, [permission, initiallyHidden] as [Permission, boolean]);
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, ready);
  return page;
}

function agentStatus(page: Page, n: number) {
  return pane(page, n).getByRole("status", { name: "エージェントの状態" });
}

function notificationTitles(page: Page) {
  return page.evaluate(() => (window as any).notifications.map((n: Notification) => n.title));
}

function statusHistory(page: Page) {
  return page.evaluate(() => (window as any).statusHistory as string[]);
}

function setHidden(page: Page, hidden: boolean) {
  return page.evaluate((value) => (window as any).setHidden(value), hidden);
}

// 作業中を経て入力待ちに戻るまで待つ
async function workUntilDone(page: Page, n: number) {
  await expect(agentStatus(page, n)).toHaveText("作業中", { timeout: 5_000 });
  await expect(agentStatus(page, n)).toHaveText("入力待ち", { timeout: 10_000 });
}

test("エージェントが出力を出している間は「作業中」、止まると「入力待ち」と、参加者全員のバーに出る", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expect(agentStatus(host, 1)).toHaveText("入力待ち");
  await expect(agentStatus(guest, 1)).toHaveText("入力待ち");

  await typeInPane(host, 1, "work\n");

  await expect(agentStatus(host, 1)).toHaveText("作業中", { timeout: 5_000 });
  await expect(agentStatus(guest, 1)).toHaveText("作業中", { timeout: 5_000 });
  await expectPaneToShow(guest, 1, "done");
  await expect(agentStatus(host, 1)).toHaveText("入力待ち", { timeout: 10_000 });
  await expect(agentStatus(guest, 1)).toHaveText("入力待ち", { timeout: 10_000 });
});

test("ページが見えていないときに作業が終わると、ブラウザの通知が出る", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await setHidden(page, true);

  await expect.poll(() => notificationTitles(page), { timeout: 10_000 }).toEqual(["ターミナル 1: 入力待ち"]);
});

test("別のターミナルにフォーカスしているときに作業が終わると通知が出て、クリックするとそのターミナルに移る", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await pane(page, 2).locator(".xterm-screen").click();
  await expect(pane(page, 2)).toHaveAttribute("data-focused", "true");

  await expect.poll(() => notificationTitles(page), { timeout: 10_000 }).toEqual(["ターミナル 1: 入力待ち"]);

  await page.evaluate(() => (window as any).notifications[0].onclick());
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");
});

test("フォーカスして見ているターミナルの作業が終わっても、通知は出ない", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await workUntilDone(page, 1);

  // 通知が出るなら入力待ちになった直後なので、少し待ってから確かめる
  await page.waitForTimeout(500);
  expect(await notificationTitles(page)).toEqual([]);
});

test("ページを開いただけでは、起動直後の問い合わせへの応答や出力で作業中にならず、通知も出ない", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent);
  // 偽のエージェントは起動直後に端末へ問い合わせ、ブラウザの端末が自動で応答する。そのあと 1.8 秒出力し続ける
  const page = await openAsParticipant(browser, accompany.url, "granted", true);

  // 入力待ちと判定されるまでの時間（2 秒）を過ぎるまで待つ
  await page.waitForTimeout(2_500);
  await expect(agentStatus(page, 1)).toHaveText("入力待ち");
  expect(await statusHistory(page)).not.toContain("作業中");
  expect(await notificationTitles(page)).toEqual([]);
});

test("入力の表示（エコー）では作業中にならず、通知も出ない", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);
  await setHidden(page, true);

  // 1 文字ずつ 1.5 秒以上打ち続けても、エコーだけでは作業中にならない
  await pane(page, 1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("hello agent status", { delay: 100 });
  await expectPaneToShow(page, 1, "hello agent status");
  await page.waitForTimeout(2_500);

  expect(await statusHistory(page)).not.toContain("作業中");
  expect(await notificationTitles(page)).toEqual([]);
});

test("入力のあとしばらく出力がなければ、そのあと出力が続いても作業中にならない", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);
  await setHidden(page, true);

  // 偽のエージェントは「later」を受け取ると、3 秒何も出さずに待ってから 3 秒出力し続ける
  await typeInPane(page, 1, "later\n");
  await expect(pane(page, 1).locator(".xterm-rows")).toContainText("done", { timeout: 10_000 });
  await page.waitForTimeout(2_500);

  expect(await statusHistory(page)).not.toContain("作業中");
  expect(await notificationTitles(page)).toEqual([]);
});

test("通知の許可は、ページを開いただけでは求めず、最初に操作したときに 1 回だけ求める", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url, "default");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).permissionRequests)).toBe(0);

  await pane(page, 1).locator(".xterm-screen").click();
  await expect.poll(() => page.evaluate(() => (window as any).permissionRequests)).toBe(1);

  // 許可されなかった（default のまま）あとも、続けて操作して何度も求めない
  await typeInPane(page, 1, "hello\n");
  await pane(page, 1).locator(".xterm-screen").click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).permissionRequests)).toBe(1);
});

test("通知が許可されていなければ、作業が終わっても通知を出さない", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url, "denied");

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await setHidden(page, true);
  await expect(agentStatus(page, 1)).toHaveText("入力待ち", { timeout: 10_000 });

  await page.waitForTimeout(500);
  expect(await notificationTitles(page)).toEqual([]);
});

test("表示していない Workspace のターミナルの状態も配られ、その Workspace に切り替えるとバーに今の状態が出る", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await typeInPane(host, 1, "longwork\n");
  await expect(agentStatus(host, 1)).toHaveText("作業中", { timeout: 5_000 });
  // Workspace は参加者全員で共有する。新しい Workspace を開くと、全員の画面が Workspace 2 に切り替わる
  await host.getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await expect(pane(guest, 1)).toHaveCount(0);

  await guest.getByRole("tab", { name: "Workspace 1", exact: true }).click();
  await expect(agentStatus(host, 1)).toHaveText("作業中");
  await expect(agentStatus(guest, 1)).toHaveText("作業中");

  await guest.getByRole("tab", { name: "Workspace 2", exact: true }).click();
  await expect(pane(guest, 1)).toHaveCount(0);
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  // Workspace 2 を表示している間に作業が終わる
  await expect.poll(() => notificationTitles(host), { timeout: 15_000 }).toEqual(["ターミナル 1: 入力待ち"]);

  await guest.getByRole("tab", { name: "Workspace 1", exact: true }).click();
  await expect(agentStatus(host, 1)).toHaveText("入力待ち");
  await expect(agentStatus(guest, 1)).toHaveText("入力待ち");
});

test("表示していない Workspace のターミナルの作業が終わると通知が出て、クリックするとその Workspace に切り替わる", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await page.getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await expect.poll(() => notificationTitles(page), { timeout: 10_000 }).toEqual(["ターミナル 1: 入力待ち"]);

  await page.evaluate(() => (window as any).notifications[0].onclick());
  await expect(page.getByRole("tab", { name: "Workspace 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");
});

test("矢印キーやファンクションキーだけでは、そのあと出力が続いても作業中にならない", async ({ browser }) => {
  // アプリケーションカーソルモードにして画面を描き続ける TUI。矢印キーは ESC O A、F1 は ESC O P で届く
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/cursor-app.ts"]);
  const page = await openAsParticipant(browser, accompany.url, "granted", false, "Cursor App ready");
  await pane(page, 1).locator(".xterm-helper-textarea").focus();

  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F1", "ArrowUp"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
  }
  // 数える入力なら、そのあとも出力が続くので 1 秒あまりで作業中になる。それを過ぎるまで待つ
  await page.waitForTimeout(2_000);
  expect(await statusHistory(page)).not.toContain("作業中");

  // 文字を打てば、出力が続いているので作業中になる（この TUI で判定が働くことの確認）
  await page.keyboard.type("a");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
});
