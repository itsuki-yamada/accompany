import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, panes, tab } from "./panes";

// タブのグループ。名前と色の付いたラベルの右（サイドメニューでは下）に、グループのタブを並べる。
// グループは全員で共有し、サーバーが持って保存する（docs/adr/209-tab-groups.md）。
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

// ターミナル 2〜count を開き、ターミナル 1 だけを表示した状態にする
async function openTabs(page: Page, count: number) {
  for (let n = 2; n <= count; n++) {
    await page.getByRole("button", { name: "新しいタブ" }).first().click();
    await expectPaneToShow(page, n, "Fake Shell ready");
  }
  await tab(page, 1).click();
  await expect(pane(page, 1)).toBeVisible();
}

// グループのラベル
function label(page: Page, name: string) {
  return page.getByRole("button", { name: `${name} のグループ`, exact: true });
}

function labels(page: Page) {
  return page.locator(".group-label:visible");
}

// 一覧（サイドメニューかツールバー）の並び。ラベルは「[名前]」、グループのタブは「グループの名前 > タブの名前」
function entries(scope: Locator) {
  return scope.locator(".group-label, [role=tab]").evaluateAll((elements) => {
    const groups = new Map<string, string>();
    return elements.map((element) => {
      const group = (element as HTMLElement).dataset.group;
      if (element.classList.contains("group-label")) {
        groups.set(group!, element.textContent ?? "");
        return `[${element.textContent}]`;
      }
      const name = element.getAttribute("aria-label");
      return group ? `${groups.get(group)} > ${name}` : name;
    });
  });
}

function expectEntries(scope: Locator, expected: string[]) {
  return expect.poll(() => entries(scope)).toEqual(expected);
}

function tabMenu(page: Page, n: number) {
  return page.getByRole("menu", { name: `ターミナル ${n} のタブのメニュー` });
}

function groupMenu(page: Page, name: string) {
  return page.getByRole("menu", { name: `${name} のグループのメニュー` });
}

function nameEditor(page: Page) {
  return page.getByRole("textbox", { name: "グループの名前" });
}

async function typeName(page: Page, name: string) {
  await expect(nameEditor(page)).toBeFocused();
  await nameEditor(page).fill(name);
  await nameEditor(page).press("Enter");
  await expect(nameEditor(page)).toHaveCount(0);
}

// タブを新しいグループに入れて、名前を付ける
async function newGroup(page: Page, n: number, name: string) {
  await tab(page, n).click({ button: "right" });
  await tabMenu(page, n).getByRole("menuitem", { name: "新しいグループに追加" }).click();
  await typeName(page, name);
}

async function addToGroup(page: Page, n: number, name: string) {
  await tab(page, n).click({ button: "right" });
  await tabMenu(page, n).getByRole("menuitem", { name: `グループ「${name}」に追加` }).click();
}

