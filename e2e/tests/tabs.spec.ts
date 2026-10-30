import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectFillsArea, expectPaneToShow, pane, panes, tab, tabs, typeInPane } from "./panes";

// ターミナル 1 つが 1 つのタブ。どのタブを表示しているかは参加者ごと（docs/adr/100-terminal-tabs.md）。
// 新しいタブは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string, viewport = { width: 1280, height: 720 }) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" });
}

function toolbar(page: Page) {
  return page.getByRole("navigation", { name: "ツールバー" });
}

async function openNewTab(page: Page) {
  await page.getByRole("button", { name: "新しいタブ" }).click();
}

async function exitShell(page: Page, n: number) {
  // 偽のシェル（cat）は、行頭の Ctrl+D で入力が終わると終了する
  await pane(page, n).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+D");
}

test("新しいタブを開くと、サイドメニューにタブとして並び、そのターミナルだけが画面いっぱいに出て操作できる", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(sidebar(page).getByRole("tab")).toHaveText([/ターミナル 1/]);
  await expect(page.getByText("Workspace")).toHaveCount(0);

  await openNewTab(page);

  await expect(sidebar(page).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "false");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 2);
  await expect(pane(page, 2).locator(".xterm-helper-textarea")).toBeFocused();
  await typeInPane(page, 2, "typed in tab 2\n");
  await expectPaneToShow(page, 2, "typed in tab 2");
});

test("タブを選ぶと、そのターミナルだけが画面いっぱいに出て、切り替える前の画面がそのまま戻る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await typeInPane(page, 1, "typed in tab 1\n");
  await expectPaneToShow(page, 1, "typed in tab 1");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await tab(page, 1).click();

  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 1, "typed in tab 1");
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 1);
  await expect(pane(page, 1).locator(".xterm-helper-textarea")).toBeFocused();
});

test("どのタブを見ているかは参加者ごとで、ほかの参加者がタブを開いたり切り替えたりしても、自分の表示は変わらない", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expectPaneToShow(guest, 1, "Fake Shell ready");

  // 開いたタブは全員の一覧に並ぶが、開いた人の表示だけが切り替わる
  await openNewTab(host);
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await expect(sidebar(guest).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await expect(tab(guest, 1)).toHaveAttribute("aria-selected", "true");
  await expect(tab(guest, 2)).toHaveAttribute("aria-selected", "false");
  await expect(pane(guest, 1)).toBeVisible();
  await expect(pane(guest, 2)).toHaveCount(0);

  // guest が切り替えても、host の表示は変わらない
  await tab(guest, 2).click();
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await tab(host, 1).click();
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await host.waitForTimeout(300);
  await expect(pane(guest, 2)).toBeVisible();
  await expect(pane(guest, 1)).toHaveCount(0);
  await expect(tab(guest, 2)).toHaveAttribute("aria-selected", "true");

  // 同じタブにほかの参加者が入力したものは、そのタブを見ている人に出る
  await typeInPane(host, 1, "typed by host\n");
  await tab(guest, 1).click();
  await expectPaneToShow(guest, 1, "typed by host");
});

