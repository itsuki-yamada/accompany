import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { addToView, expectPaneToShow, pane, panes, tab } from "./panes";

// タブの並び順は参加者全員で共有し、サーバーが持つ（docs/adr/139-tab-order.md）。
// 新しいタブは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;
let stateDir: string;

test.beforeEach(() => {
  stateDir = newStateDir();
});

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  await rm(join(stateDir, ".."), { recursive: true, force: true });
});

// 再起動をまたいで同じ保存先を使う
function start() {
  return startAccompany([], { ...fakeShell, ACCOMPANY_STATE_DIR: stateDir });
}

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" });
}

function toolbar(page: Page) {
  return page.getByRole("navigation", { name: "ツールバー" });
}

function sidebarToggle(page: Page) {
  return page.getByRole("button", { name: "サイドメニュー", exact: true });
}

// サイドメニュー・ツールバーのタブの並び（名前）
function sidebarTabs(page: Page) {
  return sidebar(page).getByRole("tab");
}

function toolbarTabs(page: Page) {
  return toolbar(page).getByRole("tab");
}

function names(...ns: number[]) {
  return ns.map((n) => new RegExp(`ターミナル ${n}`));
}

// ターミナル 2・3 を開き、ターミナル 1 だけを表示した状態にする
async function openThreeTabs(page: Page) {
  for (const n of [2, 3]) {
    await page.getByRole("button", { name: "新しいタブ" }).first().click();
    await expectPaneToShow(page, n, "Fake Shell ready");
  }
  await tab(page, 1).click();
  await expect(pane(page, 1)).toBeVisible();
}

// from のタブを、to のタブの前（before）・後ろ（after）の位置までマウスでドラッグする。
// 手を離す前に、ドロップする位置の表示が出ていることを確かめる
async function dragTab(page: Page, from: Locator, to: Locator, place: "before" | "after", vertical: boolean) {
  const source = (await from.boundingBox())!;
  const target = (await to.boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  const [x, y] = vertical
    ? [target.x + target.width / 2, target.y + target.height * (place === "before" ? 0.2 : 0.8)]
    : [target.x + target.width * (place === "before" ? 0.2 : 0.8), target.y + target.height / 2];
  await page.mouse.move(x, y, { steps: 10 });
  await expect(page.locator(`[data-drop="${place}"]`)).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator("[data-drop]")).toHaveCount(0);
}

// タブの行（サイドメニュー）・項目（ツールバー）。タブのボタンと、並べて表示・閉じるのボタンを含む
function sidebarRow(page: Page, n: number) {
  return sidebar(page).locator(".tab-row").filter({ has: tab(page, n) });
}

function toolbarItem(page: Page, n: number) {
  return toolbar(page).locator(".toolbar-tab-item").filter({ has: tab(page, n) });
}

test("サイドメニューのタブをドラッグすると、ドロップする位置が出て、並び順が変わり、全員の一覧に反映される", async ({
  browser,
}) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(host);
  const guest = await openAsParticipant(browser, accompany.url);
  await expect(sidebarTabs(guest)).toHaveText(names(1, 2, 3));

  // ターミナル 3 を、ターミナル 1 の前に移す
  await dragTab(host, sidebarRow(host, 3), sidebarRow(host, 1), "before", true);
  await expect(sidebarTabs(host)).toHaveText(names(3, 1, 2));
  await expect(sidebarTabs(guest)).toHaveText(names(3, 1, 2));

  // ターミナル 3 を、ターミナル 2 の後ろ（最後）に移す
  await dragTab(host, sidebarRow(host, 3), sidebarRow(host, 2), "after", true);
  await expect(sidebarTabs(host)).toHaveText(names(1, 2, 3));
  await expect(sidebarTabs(guest)).toHaveText(names(1, 2, 3));

  // サイドメニューを隠しているほかの参加者のツールバーにも反映される
  await sidebarToggle(guest).click();
  await dragTab(host, sidebarRow(host, 1), sidebarRow(host, 2), "after", true);
  await expect(toolbarTabs(guest)).toHaveText(names(2, 1, 3));

  // 並べ替えても、それぞれの表示（選んでいるタブ）は変わらない
  await expect(panes(host)).toHaveCount(1);
  await expect(pane(host, 1)).toBeVisible();
  await expect(tab(host, 1)).toHaveAttribute("aria-selected", "true");
  await expect(pane(guest, 1)).toBeVisible();
});

test("サイドメニューを隠している間は、ツールバーのタブをドラッグして並び順を変えられる", async ({ browser }) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(host);
  const guest = await openAsParticipant(browser, accompany.url);
  await sidebarToggle(host).click();
  await expect(toolbarTabs(host)).toHaveText(names(1, 2, 3));

  await dragTab(host, toolbarItem(host, 1), toolbarItem(host, 3), "after", false);
  await expect(toolbarTabs(host)).toHaveText(names(2, 3, 1));
  await expect(sidebarTabs(guest)).toHaveText(names(2, 3, 1));

  await dragTab(host, toolbarItem(host, 3), toolbarItem(host, 2), "before", false);
  await expect(toolbarTabs(host)).toHaveText(names(3, 2, 1));
  await expect(sidebarTabs(guest)).toHaveText(names(3, 2, 1));
});

