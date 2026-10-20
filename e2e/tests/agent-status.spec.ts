import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

// 出力を出してから止まる偽のエージェント。エージェントとみなす名前（claude）で起動する。
// 分割で増やしたターミナルは偽のシェルにする
const busyAgent = ["--", "e2e/fixtures/agents/claude"];
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
// 本物のシェル。偽のエージェントを claude という名前で起動できるようにする
const agentsDir = fileURLToPath(new URL("../fixtures/agents", import.meta.url));
const realShell = { SHELL: "/bin/sh", PATH: `${agentsDir}:${process.env.PATH}` };
// 前面のプロセスを調べる ps を遅くするもの（e2e/fixtures/slow-ps/ps）
const slowPsDir = fileURLToPath(new URL("../fixtures/slow-ps", import.meta.url));

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

// 作業中を経て指示待ちに戻るまで待つ
async function workUntilDone(page: Page, n: number) {
  await expect(agentStatus(page, n)).toHaveText("作業中", { timeout: 5_000 });
  await expect(agentStatus(page, n)).toHaveText("指示待ち", { timeout: 10_000 });
}

test("エージェントが出力を出している間は「作業中」、止まると「指示待ち」と、参加者全員のバーに出る", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expect(agentStatus(host, 1)).toHaveText("指示待ち");
  await expect(agentStatus(guest, 1)).toHaveText("指示待ち");

  await typeInPane(host, 1, "work\n");

  await expect(agentStatus(host, 1)).toHaveText("作業中", { timeout: 5_000 });
  await expect(agentStatus(guest, 1)).toHaveText("作業中", { timeout: 5_000 });
  await expectPaneToShow(guest, 1, "done");
  await expect(agentStatus(host, 1)).toHaveText("指示待ち", { timeout: 10_000 });
  await expect(agentStatus(guest, 1)).toHaveText("指示待ち", { timeout: 10_000 });
});

test("ページが見えていないときに作業が終わると、ブラウザの通知が出る", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await setHidden(page, true);

  await expect.poll(() => notificationTitles(page), { timeout: 10_000 }).toEqual(["ターミナル 1: 指示待ち"]);
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

  await expect.poll(() => notificationTitles(page), { timeout: 10_000 }).toEqual(["ターミナル 1: 指示待ち"]);

  await page.evaluate(() => (window as any).notifications[0].onclick());
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");
});

test("フォーカスして見ているターミナルの作業が終わっても、通知は出ない", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await workUntilDone(page, 1);

  // 通知が出るなら指示待ちになった直後なので、少し待ってから確かめる
  await page.waitForTimeout(500);
  expect(await notificationTitles(page)).toEqual([]);
});

test("ページを開いただけでは、起動直後の問い合わせへの応答や出力で作業中にならず、通知も出ない", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent);
  // 偽のエージェントは起動直後に端末へ問い合わせ、ブラウザの端末が自動で応答する。そのあと 1.8 秒出力し続ける
  const page = await openAsParticipant(browser, accompany.url, "granted", true);

  // 指示待ちと判定されるまでの時間（2 秒）を過ぎるまで待つ
  await page.waitForTimeout(2_500);
  await expect(agentStatus(page, 1)).toHaveText("指示待ち");
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
  // 誰も見ていないので、終わると未確認になる（docs/adr/74-unseen-done.md）
  await expect(agentStatus(page, 1)).toHaveText("未確認", { timeout: 10_000 });

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
  await expect.poll(() => notificationTitles(host), { timeout: 15_000 }).toEqual(["ターミナル 1: 指示待ち"]);

  await guest.getByRole("tab", { name: "Workspace 1", exact: true }).click();
  await expect(agentStatus(host, 1)).toHaveText("指示待ち");
  await expect(agentStatus(guest, 1)).toHaveText("指示待ち");
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

  await expect.poll(() => notificationTitles(page), { timeout: 10_000 }).toEqual(["ターミナル 1: 指示待ち"]);

  await page.evaluate(() => (window as any).notifications[0].onclick());
  await expect(page.getByRole("tab", { name: "Workspace 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");
});