test("タブを閉じるとターミナルが終了し、そのタブを見ていた参加者には隣のタブが出る", async ({ browser }, testInfo) => {
  // 偽のシェルが、起動するたびにプロセス ID を書き足す
  const pidFile = testInfo.outputPath("pids");
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/pid-shell", E2E_PID_FILE: pidFile });
  const host = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await openNewTab(host);
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await openNewTab(host);
  await expectPaneToShow(host, 3, "Fake Shell ready");
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(guest, 1, "Fake Shell ready");
  await tab(guest, 2).click();
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  const pids = async () => (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  await expect.poll(async () => (await pids()).length).toBe(3);
  const [shell1, shell2, shell3] = await pids();

  // host は別のタブ（ターミナル 3）を見たまま、guest が見ているターミナル 2 を閉じる
  await sidebar(host).getByRole("button", { name: "ターミナル 2 を閉じる" }).click();

  await expect(sidebar(host).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 3/]);
  await expect(sidebar(guest).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 3/]);
  await expect.poll(() => isAlive(shell2!)).toBe(false);
  expect(isAlive(shell1!)).toBe(true);
  expect(isAlive(shell3!)).toBe(true);
  // 閉じたタブの右隣が出る。host の表示は変わらない
  await expectPaneToShow(guest, 3, "Fake Shell ready");
  await expect(tab(guest, 3)).toHaveAttribute("aria-selected", "true");
  await expect(pane(host, 3)).toBeVisible();
  // 閉じたターミナルにはつなげない
  expect(await connectTo(host, 2)).toBe("error");
  expect(await connectTo(host, 1)).toBe("open");

  // 右隣がなければ、左隣が出る
  await sidebar(host).getByRole("button", { name: "ターミナル 3 を閉じる" }).click();
  await expectPaneToShow(guest, 1, "Fake Shell ready");
  await expectPaneToShow(host, 1, "Fake Shell ready");
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ブラウザからターミナルの入出力の WebSocket につないでみる
function connectTo(page: Page, terminal: number) {
  return page.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/terminals/${id}`);
        socket.onopen = () => {
          socket.close();
          resolve("open");
        };
        socket.onerror = () => resolve("error");
      }),
    terminal,
  );
}

test("最後のタブは閉じられない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await expect(sidebar(page).getByRole("button", { name: "ターミナル 1 を閉じる" })).toBeDisabled();
  await expect(pane(page, 1).getByRole("button", { name: "閉じる" })).toBeDisabled();

  await openNewTab(page);
  await expect(sidebar(page).getByRole("button", { name: "ターミナル 1 を閉じる" })).toBeEnabled();
  await expect(pane(page, 2).getByRole("button", { name: "閉じる" })).toBeEnabled();
});

test("タブのシェルを終了すると、そのタブが閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await exitShell(page, 2);

  await expect(sidebar(page).getByRole("tab")).toHaveText([/ターミナル 1/]);
  await expectPaneToShow(page, 1, "Fake Shell ready");
});

test("最後のタブのシェルを終了しても、タブとターミナルは残る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await exitShell(page, 1);

  // シェルが終了したことを画面から知る手がかりがないので、少し待ってから残っていることを確かめる
  await page.waitForTimeout(500);
  await expect(sidebar(page).getByRole("tab")).toHaveText([/ターミナル 1/]);
  await expect(panes(page)).toHaveCount(1);
});

test("途中から参加した人には、タブの並びと、起動時のコマンドのタブが、参加前の画面とともに出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await typeInPane(host, 1, "before guest joins\n");
  await openNewTab(host);
  await expectPaneToShow(host, 2, "Fake Shell ready");

  const guest = await openAsParticipant(browser, accompany.url);

  await expect(sidebar(guest).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await expect(tab(guest, 1)).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(guest, 1, "before guest joins");
});

test("サイドメニューを隠している間は、ツールバーにタブが並び、そこからも選んだり新しいタブを開いたりできる", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  // サイドメニューを出している間は、同じ一覧をツールバーに二重に出さない
  await expect(toolbar(page).getByRole("tab")).toHaveCount(0);

  await page.getByRole("button", { name: "サイドメニュー", exact: true }).click();
  await expect(sidebar(page)).toBeHidden();
  await expect(toolbar(page).getByRole("tab")).toHaveText([/ターミナル 1/]);

  await toolbar(page).getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(toolbar(page).getByRole("tab")).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");

  await tab(page, 1).click();
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect(panes(page)).toHaveCount(1);

  // ツールバーのタブにも、閉じるのボタンがある。並べるのは右クリックのメニューで行う（docs/adr/215-split-view.md）
  await expect(toolbar(page).getByRole("button", { name: "ターミナル 2 を並べて表示" })).toHaveCount(0);
  await tab(page, 2).click({ button: "right" });
  await page.getByRole("menu", { name: "ターミナル 2 のタブのメニュー" }).getByRole("menuitem", { name: "現在のタブと新しい分割表示" }).click();
  await expect(panes(page)).toHaveCount(2);
  await tab(page, 2).click({ button: "right" });
  await page.getByRole("menu", { name: "ターミナル 2 のタブのメニュー" }).getByRole("menuitem", { name: "分割を解除" }).click();
  await expect(panes(page)).toHaveCount(1);
  await toolbar(page).getByRole("button", { name: "ターミナル 2 を閉じる" }).click();
  await expect(toolbar(page).getByRole("tab")).toHaveText([/ターミナル 1/]);
  await expect(toolbar(page).getByRole("button", { name: "ターミナル 1 を閉じる" })).toBeDisabled();
});

test("タブを切り替えても、切り替えた先でターミナルにフォーカスしている人の表示が出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expectPaneToShow(guest, 1, "Fake Shell ready");

  await openNewTab(host);
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await tab(guest, 2).click();
  await expectPaneToShow(guest, 2, "Fake Shell ready");

  // 先に開いた host が参加者 1、あとから開いた guest が参加者 2
  const badge = (page: Page, n: number, name: string) =>
    pane(page, n).getByRole("status").getByText(name, { exact: true });
  await expect(badge(host, 2, "あなた")).toBeVisible();
  await expect(badge(host, 2, "参加者 2")).toBeVisible();
  await expect(badge(guest, 2, "参加者 1")).toBeVisible();
  await expect(pane(host, 2)).toHaveAttribute("data-focused", "true");

  // ターミナル 1 に戻っても、フォーカスしている人の表示が出る
  await tab(guest, 1).click();
  await tab(host, 1).click();
  await expect(badge(host, 1, "あなた")).toBeVisible();
  await expect(badge(host, 1, "参加者 2")).toBeVisible();
  await expect(badge(guest, 1, "あなた")).toBeVisible();
  await expect(badge(guest, 1, "参加者 1")).toBeVisible();
});

test("新しいタブのターミナルも、そのタブを見ている参加者のうち一番小さい画面に合わせた大きさになる", async ({ browser }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/size-shell" });
  const large = { width: 1280, height: 720 };
  const host = await openAsParticipant(browser, accompany.url, large);
  const small = { width: 640, height: 400 };
  const guest = await openAsParticipant(browser, accompany.url, small);
  await expectPaneToShow(host, 1, "size:");

  await openNewTab(host);
  await expectPaneToShow(host, 2, "size:");
  await tab(guest, 2).click();

  // コマンドから見えている端末のサイズ（最後に表示したもの）が 2 人で同じになり、小さい画面に収まる
  const size = async (page: Page) => {
    const text = (await pane(page, 2).locator(".xterm-rows").textContent()) ?? "";
    return [...text.matchAll(/size: (\d+)x(\d+)/g)].at(-1)?.slice(1).join("x") ?? "";
  };
  await expect.poll(() => size(guest)).not.toMatch(/^(80x24)?$/);
  await expect.poll(async () => (await size(host)) === (await size(guest))).toBe(true);
  const guestBox = (await pane(guest, 2).locator(".xterm-screen").boundingBox())!;
  expect(guestBox.x + guestBox.width).toBeLessThanOrEqual(small.width);
  expect(guestBox.y + guestBox.height).toBeLessThanOrEqual(small.height);
  // 画面の大きい人は、端末の周りが余白になる
  const hostBox = (await pane(host, 2).locator(".xterm-screen").boundingBox())!;
  expect(hostBox.width).toBeLessThan(small.width);
});
