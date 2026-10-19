import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane } from "./panes";

// 最初のターミナルは、出力を出してから止まる偽のエージェント（「work」で 3 秒、「longwork」で 6 秒作業する）。
// 分割や新しい Workspace で増やすターミナルは、入力した行（「2;タイトル」）をタイトルに設定する偽のシェルにする
const busyAgent = ["--", "bun", "e2e/fixtures/busy-agent.ts"];
const titleShell = { SHELL: "e2e/fixtures/title-shell" };

// ショートカットは macOS 向けの Cmd+Shift と、Windows / Linux 向けの Ctrl+Shift のどちらでも動く（docs/adr/31-shortcuts.md）
const modifiers = ["Meta+Shift", "Control+Shift"] as const;

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Busy Agent ready");
  return page;
}

function input(page: Page, n: number) {
  return pane(page, n).locator(".xterm-helper-textarea");
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" });
}

function sidebarToggle(page: Page) {
  return page.getByRole("button", { name: "サイドメニュー", exact: true });
}

function workspace(page: Page, name: string) {
  return sidebar(page).getByRole("tab", { name, exact: true });
}

// Workspace の行（選ぶボタン・状態の印・閉じるボタン）
function workspaceRow(page: Page, name: string) {
  return sidebar(page)
    .locator(".workspace-row")
    .filter({ has: page.getByRole("tab", { name, exact: true }) });
}

function sessions(page: Page) {
  return sidebar(page).getByRole("region", { name: "セッション" });
}

// セッションの一覧の、そのターミナルの行
function session(page: Page, n: number) {
  return sessions(page).getByRole("button", { name: `ターミナル ${n}`, exact: true });
}

// セッションの一覧に並んでいるターミナルの名前（上から順に）
async function sessionOrder(page: Page) {
  return sessions(page)
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")));
}

async function splitRight(page: Page, n: number, created: number) {
  await pane(page, n).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, created, "Title setter ready");
}

async function newWorkspace(page: Page, created: number) {
  await sidebar(page).getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(page, created, "Title setter ready");
}

async function setTitle(page: Page, n: number, title: string) {
  await input(page, n).focus();
  await page.keyboard.type(`2;${title}\n`);
  await expect(pane(page, n).locator(".pane-program")).toHaveText(title);
}