// from を、to の前（before）・後ろ（after）の位置までマウスでドラッグする。
// 手を離す前に、ドロップする位置の表示が出ていることを確かめる
async function drag(page: Page, from: Locator, to: Locator, place: "before" | "after", vertical: boolean) {
  const source = await boxOf(from);
  const target = await boxOf(to);
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

function sidebarRow(page: Page, n: number) {
  return sidebar(page).locator(".tab-row").filter({ has: tab(page, n) });
}

function toolbarItem(page: Page, n: number) {
  return toolbar(page).locator(".toolbar-tab-item").filter({ has: tab(page, n) });
}

test("タブの右クリックのメニューで、新しいグループを作って名前を付け、既存のグループに加え、グループから外せる。ほかの参加者の一覧にも出る", async ({
  browser,
}) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openTabs(host, 4);
  const guest = await openAsParticipant(browser, accompany.url);
  // guest はサイドメニューを隠して、ツールバーのタブで見る
  await sidebarToggle(guest).click();

  // グループに入っていないタブのメニューには、「グループから外す」は出ない
  await tab(host, 2).click({ button: "right" });
  await expect(tabMenu(host, 2).getByRole("menuitem", { name: "グループから外す" })).toHaveCount(0);
  await host.keyboard.press("Escape");

  // 新しいグループを作ると、ラベルの名前の入力欄が出る
  await newGroup(host, 2, "app");
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 2", "ターミナル 3", "ターミナル 4"]);
  await expectEntries(toolbar(guest), ["ターミナル 1", "[app]", "app > ターミナル 2", "ターミナル 3", "ターミナル 4"]);
  // 色が付いている。ほかの参加者にも同じ色で出る
  const color = await label(host, "app").getAttribute("data-color");
  expect(color).toBeTruthy();
  await expect(label(guest, "app")).toHaveAttribute("data-color", color!);

  // 既存のグループに加えると、グループの最後に並ぶ
  await addToGroup(host, 4, "app");
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 4", "ターミナル 3"]);
  await expectEntries(toolbar(guest), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 4", "ターミナル 3"]);

  // グループから外すと、グループのすぐ後ろに出る
  await tab(host, 2).click({ button: "right" });
  await tabMenu(host, 2).getByRole("menuitem", { name: "グループから外す" }).click();
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 4", "ターミナル 2", "ターミナル 3"]);
  await expectEntries(toolbar(guest), ["ターミナル 1", "[app]", "app > ターミナル 4", "ターミナル 2", "ターミナル 3"]);

  // ツールバーのタブのメニューからも、2 つ目のグループを作れる。グループごとに色が違う
  await newGroup(guest, 3, "e2e");
  await expectEntries(toolbar(guest), ["ターミナル 1", "[app]", "app > ターミナル 4", "ターミナル 2", "[e2e]", "e2e > ターミナル 3"]);
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 4", "ターミナル 2", "[e2e]", "e2e > ターミナル 3"]);
  await expect(label(host, "e2e")).not.toHaveAttribute("data-color", color!);

  // グループにまとめても、それぞれの表示（選んでいるタブ）は変わらない
  await expect(panes(host)).toHaveCount(1);
  await expect(pane(host, 1)).toBeVisible();
  await expect(panes(guest)).toHaveCount(1);
  await expect(pane(guest, 1)).toBeVisible();
});

test("グループの端のタブをメニューで前・後ろへ移すとグループから外れ、グループの外のタブはグループを飛び越える", async ({
  browser,
}) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);
  await newGroup(page, 2, "app");
  await addToGroup(page, 3, "app");
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 3", "ターミナル 4"]);

  const move = async (n: number, item: string) => {
    await tab(page, n).click({ button: "right" });
    await tabMenu(page, n).getByRole("menuitem", { name: item }).click();
  };
  // グループの中では、並びが入れ替わる
  await move(2, "下へ移す");
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 3", "app > ターミナル 2", "ターミナル 4"]);
  // グループの最後のタブを後ろへ移すと、その場でグループから外れる
  await move(2, "下へ移す");
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 3", "ターミナル 2", "ターミナル 4"]);
  // グループの外のタブを、グループの方へ移すと、グループを飛び越える
  await move(2, "上へ移す");
  await expectEntries(sidebar(page), ["ターミナル 1", "ターミナル 2", "[app]", "app > ターミナル 3", "ターミナル 4"]);
  await move(1, "下へ移す");
  await move(4, "上へ移す");
  await expectEntries(sidebar(page), ["ターミナル 2", "ターミナル 1", "ターミナル 4", "[app]", "app > ターミナル 3"]);

  // 最後でも、グループのタブは後ろへ移せる（その場でグループから外れ、タブがなくなったグループは消える）
  await move(3, "下へ移す");
  await expectEntries(sidebar(page), ["ターミナル 2", "ターミナル 1", "ターミナル 4", "ターミナル 3"]);
  await expect(labels(page)).toHaveCount(0);
  // グループに入っていない最後のタブは、後ろへ移せない
  await tab(page, 3).click({ button: "right" });
  await expect(tabMenu(page, 3).getByRole("menuitem", { name: "下へ移す" })).toHaveAttribute("aria-disabled", "true");
});