test("キーボード（Alt+矢印）でも、選んでいるタブを前・後ろへ移せ、移したタブにフォーカスが残る", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);

  // サイドメニューは縦に並ぶので ↑↓
  await tab(page, 1).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(sidebarTabs(page)).toHaveText(names(2, 1, 3));
  await expect(tab(page, 1)).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(sidebarTabs(page)).toHaveText(names(2, 3, 1));
  // 端ではそれ以上動かない
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(300);
  await expect(sidebarTabs(page)).toHaveText(names(2, 3, 1));
  await page.keyboard.press("Alt+ArrowUp");
  await expect(sidebarTabs(page)).toHaveText(names(2, 1, 3));
  await expect(tab(page, 1)).toBeFocused();

  // ツールバーは横に並ぶので ←→
  await sidebarToggle(page).click();
  await tab(page, 3).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(toolbarTabs(page)).toHaveText(names(2, 3, 1));
  await expect(tab(page, 3)).toBeFocused();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(toolbarTabs(page)).toHaveText(names(2, 1, 3));

  // 並べ替えのキーは、ショートカットの一覧に載る
  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toContainText("タブを前・後ろへ移す");
  await expect(list).toContainText("Option+↑↓ / ←→");
  await expect(list).toContainText("Alt+↑↓ / ←→");
});

test("タブの右クリックのメニューから、前・後ろへ移せる。端のタブでは、その向きへは移せない", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);
  const menu = page.getByRole("menu", { name: "ターミナル 1 のタブのメニュー" });

  await tab(page, 1).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "上へ移す" })).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: "下へ移す" }).click();
  await expect(sidebarTabs(page)).toHaveText(names(2, 1, 3));
  await expect(menu).toHaveCount(0);

  await tab(page, 1).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "上へ移す" }).click();
  await expect(sidebarTabs(page)).toHaveText(names(1, 2, 3));

  // ツールバーのタブでは、左・右へ移す
  await sidebarToggle(page).click();
  await tab(page, 1).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "左へ移す" })).toHaveAttribute("aria-disabled", "true");
  await menu.getByRole("menuitem", { name: "右へ移す" }).click();
  await expect(toolbarTabs(page)).toHaveText(names(2, 1, 3));
});

test("並び順を変えても、参加者ごとの表示とペアプロモードの追従は変わらず、次・前のタブへ移るショートカットは新しい並びに従う", async ({
  browser,
}) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(host);
  // host はターミナル 1 と 3 を並べている
  await addToView(host, 3);
  const guest = await openAsParticipant(browser, accompany.url);
  await guest.getByRole("button", { name: "参加者 1 とペアプロ" }).first().click();
  await expect(panes(guest)).toHaveCount(2);
  const following = guest.getByRole("status", { name: "ペアプロモード" });
  await expect(following).toBeVisible();

  // 追従している側が並び順を変えても、ペアプロモードは続き、表示も変わらない
  await tab(guest, 2).focus();
  await guest.keyboard.press("Alt+ArrowUp");
  await expect(sidebarTabs(host)).toHaveText(names(2, 1, 3));
  await expect(following).toBeVisible();
  await expect(panes(guest)).toHaveCount(2);
  await expect(panes(host)).toHaveCount(2);
  for (const page of [host, guest]) {
    await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, 2)).toHaveAttribute("aria-selected", "false");
    await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  }

  // 次・前のタブは、新しい並び（2, 1, 3）に従う
  await pane(host, 1).locator(".xterm-helper-textarea").focus();
  await host.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(panes(host)).toHaveCount(1);
  await expect(pane(host, 3)).toBeVisible();
  await host.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(pane(host, 2)).toBeVisible();
  await host.keyboard.press("ControlOrMeta+Shift+Comma");
  await expect(pane(host, 3)).toBeVisible();
  await host.keyboard.press("ControlOrMeta+Shift+Comma");
  await expect(pane(host, 1)).toBeVisible();
});

test("並び順は保存され、起動し直しても残る", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);
  await tab(page, 3).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(sidebarTabs(page)).toHaveText(names(3, 1, 2));
  await accompany.stop();

  accompany = await start();
  const restarted = await openAsParticipant(browser, accompany.url);
  await expect(sidebarTabs(restarted)).toHaveText(names(3, 1, 2));
  // 新しいタブは最後に並ぶ
  await restarted.getByRole("button", { name: "新しいタブ" }).first().click();
  await expectPaneToShow(restarted, 4, "Fake Shell ready");
  await expect(sidebarTabs(restarted)).toHaveText(names(3, 1, 2, 4));
});

test("ないタブや範囲外の位置への並べ替えが直接届いても、並び順は変わらない", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openThreeTabs(page);

  // 改造したブラウザなどから、配置の WebSocket に直接送る
  const sendRaw = (messages: object[]) =>
    page.evaluate(
      (messages) =>
        new Promise<void>((resolve) => {
          const socket = new WebSocket(`ws://${location.host}/ws/workspace`);
          socket.onopen = () => {
            for (const message of messages) socket.send(JSON.stringify(message));
            setTimeout(() => {
              socket.close();
              resolve();
            }, 200);
          };
        }),
      messages,
    );
  await sendRaw([
    { type: "move-tab", tab: "9", index: 0 },
    { type: "move-tab", tab: "3", index: 3 },
    { type: "move-tab", tab: "3", index: -1 },
    { type: "move-tab", tab: "3", index: 0.5 },
    { type: "move-tab", tab: "3", index: "0" },
    { type: "move-tab", tab: "3", index: 1e100 },
    { type: "move-tab", tab: 3, index: 0 },
    { type: "move-tab", index: 0 },
  ]);
  await page.waitForTimeout(300);
  await expect(sidebarTabs(page)).toHaveText(names(1, 2, 3));

  // 正しいものは受け付ける
  await sendRaw([{ type: "move-tab", tab: "3", index: 0 }]);
  await expect(sidebarTabs(page)).toHaveText(names(3, 1, 2));
});