test("矢印キーやファンクションキーだけでは、そのあと出力が続いても作業中にならない", async ({ browser }) => {
  // アプリケーションカーソルモードにして画面を描き続ける TUI。矢印キーは ESC O A、F1 は ESC O P で届く
  accompany = await startAccompany(["--", "e2e/fixtures/agents/claude", "e2e/fixtures/cursor-app.ts"]);
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

test("シェルから起動したエージェントを見分けて状態を出し、起動直後の描画では作業中にならない", async ({ browser }) => {
  accompany = await startAccompany([], realShell);
  const page = await openAsParticipant(browser, accompany.url, "granted", true, "$");
  // エージェントが動いていないシェルには、状態を出さない
  await expect(agentStatus(page, 1)).toBeHidden();
  await expect(pane(page, 1)).not.toHaveAttribute("data-agent");

  // 偽のエージェントは、起動直後に 1.8 秒出力し続ける（Claude Code の起動の描画の代わり）
  await typeInPane(page, 1, "claude\n");
  await expect(agentStatus(page, 1)).toHaveText("指示待ち", { timeout: 5_000 });
  await expect(pane(page, 1)).toHaveAttribute("data-agent", "true");
  await expectPaneToShow(page, 1, "Busy Agent ready");
  // 指示待ちと判定されるまでの時間（2 秒）を過ぎるまで待つ
  await page.waitForTimeout(2_500);
  expect(await statusHistory(page)).not.toContain("作業中");
  expect(await notificationTitles(page)).toEqual([]);

  // 指示を出せば、作業中を経て指示待ちになり、通知が出る
  await typeInPane(page, 1, "work\n");
  await workUntilDone(page, 1);
  await expect.poll(() => notificationTitles(page)).toEqual(["ターミナル 1: 指示待ち"]);

  // エージェントを終えてシェルに戻ると、状態を出さなくなる
  await page.keyboard.press("Control+c");
  await expect(agentStatus(page, 1)).toBeHidden({ timeout: 5_000 });
  await expect(pane(page, 1)).not.toHaveAttribute("data-agent");
});

test("シェルで動かしたふつうのコマンドは、出力が続いて止まっても状態を出さず、通知もしない", async ({ browser }) => {
  accompany = await startAccompany([], realShell);
  const page = await openAsParticipant(browser, accompany.url, "granted", true, "$");

  // エージェントとみなさない名前で、同じ偽のコマンドを動かす
  await typeInPane(page, 1, "bun e2e/fixtures/busy-agent.ts\n");
  await expectPaneToShow(page, 1, "Busy Agent ready");
  await typeInPane(page, 1, "work\n");
  await expectPaneToShow(page, 1, "done");
  await page.waitForTimeout(2_500);

  await expect(agentStatus(page, 1)).toBeHidden();
  await expect(pane(page, 1)).not.toHaveAttribute("data-agent");
  // 状態を一度も出していない（出していない状態の表示は空のまま）
  expect((await statusHistory(page)).filter((s) => s !== "")).toEqual([]);
  expect(await notificationTitles(page)).toEqual([]);
});

test("エージェントが動いているターミナルは、フォーカスの枠とは別の表示で目立たせる", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(pane(page, 1)).toHaveAttribute("data-agent", "true");
  await expect(pane(page, 2)).not.toHaveAttribute("data-agent");
  await expect(agentStatus(page, 2)).toBeHidden();

  // フォーカスしていないエージェントのターミナルは、フォーカスの枠は出さずに、バーの見た目で目立たせる
  await pane(page, 2).locator(".xterm-screen").click();
  await expect(pane(page, 2)).toHaveAttribute("data-focused", "true");
  const style = (n: number) =>
    pane(page, n).evaluate((element) => {
      const bar = getComputedStyle(element.querySelector(".pane-bar")!);
      return { border: getComputedStyle(element).borderTopColor, bar: bar.backgroundColor + bar.boxShadow };
    });
  const agent = await style(1);
  const shell = await style(2);
  expect(agent.border).toBe("rgba(0, 0, 0, 0)");
  expect(agent.bar).not.toBe(shell.bar);

  // フォーカスしても、エージェントの表示は残る
  await pane(page, 1).locator(".xterm-screen").click();
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");
  expect((await style(1)).bar).toBe(agent.bar);
});

test("シェルで Ctrl+Z でエージェントを止めてシェルが前面に戻ると、状態を出さなくなる", async ({ browser }) => {
  accompany = await startAccompany([], realShell);
  const page = await openAsParticipant(browser, accompany.url, "granted", true, "$");
  await typeInPane(page, 1, "claude\n");
  await expect(agentStatus(page, 1)).toHaveText("指示待ち", { timeout: 5_000 });
  await expectPaneToShow(page, 1, "Busy Agent ready");

  // 止めたエージェントは端末に残るが、前面にはいない
  await page.keyboard.press("Control+z");
  await expect(agentStatus(page, 1)).toBeHidden({ timeout: 5_000 });
  await expect(pane(page, 1)).not.toHaveAttribute("data-agent");
});

test("シェルで裏に回して動かしたエージェント（claude &）には、状態を出さない", async ({ browser }) => {
  accompany = await startAccompany([], realShell);
  const page = await openAsParticipant(browser, accompany.url, "granted", true, "$");

  // 裏のエージェントも起動直後に出力するので、前面を調べるきっかけになる
  await typeInPane(page, 1, "claude &\n");
  await expectPaneToShow(page, 1, "starting");
  await page.waitForTimeout(2_500);

  await expect(agentStatus(page, 1)).toBeHidden();
  await expect(pane(page, 1)).not.toHaveAttribute("data-agent");
  expect((await statusHistory(page)).filter((s) => s !== "")).toEqual([]);
});

test("前面のプロセスを調べている最中にエージェントが終わっても、シェルに状態を残さない", async ({ browser }) => {
  // 前面のプロセスを調べる ps を遅くし、一覧を取ってから返すまでの間にエージェントを終える
  const psLog = join(mkdtempSync(join(tmpdir(), "accompany-e2e-ps-")), "ps.log");
  writeFileSync(psLog, "");
  accompany = await startAccompany([], {
    ...realShell,
    PATH: `${slowPsDir}:${realShell.PATH}`,
    E2E_PS_LOG: psLog,
    E2E_PS_DELAY: "1.5",
  });
  const page = await openAsParticipant(browser, accompany.url, "granted", true, "$");
  await typeInPane(page, 1, "claude\n");
  await expect(agentStatus(page, 1)).toHaveText("指示待ち", { timeout: 10_000 });
  await expectPaneToShow(page, 1, "Busy Agent ready");

  // 調べるのが止むまで待つ（2.5 秒続けて ps が呼ばれなければ止んだとみなす）
  const psCalls = () => readFileSync(psLog, "utf8").split("\n").filter(Boolean).length;
  let calls = psCalls();
  for (let quiet = 0; quiet < 5; ) {
    await page.waitForTimeout(500);
    const now = psCalls();
    quiet = now === calls ? quiet + 1 : 0;
    calls = now;
  }

  // 文字を打つと（エコーが出る）前面を調べる。ps が一覧を取ったら、返ってくる前にエージェントを終える。
  // シェルのプロンプトが、そのターミナルの最後の出力になる
  await typeInPane(page, 1, "x");
  await expect.poll(psCalls, { timeout: 5_000 }).toBeGreaterThan(calls);
  await page.keyboard.press("Control+c");

  await expect(agentStatus(page, 1)).toBeHidden({ timeout: 8_000 });
  await expect(pane(page, 1)).not.toHaveAttribute("data-agent");
});

// 作業が終わったが、まだ誰も見ていないもの（docs/adr/74-unseen-done.md）。
// 見た = 表示中の Workspace にあり、その参加者がそのターミナルにフォーカスしていて、ページが見えている

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" });
}