test("タブをドラッグしてグループに出し入れでき、ラベルをドラッグするとグループごと移る", async ({ browser }) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openTabs(host, 4);
  const guest = await openAsParticipant(browser, accompany.url);
  await newGroup(host, 2, "app");
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 2", "ターミナル 3", "ターミナル 4"]);

  // グループのタブに重ねると、そのグループに入る
  await drag(host, sidebarRow(host, 3), sidebarRow(host, 2), "before", true);
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 3", "app > ターミナル 2", "ターミナル 4"]);
  await expectEntries(sidebar(guest), ["ターミナル 1", "[app]", "app > ターミナル 3", "app > ターミナル 2", "ターミナル 4"]);

  // グループに入っていないタブに重ねると、グループから外れる
  await drag(host, sidebarRow(host, 3), sidebarRow(host, 4), "after", true);
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 2", "ターミナル 4", "ターミナル 3"]);

  // ラベルの後半に重ねると、グループの先頭に入る
  await drag(host, sidebarRow(host, 1), label(host, "app"), "after", true);
  await expectEntries(sidebar(host), ["[app]", "app > ターミナル 1", "app > ターミナル 2", "ターミナル 4", "ターミナル 3"]);

  // ラベルをドラッグすると、グループのタブがまとめて移る
  await drag(host, label(host, "app"), sidebarRow(host, 3), "after", true);
  await expectEntries(sidebar(host), ["ターミナル 4", "ターミナル 3", "[app]", "app > ターミナル 1", "app > ターミナル 2"]);
  await expectEntries(sidebar(guest), ["ターミナル 4", "ターミナル 3", "[app]", "app > ターミナル 1", "app > ターミナル 2"]);

  // サイドメニューを隠している間は、ツールバーのラベル・タブをドラッグする
  await sidebarToggle(host).click();
  await drag(host, label(host, "app"), toolbarItem(host, 4), "before", false);
  await expectEntries(toolbar(host), ["[app]", "app > ターミナル 1", "app > ターミナル 2", "ターミナル 4", "ターミナル 3"]);
  // ラベルの前半に重ねると、グループの前に出る
  await drag(host, toolbarItem(host, 2), label(host, "app"), "before", false);
  await expectEntries(toolbar(host), ["ターミナル 2", "[app]", "app > ターミナル 1", "ターミナル 4", "ターミナル 3"]);
  await expectEntries(sidebar(guest), ["ターミナル 2", "[app]", "app > ターミナル 1", "ターミナル 4", "ターミナル 3"]);
});

