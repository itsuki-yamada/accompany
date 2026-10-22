import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { addToView, boxOf, expectPaneToShow, pane, panes, tab } from "./panes";

// 最初のターミナルは、出力を出してから止まる偽のエージェント（「work」で 3 秒、「longwork」で 6 秒作業する）。
// エージェントとみなす名前（claude）で起動する（docs/adr/70-agent-detection.md）。
// 分割や新しいタブで増やすターミナルは、入力した行（「2;タイトル」）をタイトルに設定する偽のシェルにする。
// 偽のシェルはエージェントではないので、状態を出さず、件数にも数えない
const busyAgent = ["--", "e2e/fixtures/agents/claude"];
const titleShell = { SHELL: "e2e/fixtures/title-shell" };

// ショートカットは macOS 向けの Cmd+Shift と、Windows / Linux 向けの Ctrl+Shift のどちらでも動く（docs/adr/31-shortcuts.md）
const modifiers = ["Meta+Shift", "Control+Shift"] as const;

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
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

// サイドメニューのタブの一覧
function tabList(page: Page) {
  return sidebar(page).getByRole("tablist", { name: "タブ" });
}

// 見出しの、状態ごとの全体の件数
function summary(page: Page) {
  return sidebar(page).locator(".sidebar-summary .status-count");
}

async function splitRight(page: Page, n: number, created: number) {
  await pane(page, n).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, created, "Title setter ready");
}

async function newTab(page: Page, created: number) {
  await sidebar(page).getByRole("button", { name: "新しいタブ" }).click();
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

test("サイドメニューに、タブ（ターミナル）の一覧が、タイトル・状態・フォーカスしている参加者とともに出る", async ({
  browser,
}) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expect(sidebar(page)).toBeVisible();
  await splitRight(page, 1, 2);
  await setTitle(page, 2, "vim notes.md");
  await newTab(page, 3);
  await setTitle(page, 3, "claude");

  // 開いた順に並ぶ。表示しているタブ（ターミナル 3）が選ばれている
  await expect(tabList(page)).toHaveAttribute("aria-multiselectable", "true");
  await expect(tabList(page).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/, /ターミナル 3/]);
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "false");
  await expect(tab(page, 1)).toContainText("指示待ち");
  await expect(tab(page, 2)).toContainText("vim notes.md");
  // タイトルが claude でも、前面のプロセスがエージェントでなければ状態を出さない
  await expect(tab(page, 3)).toContainText("claude");
  for (const n of [2, 3]) {
    await expect(tab(page, n)).not.toContainText("指示待ち");
    await expect(tab(page, n)).not.toContainText("作業中");
  }
  // 自分はターミナル 3 にフォーカスしている
  await expect(tab(page, 3)).toContainText("あなた");
  await expect(tab(page, 1)).not.toContainText("あなた");
  // 見出しの全体の件数は、0 件の状態を出さない
  await expect(summary(page)).toHaveText(["指示待ち 1"]);
  await expect(sidebar(page).getByRole("button", { name: "ターミナル 1 を閉じる" })).toBeEnabled();
  await expect(sidebar(page).getByText("Workspace")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("sidebar-tabs.png") });

  // タブを選ぶと、そのタブだけを表示する
  await tab(page, 1).click();
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect(panes(page)).toHaveCount(1);
  await expectFocusOn(page, 1);
});

test("状態・タイトル・フォーカスの変化が、タブの一覧と件数にすぐ反映される", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await splitRight(host, 1, 2);

  await input(host, 1).focus();
  await host.keyboard.type("longwork\n");
  await expect(tab(host, 1)).toContainText("作業中", { timeout: 5_000 });
  await expect(summary(host)).toHaveText(["作業中 1"]);
  await expect(summary(guest)).toHaveText(["作業中 1"]);

  // 表示していないタブのターミナルの状態も、一覧と件数に出る
  await newTab(host, 3);
  await expect(tab(host, 1)).toContainText("作業中");
  await expect(summary(host)).toHaveText(["作業中 1"]);

  // ほかの参加者がタイトルを変え、そのターミナルにフォーカスする
  await tab(guest, 3).click();
  await setTitle(guest, 3, "npm test");
  await expect(tab(host, 3)).toContainText("npm test");
  await expect(tab(host, 3)).toContainText("参加者 2");

  // 誰も見ていないまま作業が終わると、未確認になる（docs/adr/74-unseen-done.md）
  await expect(tab(host, 1)).toContainText("未確認", { timeout: 10_000 });
  await expect(summary(host)).toHaveText(["未確認 1"]);
  await expect(summary(guest)).toHaveText(["未確認 1"]);
});

