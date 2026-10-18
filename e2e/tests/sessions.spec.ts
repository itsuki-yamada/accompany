import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

// 最初のターミナルは、出力を出してから止まる偽のエージェント（「work」で 3 秒、「longwork」で 6 秒作業する）。
// 分割や新しいタブで増やすターミナルは、入力した行（「2;タイトル」）をタイトルに設定する偽のシェルにする
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

function tab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function sessionList(page: Page) {
  return page.getByRole("dialog", { name: "セッション一覧" });
}

// 一覧の中の、そのターミナルの行
function session(page: Page, n: number) {
  return sessionList(page).getByRole("option", { name: `ターミナル ${n}`, exact: true });
}

// 一覧に並んでいるターミナルの名前（上から順に）
async function sessionOrder(page: Page) {
  return sessionList(page)
    .getByRole("option")
    .evaluateAll((options) => options.map((o) => o.getAttribute("aria-label")));
}

async function openSessionList(page: Page) {
  await page.getByRole("button", { name: "セッション一覧" }).click();
  await expect(sessionList(page)).toBeVisible();
}

async function splitRight(page: Page, n: number, created: number) {
  await pane(page, n).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, created, "Title setter ready");
}

async function newTab(page: Page, created: number) {
  await page.getByRole("button", { name: "新しいタブ" }).click();
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

test("一覧に、すべてのタブのターミナルが、タブ・タイトル・状態・フォーカスしている参加者とともに並ぶ", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitRight(page, 1, 2);
  await setTitle(page, 2, "vim notes.md");
  await newTab(page, 3);
  await setTitle(page, 3, "claude");

  await openSessionList(page);

  expect(await sessionOrder(page)).toEqual(["ターミナル 1", "ターミナル 2", "ターミナル 3"]);
  await expect(session(page, 1)).toContainText("タブ 1");
  await expect(session(page, 1)).toContainText("入力待ち");
  await expect(session(page, 2)).toContainText("タブ 1");
  await expect(session(page, 2)).toContainText("vim notes.md");
  await expect(session(page, 3)).toContainText("タブ 2");
  await expect(session(page, 3)).toContainText("claude");
  // 自分は新しいタブのターミナル 3 にフォーカスしている
  await expect(session(page, 3)).toContainText("あなた");
  await expect(session(page, 1)).not.toContainText("あなた");
  await expect(sessionList(page)).toContainText("入力待ち 3");
  await expect(sessionList(page)).toContainText("作業中 0");
});

test("入力待ちのターミナルが上に並び、開いている間も状態・タイトル・フォーカスの変化が反映される", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await splitRight(host, 1, 2);
  await expectPaneToShow(guest, 2, "Title setter ready");

  await input(host, 1).focus();
  await host.keyboard.type("longwork\n");
  await expect(pane(host, 1).getByRole("status", { name: "エージェントの状態" })).toHaveText("作業中", {
    timeout: 5_000,
  });

  await openSessionList(host);
  await expect(session(host, 1)).toContainText("作業中");
  expect(await sessionOrder(host)).toEqual(["ターミナル 2", "ターミナル 1"]);
  await expect(sessionList(host)).toContainText("入力待ち 1");
  await expect(sessionList(host)).toContainText("作業中 1");

  // 一覧を開いたまま、ほかの参加者がタイトルを変え、そのターミナルにフォーカスする
  await setTitle(guest, 2, "npm test");
  await expect(session(host, 2)).toContainText("npm test");
  await expect(session(host, 2)).toContainText("参加者");

  // 作業が終わると入力待ちになり、並び順も変わる
  await expect(session(host, 1)).toContainText("入力待ち", { timeout: 10_000 });
  await expect(sessionList(host)).toContainText("入力待ち 2");
  expect(await sessionOrder(host)).toEqual(["ターミナル 1", "ターミナル 2"]);
  await expect(sessionList(host)).toBeVisible();
});

test("一覧からほかのタブのターミナルを選ぶと、そのタブに切り替わり、そのターミナルにフォーカスする", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await newTab(page, 2);
  await splitRight(page, 2, 3);
  await expect(tab(page, "タブ 2")).toHaveAttribute("aria-selected", "true");

  await openSessionList(page);
  await session(page, 1).click();

  await expect(sessionList(page)).toBeHidden();
  await expect(tab(page, "タブ 1")).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 1);

  // 同じタブのターミナルを選んだときも、そのターミナルにフォーカスする
  await splitRight(page, 1, 4);
  await openSessionList(page);
  await session(page, 4).click();
  await expect(sessionList(page)).toBeHidden();
  await expectFocusOn(page, 4);
});

for (const modifier of modifiers) {
  test(`${modifier}+S で一覧を開き、↑↓ で選んで Enter で移る。Esc で閉じると元のターミナルに戻る`, async ({
    browser,
  }) => {
    accompany = await startAccompany(busyAgent, titleShell);
    const page = await openAsParticipant(browser, accompany.url);
    await newTab(page, 2);
    await expectFocusOn(page, 2);

    await page.keyboard.press(`${modifier}+S`);
    await expect(sessionList(page)).toBeVisible();
    // 最初は一番上の行を選んでいる
    await expect(session(page, 1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(session(page, 2)).toHaveAttribute("aria-selected", "true");
    await expect(session(page, 1)).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("ArrowUp");
    await expect(session(page, 1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(sessionList(page)).toBeHidden();
    await expect(tab(page, "タブ 1")).toHaveAttribute("aria-selected", "true");
    await expectFocusOn(page, 1);

    await page.keyboard.press(`${modifier}+S`);
    await expect(sessionList(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sessionList(page)).toBeHidden();
    await expectFocusOn(page, 1);
    // 閉じたあとは、そのままターミナルに入力できる
    await page.keyboard.type("after list\n");
    await expectPaneToShow(page, 1, "after list");
  });
}

test("一覧を開くショートカットは、タブバーのボタンのツールチップとショートカットの一覧に載る", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);

  await expect(page.getByRole("button", { name: "セッション一覧" })).toHaveAttribute(
    "title",
    "セッション一覧（⌘⇧S / Ctrl+Shift+S）",
  );
  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toContainText("セッション一覧");
  await expect(list).toContainText("⌘⇧S");
  await expect(list).toContainText("Ctrl+Shift+S");
});