test("ラベルの右クリックのメニューで、名前と色を変え、グループを解除し、グループのタブをまとめて閉じられる", async ({
  browser,
}) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openTabs(host, 4);
  const guest = await openAsParticipant(browser, accompany.url);
  await newGroup(host, 2, "app");
  await addToGroup(host, 3, "app");

  // 名前を変える（ラベルのダブルクリックでも変えられる）
  await label(host, "app").click({ button: "right" });
  await groupMenu(host, "app").getByRole("menuitem", { name: "名前を変更…" }).click();
  await typeName(host, "web");
  await expect(label(guest, "web")).toBeVisible();
  await label(host, "web").dblclick();
  await typeName(host, "api");
  await expectEntries(sidebar(guest), ["ターミナル 1", "[api]", "api > ターミナル 2", "api > ターミナル 3", "ターミナル 4"]);

  // 色を変える。いまの色に印が付いている
  await label(host, "api").click({ button: "right" });
  const colors = groupMenu(host, "api").getByRole("menuitemradio");
  await expect(colors).toHaveCount(8);
  await expect(groupMenu(host, "api").getByRole("menuitemradio", { checked: true })).toHaveCount(1);
  await groupMenu(host, "api").getByRole("menuitemradio", { name: "赤" }).click();
  await expect(label(host, "api")).toHaveAttribute("data-color", "red");
  await expect(label(guest, "api")).toHaveAttribute("data-color", "red");
  await label(host, "api").click({ button: "right" });
  await expect(groupMenu(host, "api").getByRole("menuitemradio", { name: "赤" })).toHaveAttribute("aria-checked", "true");
  await host.keyboard.press("Escape");

  // グループを解除すると、ラベルがなくなり、タブはその場に残る
  await label(host, "api").click({ button: "right" });
  await groupMenu(host, "api").getByRole("menuitem", { name: "グループを解除" }).click();
  await expectEntries(sidebar(host), ["ターミナル 1", "ターミナル 2", "ターミナル 3", "ターミナル 4"]);
  await expectEntries(sidebar(guest), ["ターミナル 1", "ターミナル 2", "ターミナル 3", "ターミナル 4"]);

  // グループのタブをまとめて閉じる。表示していたタブを閉じた参加者には、隣のタブが出る
  await newGroup(host, 2, "tmp");
  await addToGroup(host, 3, "tmp");
  await tab(guest, 2).click();
  await expect(pane(guest, 2)).toBeVisible();
  await label(host, "tmp").click({ button: "right" });
  await groupMenu(host, "tmp").getByRole("menuitem", { name: "グループのタブを閉じる" }).click();
  await expectEntries(sidebar(host), ["ターミナル 1", "ターミナル 4"]);
  await expectEntries(sidebar(guest), ["ターミナル 1", "ターミナル 4"]);
  await expect(labels(host)).toHaveCount(0);
  await expect(pane(guest, 4)).toBeVisible();

  // すべてのタブが入ったグループは、まとめて閉じられない（最後のタブは閉じない）
  await newGroup(host, 1, "all");
  await addToGroup(host, 4, "all");
  await label(host, "all").click({ button: "right" });
  await expect(groupMenu(host, "all").getByRole("menuitem", { name: "グループのタブを閉じる" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("グループのタブをすべて閉じると、グループもなくなる", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 3);
  await newGroup(page, 2, "app");
  await addToGroup(page, 3, "app");
  await expect(label(page, "app")).toBeVisible();

  await page.getByRole("button", { name: "ターミナル 2 を閉じる" }).click();
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 3"]);
  await page.getByRole("button", { name: "ターミナル 3 を閉じる" }).click();
  await expectEntries(sidebar(page), ["ターミナル 1"]);
  await expect(labels(page)).toHaveCount(0);
});

test("グループは保存され、起動し直しても名前・色・タブ・並びが残る", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);
  await newGroup(page, 3, "app");
  await addToGroup(page, 1, "app");
  await label(page, "app").click({ button: "right" });
  await groupMenu(page, "app").getByRole("menuitemradio", { name: "緑" }).click();
  await newGroup(page, 4, "e2e");
  const expected = ["ターミナル 2", "[app]", "app > ターミナル 3", "app > ターミナル 1", "[e2e]", "e2e > ターミナル 4"];
  await expectEntries(sidebar(page), expected);
  await expect(label(page, "app")).toHaveAttribute("data-color", "green");
  const e2eColor = (await label(page, "e2e").getAttribute("data-color"))!;
  await accompany.stop();

  accompany = await start();
  const restarted = await openAsParticipant(browser, accompany.url);
  await expectEntries(sidebar(restarted), expected);
  await expect(label(restarted, "app")).toHaveAttribute("data-color", "green");
  await expect(label(restarted, "e2e")).toHaveAttribute("data-color", e2eColor);
  // 戻したあとも、新しいグループを作れる（戻したグループと混ざらない）
  await newGroup(restarted, 2, "docs");
  await expectEntries(sidebar(restarted), ["[docs]", "docs > ターミナル 2", ...expected.slice(1)]);
});