function sessions(page: Page) {
  return sidebar(page).getByRole("region", { name: "セッション" });
}

function sessionRow(page: Page, n: number) {
  return sessions(page).getByRole("button", { name: `ターミナル ${n}`, exact: true });
}

function workspaceRow(page: Page, name: string) {
  return sidebar(page)
    .locator(".workspace-row")
    .filter({ has: page.getByRole("tab", { name, exact: true }) });
}

test("誰も見ていないときに作業が終わると「未確認」になり、ほかの参加者がそのターミナルを見ると全員から消えて指示待ちになる", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await pane(guest, 2).locator(".xterm-screen").click();

  await typeInPane(host, 1, "work\n");
  await expect(agentStatus(host, 1)).toHaveText("作業中", { timeout: 5_000 });
  // どちらの参加者も、作業しているターミナルを見ていない
  await pane(host, 2).locator(".xterm-screen").click();
  await expect(pane(host, 2)).toHaveAttribute("data-focused", "true");

  for (const page of [host, guest]) {
    await expect(agentStatus(page, 1)).toHaveText("未確認", { timeout: 10_000 });
    await expect(sessionRow(page, 1)).toContainText("未確認");
    await expect(workspaceRow(page, "Workspace 1")).toContainText("未確認 1");
    await expect(sessions(page)).toContainText("未確認 1");
  }
  // 指示待ちとは別の見た目にする
  const look = (page: Page) =>
    agentStatus(page, 1).evaluate((e) => {
      const style = getComputedStyle(e);
      return style.backgroundColor + style.color;
    });
  const unseenLook = await look(host);

  // ほかの参加者（guest）が見ると、全員の表示から消える
  await pane(guest, 1).locator(".xterm-screen").click();
  for (const page of [host, guest]) {
    await expect(agentStatus(page, 1)).toHaveText("指示待ち");
    await expect(sessionRow(page, 1)).toContainText("指示待ち");
    await expect(sessionRow(page, 1)).not.toContainText("未確認");
    await expect(workspaceRow(page, "Workspace 1")).toContainText("指示待ち 1");
    await expect(workspaceRow(page, "Workspace 1")).not.toContainText("未確認");
  }
  expect(await look(host)).not.toBe(unseenLook);
});