// キー入力の先がそのターミナルにあり、全員の画面の表示（「あなた」）もそこにある
async function expectFocusOn(page: Page, n: number) {
  await expect(input(page, n)).toBeFocused();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

test("サイドメニューに、Workspace の一覧と、すべての Workspace のセッションが、タイトル・状態・フォーカスしている参加者とともに出る", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expect(sidebar(page)).toBeVisible();
  await splitRight(page, 1, 2);
  await setTitle(page, 2, "vim notes.md");
  await newWorkspace(page, 3);
  await setTitle(page, 3, "claude");

  await expect(sidebar(page).getByRole("tab")).toHaveText(["Workspace 1", "Workspace 2"]);
  await expect(workspace(page, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  await expect(workspaceRow(page, "Workspace 1")).toContainText("入力待ち 2");
  await expect(workspaceRow(page, "Workspace 2")).toContainText("入力待ち 1");
  await expect(sidebar(page).getByRole("button", { name: "Workspace 1 を閉じる" })).toBeEnabled();

  // セッションは、Workspace ごとにまとめて、配置の順に並ぶ
  expect(await sessionOrder(page)).toEqual(["ターミナル 1", "ターミナル 2", "ターミナル 3"]);
  const group = (name: string) => sessions(page).getByRole("group", { name, exact: true });
  await expect(group("Workspace 1").getByRole("button")).toHaveCount(2);
  await expect(group("Workspace 2").getByRole("button")).toHaveCount(1);
  await expect(session(page, 1)).toContainText("入力待ち");
  await expect(session(page, 2)).toContainText("vim notes.md");
  await expect(session(page, 3)).toContainText("claude");
  // 自分は新しい Workspace のターミナル 3 にフォーカスしている
  await expect(session(page, 3)).toContainText("あなた");
  await expect(session(page, 1)).not.toContainText("あなた");
  await expect(sessions(page)).toContainText("入力待ち 3");
  await expect(sessions(page)).toContainText("作業中 0");

  // Workspace を選ぶと切り替わる
  await workspace(page, "Workspace 1").click();
  await expect(workspace(page, "Workspace 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 2, "Title setter ready");
});

test("状態・タイトル・フォーカスの変化が、Workspace の印とセッションの一覧にすぐ反映される", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await splitRight(host, 1, 2);
  await expectPaneToShow(guest, 2, "Title setter ready");

  await input(host, 1).focus();
  await host.keyboard.type("longwork\n");
  await expect(session(host, 1)).toContainText("作業中", { timeout: 5_000 });
  await expect(workspaceRow(host, "Workspace 1")).toContainText("作業中 1");
  await expect(sessions(host)).toContainText("作業中 1");
  await expect(sessions(guest)).toContainText("作業中 1");

  // 表示していない Workspace のターミナルの状態も、印と一覧に出る
  await newWorkspace(host, 3);
  await expect(workspaceRow(host, "Workspace 1")).toContainText("作業中 1");
  await expect(session(host, 1)).toContainText("作業中");

  // ほかの参加者がタイトルを変え、そのターミナルにフォーカスする
  await setTitle(guest, 3, "npm test");
  await expect(session(host, 3)).toContainText("npm test");
  await expect(session(host, 3)).toContainText("参加者");

  // 作業が終わると入力待ちになる
  await expect(session(host, 1)).toContainText("入力待ち", { timeout: 10_000 });
  await expect(workspaceRow(host, "Workspace 1")).not.toContainText("作業中");
  await expect(workspaceRow(host, "Workspace 1")).toContainText("入力待ち 2");
  await expect(sessions(host)).toContainText("作業中 0");
});

test("セッションを選ぶと、その Workspace に切り替わり、そのターミナルにフォーカスする", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await newWorkspace(page, 2);
  await splitRight(page, 2, 3);

  await session(page, 1).click();
  await expect(workspace(page, "Workspace 1")).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 1);

  await session(page, 3).click();
  await expect(workspace(page, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);

  // 表示中の Workspace のターミナルを選んだときも、そのターミナルにフォーカスする
  await session(page, 2).click();
  await expectFocusOn(page, 2);
});

for (const modifier of modifiers) {
  test(`${modifier}+E でサイドメニューへ移り、↑↓ と Enter で Workspace やセッションを選び、Esc でターミナルに戻る`, async ({
    browser,
  }) => {
    accompany = await startAccompany(busyAgent, titleShell);
    const page = await openAsParticipant(browser, accompany.url);
    await newWorkspace(page, 2);
    await expectFocusOn(page, 2);

    // 自分がフォーカスしているターミナルの行に移る
    await page.keyboard.press(`${modifier}+E`);
    await expect(session(page, 2)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(session(page, 1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(workspace(page, "Workspace 1")).toHaveAttribute("aria-selected", "true");
    await expectFocusOn(page, 1);

    // Workspace を選んだときは、続けてセッションを選べるよう、サイドメニューに残る
    await page.keyboard.press(`${modifier}+E`);
    await expect(session(page, 1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(workspace(page, "Workspace 2")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(workspace(page, "Workspace 2")).toHaveAttribute("aria-selected", "true");
    await expectPaneToShow(page, 2, "Title setter ready");
    await expect(workspace(page, "Workspace 2")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(session(page, 1)).toBeFocused();

    await page.keyboard.press("Escape");
    await expectFocusOn(page, 2);
    await page.keyboard.type("2;after sidebar\n");
    await expect(pane(page, 2).locator(".pane-program")).toHaveText("after sidebar");
  });
}

test("サイドメニューは、ボタンとショートカットで参加者ごとに出す・隠すを切り替えられ、開き直しても覚えている", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expect(sidebarToggle(host)).toHaveAttribute("aria-expanded", "true");
  const before = await boxOf(host, 1);

  await sidebarToggle(host).click();

  await expect(sidebar(host)).toBeHidden();
  await expect(sidebarToggle(host)).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar(guest)).toBeVisible();
  // 隠している間も、ツールバーに表示中の Workspace が出る。ターミナルは空いた分だけ広がる
  await expect(host.getByRole("navigation", { name: "ツールバー" })).toContainText("Workspace 1");
  await expect.poll(async () => (await boxOf(host, 1)).width).toBeGreaterThan(before.width + 100);

  await input(host, 1).focus();
  await host.keyboard.press("Control+Shift+S");
  await expect(sidebar(host)).toBeVisible();
  await expect(input(host, 1)).toBeFocused();
  await host.keyboard.press("Meta+Shift+S");
  await expect(sidebar(host)).toBeHidden();
  await expect(input(host, 1)).toBeFocused();

  await host.reload();
  await expectPaneToShow(host, 1, "Busy Agent ready");
  await expect(sidebar(host)).toBeHidden();

  // 隠しているときにサイドメニューへ移ると、出して移る
  await input(host, 1).focus();
  await host.keyboard.press("Control+Shift+E");
  await expect(sidebar(host)).toBeVisible();
  await expect(session(host, 1)).toBeFocused();
});

test("ウィンドウが狭いときは、最初はサイドメニューを隠しておき、ボタンで出せる", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const context = await browser.newContext({ viewport: { width: 800, height: 720 } });
  const page = await context.newPage();
  await page.goto(accompany.url);
  await expectPaneToShow(page, 1, "Busy Agent ready");

  await expect(sidebar(page)).toBeHidden();
  await expect(sidebarToggle(page)).toHaveAttribute("aria-expanded", "false");
  await sidebarToggle(page).click();
  await expect(sidebar(page)).toBeVisible();
  // 自分で出したら、開き直しても出す
  await page.reload();
  await expectPaneToShow(page, 1, "Busy Agent ready");
  await expect(sidebar(page)).toBeVisible();
});

test("サイドメニューを出す・隠すと表示領域が変わり、枠に収まらなくなった参加者の画面では自動で拡大する", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await splitRight(host, 1, 2);
  await expectPaneToShow(guest, 2, "Title setter ready");
  await input(guest, 1).focus();
  const zoomed = (page: Page) => pane(page, 1).getByText("拡大中");

  // 同じ画面の大きさなので、どちらの枠にも収まる
  await expect(zoomed(guest)).toBeHidden();

  // host がサイドメニューを隠すと、端末は host の広くなった枠に合わせて大きくなり、guest の枠には収まらない
  await sidebarToggle(host).click();
  await expect(zoomed(guest)).toBeVisible();
  await expect(zoomed(host)).toBeHidden();

  // guest も隠すと、また収まって元の分割の表示に戻る
  await sidebarToggle(guest).click();
  await expect(zoomed(guest)).toBeHidden();
  await expect(pane(guest, 2)).toBeVisible();

  // guest が出し直すとまた拡大し、host も出し直すと戻る
  await sidebarToggle(guest).click();
  await expect(zoomed(guest)).toBeVisible();
  await sidebarToggle(host).click();
  await expect(zoomed(guest)).toBeHidden();
});

test("サイドメニューのショートカットは、ボタンのツールチップとショートカットの一覧に載る", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);

  await expect(sidebarToggle(page)).toHaveAttribute("title", "サイドメニューを出す・隠す（⌘⇧S / Ctrl+Shift+S）");
  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  for (const text of ["サイドメニューを出す・隠す", "サイドメニューへ移る", "⌘⇧S", "Ctrl+Shift+E"]) {
    await expect(list).toContainText(text);
  }
});