test("ないタブ・グループや、決まっていない色への操作が直接届いても、グループは変わらない", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 3);
  await newGroup(page, 2, "app");
  const group = (await label(page, "app").getAttribute("data-group"))!;
  const color = (await label(page, "app").getAttribute("data-color"))!;
  const expected = ["ターミナル 1", "[app]", "app > ターミナル 2", "ターミナル 3"];

  const sendRaw = (messages: object[]) => sendRawTo(page, messages);
  for (const message of [
    { type: "new-group", tab: "9" },
    { type: "new-group", tab: 1 },
    { type: "add-to-group", tab: "1", group: "99" },
    { type: "add-to-group", tab: "9", group },
    { type: "add-to-group", tab: "1", group: Number(group) },
    { type: "remove-from-group", tab: "1" },
    { type: "move-tab", tab: "3", index: 1, group: "99" },
    { type: "move-tab", tab: "3", index: 1, group: 1 },
    { type: "move-group", group, index: 3 },
    { type: "move-group", group, index: -1 },
    { type: "move-group", group, index: 0.5 },
    { type: "move-group", group: "99", index: 0 },
    { type: "recolor-group", group, color: "black" },
    { type: "recolor-group", group, color: "#ff0000" },
    { type: "recolor-group", group: "99", color: "red" },
    { type: "rename-group", group: "99", name: "x" },
    { type: "rename-group", group, name: 1 },
    { type: "ungroup", group: "99" },
    { type: "close-group", group: "99" },
  ]) {
    await sendRaw([message]);
    await page.waitForTimeout(100);
    await expectEntries(sidebar(page), expected);
    await expect(label(page, "app"), JSON.stringify(message)).toHaveAttribute("data-color", color);
  }

  // 正しいものは受け付ける
  await sendRaw([{ type: "add-to-group", tab: "3", group }]);
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 3"]);
});

test("グループの途中へ、グループに入っていないタブを移す並べ替えが届いても、そのタブはグループの後ろに出る", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 5);
  await newGroup(page, 2, "app");
  await addToGroup(page, 3, "app");
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 3", "ターミナル 4", "ターミナル 5"]);

  // 古い並びを見ているブラウザなどから、グループ（2, 3）の途中への並べ替えが届く。グループは分かれず、タブはグループの後ろに出る
  await sendRawTo(page, [{ type: "move-tab", tab: "5", index: 2 }]);
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 3", "ターミナル 5", "ターミナル 4"]);
  await expect(labels(page)).toHaveCount(1);
});

test("グループに入れる並べ替えが古い並びから届いても、位置はそのグループの範囲に収め、グループは動かない", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);
  await newGroup(page, 2, "app");
  await addToGroup(page, 3, "app");
  const group = (await label(page, "app").getAttribute("data-group"))!;
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 2", "app > ターミナル 3", "ターミナル 4"]);

  // グループの外（先頭）の位置で、グループに入れる
  await sendRawTo(page, [{ type: "move-tab", tab: "4", index: 0, group }]);
  await expectEntries(sidebar(page), ["ターミナル 1", "[app]", "app > ターミナル 4", "app > ターミナル 2", "app > ターミナル 3"]);
  // グループの外（最後）の位置で、グループに入れる
  await sendRawTo(page, [{ type: "remove-from-group", tab: "4" }]);
  await sendRawTo(page, [{ type: "move-tab", tab: "1", index: 3, group }]);
  await expectEntries(sidebar(page), ["[app]", "app > ターミナル 2", "app > ターミナル 3", "app > ターミナル 1", "ターミナル 4"]);
});

test("新しいグループを作る操作がサーバーに届かなかったときは、あとでほかの参加者が作ったグループに名前の入力欄を出さない", async ({
  browser,
}) => {
  accompany = await start();
  const guest = await openAsParticipant(browser, accompany.url);
  await openTabs(guest, 3);
  // host の「新しいグループを作る」だけを、サーバーに届けない
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  const host = await context.newPage();
  await host.routeWebSocket(/\/ws\/workspace$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (JSON.parse(message.toString()).type !== "new-group") server.send(message);
    });
  });
  await host.goto(accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");

  await tab(host, 2).click({ button: "right" });
  await tabMenu(host, 2).getByRole("menuitem", { name: "新しいグループに追加" }).click();
  // ほかの変更（タブの名前）が届く
  await sendRawTo(guest, [{ type: "rename-tab", tab: "3", name: "x" }]);
  await expect(host.getByRole("tab", { name: "x", exact: true })).toBeVisible();
  await expect(nameEditor(host)).toHaveCount(0);

  // あとで guest が同じタブを新しいグループに入れても、host には入力欄を出さない
  await newGroup(guest, 2, "app");
  await expectEntries(sidebar(host), ["ターミナル 1", "[app]", "app > ターミナル 2", "x"]);
  await expect(nameEditor(host)).toHaveCount(0);
});