test("フォーカスして見ているターミナルの作業が終わっても、未確認にならない", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await workUntilDone(page, 1);

  await page.waitForTimeout(500);
  expect(await statusHistory(page)).not.toContain("未確認");
});

test("ページが見えていないときに終わると、フォーカスしていても未確認になり、ページが見えるようになると消える", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await setHidden(page, true);
  await expect(agentStatus(page, 1)).toHaveText("未確認", { timeout: 10_000 });

  await setHidden(page, false);
  await expect(agentStatus(page, 1)).toHaveText("指示待ち");
});

test("表示していない Workspace で終わったターミナルは未確認になり、その Workspace を表示して見ると消える", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await sidebar(page).getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await expect(sessionRow(page, 1)).toContainText("未確認", { timeout: 10_000 });
  await expect(workspaceRow(page, "Workspace 1")).toContainText("未確認 1");

  await sessionRow(page, 1).click();
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");
  await expect(agentStatus(page, 1)).toHaveText("指示待ち");
  await expect(sessionRow(page, 1)).not.toContainText("未確認");
});

test("未確認のまま次の作業を始めると作業中になり、見ないまま終わるとまた未確認になる", async ({ browser }) => {
  accompany = await startAccompany(busyAgent);
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await setHidden(page, true);
  await expect(agentStatus(page, 1)).toHaveText("未確認", { timeout: 10_000 });

  // ページが見えていないまま、次の指示を送る
  await typeInPane(page, 1, "work\n");
  await expect(agentStatus(page, 1)).toHaveText("作業中", { timeout: 5_000 });
  await expect(agentStatus(page, 1)).toHaveText("未確認", { timeout: 10_000 });
});