for (const modifier of modifiers) {
  test(`${modifier}+E でサイドメニューへ移り、↑↓ と Enter でタブを選び、Esc でターミナルに戻る`, async ({ browser }) => {
    accompany = await startAccompany(busyAgent, titleShell);
    const page = await openAsParticipant(browser, accompany.url);
    await newTab(page, 2);
    await expectFocusOn(page, 2);

    // 自分がフォーカスしているターミナルのタブに移る
    await page.keyboard.press(`${modifier}+E`);
    await expect(tab(page, 2)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(tab(page, 1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
    await expectFocusOn(page, 1);

    await page.keyboard.press(`${modifier}+E`);
    await expect(tab(page, 1)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(tab(page, 2)).toBeFocused();
    await page.keyboard.press("Escape");
    await expectFocusOn(page, 1);
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
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
  // 隠している間は、ツールバーにタブが並ぶ。ターミナルは空いた分だけ広がる
  await expect(host.getByRole("navigation", { name: "ツールバー" }).getByRole("tab")).toHaveText([/ターミナル 1/]);
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
  await expect(tab(host, 1)).toBeFocused();
});

test("ウィンドウが狭いときは、最初はサイドメニューを隠しておき、ボタンで出せる", async ({ browser }) => {
  accompany = await startAccompany(busyAgent, titleShell);
  const context = await newContext(browser, { viewport: { width: 800, height: 720 } });
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

test("サイドメニューを出す・隠すと表示領域が変わり、枠が下限より狭くなった参加者の画面では、拡大せずにはみ出す", async ({
  browser,
}) => {
  // 下限（幅 600 のウィンドウに収まる列数）は、サイドメニューを隠して左右に分割した枠には収まり、
  // サイドメニューを出して分割した枠には収まらない（docs/adr/99-smallest-size.md）。
  // 収まらなくても拡大せず、はみ出した分はスクロールで見る（docs/adr/126-no-zoom.md）
  accompany = await startAccompany(busyAgent, titleShell, { minWindow: "600x0" });
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await sidebarToggle(host).click();
  await sidebarToggle(guest).click();
  await splitRight(host, 1, 2);
  await input(guest, 1).focus();
  await addToView(guest, 2);
  await expectPaneToShow(guest, 2, "Title setter ready");
  const fits = (page: Page) =>
    pane(page, 1)
      .locator(".pane-terminal")
      .evaluate((e) => e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight);
  const expectSplit = async (page: Page) => {
    for (const n of [1, 2]) await expect(pane(page, n)).toBeVisible();
    await expect(page.getByText("拡大中")).toHaveCount(0);
  };

  // どちらもサイドメニューを隠しているので、どちらの枠にも収まる
  await expect.poll(() => fits(guest)).toBe(true);

  // guest がサイドメニューを出すと、guest の枠は下限より狭くなり、端末が収まらない。拡大はしない
  await sidebarToggle(guest).click();
  await expect.poll(() => fits(guest)).toBe(false);
  // 以前は収まらない状態が 300ms 続くと拡大していた。それより長く待っても分割したまま
  await guest.waitForTimeout(1000);
  await expectSplit(guest);
  expect(await fits(guest)).toBe(false);
  expect(await fits(host)).toBe(true);

  // guest がまた隠すと、収まる
  await sidebarToggle(guest).click();
  await expect.poll(() => fits(guest)).toBe(true);
  await expectSplit(guest);

  // guest が出し直すとまた収まらず、host も出すと、全員の枠が下限より狭くなって一番広い枠に合わせるので、収まる
  await sidebarToggle(guest).click();
  await expect.poll(() => fits(guest)).toBe(false);
  await sidebarToggle(host).click();
  await expect.poll(() => fits(guest)).toBe(true);
  await expectSplit(guest);
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