test("一覧の空いている所に落とすと、タブ・グループは最後に移り、タブはグループから外れる", async ({ browser }) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openTabs(host, 4);
  const guest = await openAsParticipant(browser, accompany.url);
  await newGroup(host, 3, "app");
  await addToGroup(host, 4, "app");
  await expectEntries(sidebar(host), ["ターミナル 1", "ターミナル 2", "[app]", "app > ターミナル 3", "app > ターミナル 4"]);

  // サイドメニューの、タブの下の空いている所
  const list = await boxOf(sidebar(host));
  const below = { x: list.x + list.width / 2, y: list.y + list.height - 20 };
  await dragTo(host, sidebarRow(host, 3), below);
  await expectEntries(sidebar(host), ["ターミナル 1", "ターミナル 2", "[app]", "app > ターミナル 4", "ターミナル 3"]);
  await dragTo(host, label(host, "app"), below);
  await expectEntries(sidebar(host), ["ターミナル 1", "ターミナル 2", "ターミナル 3", "[app]", "app > ターミナル 4"]);
  await expectEntries(sidebar(guest), ["ターミナル 1", "ターミナル 2", "ターミナル 3", "[app]", "app > ターミナル 4"]);

  // ツールバーの、タブの右の空いている所
  await sidebarToggle(host).click();
  const strip = await boxOf(toolbar(host).locator(".toolbar-tabs"));
  const right = { x: strip.x + strip.width - 10, y: strip.y + strip.height / 2 };
  await dragTo(host, toolbarItem(host, 4), right);
  await expectEntries(toolbar(host), ["ターミナル 1", "ターミナル 2", "ターミナル 3", "ターミナル 4"]);
  await dragTo(host, toolbarItem(host, 1), right);
  await expectEntries(toolbar(host), ["ターミナル 2", "ターミナル 3", "ターミナル 4", "ターミナル 1"]);
  await expectEntries(sidebar(guest), ["ターミナル 2", "ターミナル 3", "ターミナル 4", "ターミナル 1"]);
});

test("グループの名前は、HTML のような文字列でもそのまま文字で出る", async ({ browser }) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  await openTabs(host, 3);
  const guest = await openAsParticipant(browser, accompany.url);
  // 名前は 32 文字までなので、それに収まる長さにする
  const name = "<img src onerror=pwned=1>";
  await newGroup(host, 2, name);
  for (const page of [host, guest]) {
    await expect(label(page, name)).toHaveText(name);
    await expect(sidebar(page).locator("img")).toHaveCount(0);
  }
  await tab(guest, 3).click({ button: "right" });
  await expect(tabMenu(guest, 3).getByRole("menuitem", { name: `グループ「${name}」に追加` })).toBeVisible();
  await expect(tabMenu(guest, 3).locator("img")).toHaveCount(0);
  await label(guest, name).click({ button: "right" });
  await expect(groupMenu(guest, name)).toBeVisible();
  for (const page of [host, guest]) expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
});

// 要素の位置と大きさ。一覧はほかの参加者の操作などで組み直され、測った瞬間に要素が入れ替わると null になるので、測れるまで待つ
async function boxOf(locator: Locator) {
  let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect.poll(async () => (box = await locator.boundingBox()) !== null).toBe(true);
  return box!;
}

// 改造したブラウザなどから、配置の WebSocket に直接送る
function sendRawTo(page: Page, messages: object[]) {
  return page.evaluate(
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
}

// from を、一覧の空いている所（point）までドラッグする。最後の要素の後ろに、移す位置の線が出る
async function dragTo(page: Page, from: Locator, point: { x: number; y: number }) {
  const source = await boxOf(from);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 10 });
  await expect(page.locator('[data-drop="after"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator("[data-drop]")).toHaveCount(0);
}
