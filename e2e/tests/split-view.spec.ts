import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { boxOf, expectFillsArea, expectPaneToShow, pane, panes, tab } from "./panes";

// 分割表示（Chrome の Split View と同じ考え方）。分割したタブはまとまりとして残り、分割の外のタブを見たあとに分割のタブを選ぶと、
// 分割（並び・向き・割合）がそのまま戻る。分割したタブは、タブの一覧で 1 つのタブの枠に名前を横に並べて出る
// （docs/adr/215-split-view.md）。分割や新しいタブで増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

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
  await expect(panes(page)).toHaveCount(1);
  await expect(pane(page, 1)).toBeVisible();
}

// 一覧（サイドメニューかツールバー）の項目。分割したタブは 1 つの項目に「ターミナル 1 | ターミナル 2」のように並ぶ
function entries(scope: Locator) {
  return scope.locator(".tab-row, .toolbar-tab-item").evaluateAll((elements) =>
    elements.map((element) =>
      [...element.querySelectorAll("[role=tab]")].map((t) => t.getAttribute("aria-label")).join(" | "),
    ),
  );
}

function expectEntries(scope: Locator, expected: string[]) {
  return expect.poll(() => entries(scope)).toEqual(expected);
}

function tabMenu(page: Page, n: number) {
  return page.getByRole("menu", { name: `ターミナル ${n} のタブのメニュー` });
}

// タブを右クリックして、メニューの項目を選ぶ
async function chooseInTabMenu(page: Page, n: number, item: string) {
  await tab(page, n).click({ button: "right" });
  await tabMenu(page, n).getByRole("menuitem", { name: item, exact: true }).click();
}

// a が b の左にあり、上端がそろっている
async function expectSideBySide(page: Page, a: number, b: number) {
  await expect.poll(async () => (await boxOf(page, b)).x - ((await boxOf(page, a)).x + (await boxOf(page, a)).width)).toBeGreaterThanOrEqual(-1);
  expect(Math.abs((await boxOf(page, a)).y - (await boxOf(page, b)).y)).toBeLessThan(2);
}

// a が b の上にあり、左端がそろっている
async function expectStacked(page: Page, a: number, b: number) {
  await expect.poll(async () => (await boxOf(page, b)).y - ((await boxOf(page, a)).y + (await boxOf(page, a)).height)).toBeGreaterThanOrEqual(-1);
  expect(Math.abs((await boxOf(page, a)).x - (await boxOf(page, b)).x)).toBeLessThan(2);
}

async function dragDivider(page: Page, x: number) {
  const divider = (await page.getByRole("separator").first().boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, divider.y + divider.height / 2, { steps: 5 });
  await page.mouse.up();
}

// タブを、ターミナルを並べる領域の端（左・右・下）までドラッグする。手を離す前に、分割表示を作る印（+）が出ていることを確かめる
async function dragTabToEdge(page: Page, n: number, edge: "left" | "right" | "bottom") {
  const source = (await tab(page, n).boundingBox())!;
  const area = (await page.getByRole("main").boundingBox())!;
  const [x, y] = {
    left: [area.x + 10, area.y + area.height / 2],
    right: [area.x + area.width - 10, area.y + area.height / 2],
    bottom: [area.x + area.width / 2, area.y + area.height - 10],
  }[edge];
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(x!, y!, { steps: 10 });
  // Playwright では、最後に動かした位置の dragover が次のマウスの操作まで届かないことがあるので、もう少しだけ動かす
  await page.mouse.move(x! + (edge === "left" ? 2 : -2), y! - 2);
  const zone = page.getByRole("region", { name: "分割表示を作る" });
  await expect(zone).toBeVisible();
  await expect(zone).toHaveAttribute("data-edge", edge);
  await expect(zone).toContainText("+");
  await page.screenshot({ path: test.info().outputPath(`split-view-drop-${edge}.png`) });
  await page.mouse.up();
  await expect(zone).toBeHidden();
}

test("分割の外のタブを選ぶとそのタブだけを表示し、分割のタブを選ぶと分割（並び・割合）がそのまま戻る。分割の中のタブを選ぶと、分割のままそちらにフォーカスする", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await page.getByRole("button", { name: "新しいタブ" }).first().click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expectFillsArea(page, 3);
  await tab(page, 1).click();
  await expect(panes(page)).toHaveCount(2);
  const area = (await page.getByRole("main").boundingBox())!;
  await dragDivider(page, area.x + area.width * 0.3);
  await expect.poll(async () => (await boxOf(page, 1)).width / area.width).toBeLessThan(0.35);

  // 分割の外のタブを選ぶと、そのタブだけを表示する
  await tab(page, 3).click();
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 3);

  // 分割のタブ（右の 2）を選ぶと、並び・割合がそのまま戻り、選んだ側にフォーカスする
  await tab(page, 2).click();
  await expect(panes(page)).toHaveCount(2);
  await expectSideBySide(page, 1, 2);
  await expect.poll(async () => (await boxOf(page, 1)).width / area.width).toBeLessThan(0.35);
  await expect(pane(page, 2).locator(".xterm-helper-textarea")).toBeFocused();

  // 分割の中のもう一方を選ぶと、分割のままそちらにフォーカスする
  await tab(page, 1).click();
  await expect(pane(page, 1).locator(".xterm-helper-textarea")).toBeFocused();
  await page.waitForTimeout(300);
  await expect(panes(page)).toHaveCount(2);
  for (const n of [1, 2]) await expect(tab(page, n)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "false");
});

test("分割したタブは、サイドメニューとツールバーで 1 つのタブの枠に名前を横に並べて出る。分割は参加者ごとで、ほかの参加者の一覧は変わらない", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 3);
  const guest = await openAsParticipant(browser, accompany.url);

  await chooseInTabMenu(page, 3, "現在のタブと新しい分割表示");

  await expect(panes(page)).toHaveCount(2);
  await expectSideBySide(page, 1, 3);
  await expect(pane(page, 3).locator(".xterm-helper-textarea")).toBeFocused();
  // 分割した 1 と 3 は、1 の場所に 1 つの項目として並ぶ
  await expectEntries(sidebar(page), ["ターミナル 1 | ターミナル 3", "ターミナル 2"]);
  const [first, third] = [(await sidebar(page).getByRole("tab", { name: "ターミナル 1", exact: true }).boundingBox())!, (await sidebar(page).getByRole("tab", { name: "ターミナル 3", exact: true }).boundingBox())!];
  expect(Math.abs(first.y - third.y)).toBeLessThan(2);
  expect(third.x).toBeGreaterThan(first.x);
  // それぞれの名前に閉じるボタンが残る
  const row = sidebar(page).locator(".tab-row").first();
  await expect(row.getByRole("button", { name: "ターミナル 1 を閉じる" })).toBeVisible();
  await expect(row.getByRole("button", { name: "ターミナル 3 を閉じる" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("split-view-sidebar.png") });

  // ツールバーでも同じ
  await sidebarToggle(page).click();
  await expectEntries(toolbar(page), ["ターミナル 1 | ターミナル 3", "ターミナル 2"]);
  const item = toolbar(page).locator(".toolbar-tab-item").first();
  await expect(item.getByRole("button", { name: "ターミナル 1 を閉じる" })).toBeVisible();
  await expect(item.getByRole("button", { name: "ターミナル 3 を閉じる" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("split-view-toolbar.png") });

  // ほかの参加者の一覧と表示は変わらない
  await expectEntries(sidebar(guest), ["ターミナル 1", "ターミナル 2", "ターミナル 3"]);
  await expect(panes(guest)).toHaveCount(1);
});

test("右クリックのメニューで、分割を解除し、ビューを閉じ、左右・上下を切り替え、位置を入れ替える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);
  await chooseInTabMenu(page, 2, "現在のタブと新しい分割表示");
  await expectSideBySide(page, 1, 2);

  // 分割に入っていないタブのメニューには、分割を管理する項目は出ない
  await tab(page, 3).click({ button: "right" });
  await expect(tabMenu(page, 3).getByRole("menuitem", { name: "分割を解除" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await chooseInTabMenu(page, 1, "上下に並べる");
  await expectStacked(page, 1, 2);
  await chooseInTabMenu(page, 1, "左右に並べる");
  await expectSideBySide(page, 1, 2);

  await chooseInTabMenu(page, 1, "位置を入れ替える");
  await expectSideBySide(page, 2, 1);
  await expectEntries(sidebar(page), ["ターミナル 2 | ターミナル 1", "ターミナル 3", "ターミナル 4"]);

  // 分割を解除すると、ふつうのタブに戻り、フォーカスしていたタブだけを表示する
  await pane(page, 1).locator(".xterm-helper-textarea").focus();
  await chooseInTabMenu(page, 2, "分割を解除");
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 1);
  await expectEntries(sidebar(page), ["ターミナル 1", "ターミナル 2", "ターミナル 3", "ターミナル 4"]);
  // 解除したので、2 を選んでも 2 だけが出る
  await tab(page, 2).click();
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 2);

  // このビューを閉じると、そのタブを閉じ、残りのタブだけを表示する
  await chooseInTabMenu(page, 3, "現在のタブと新しい分割表示");
  await expectSideBySide(page, 2, 3);
  await chooseInTabMenu(page, 3, "このビューを閉じる");
  await expect(tab(page, 3)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(1);
  await expectFillsArea(page, 2);
});

test("3 つ並べた分割では、このビューを閉じると残りの 2 つが分割のまま残り、位置の入れ替えはそのタブを含む一番内側の分割を入れ替える", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);
  await chooseInTabMenu(page, 2, "現在のタブと新しい分割表示");
  // 3 つ目は、今の分割に加える
  await chooseInTabMenu(page, 3, "分割表示に追加");
  await expect(panes(page)).toHaveCount(3);
  await expectEntries(sidebar(page), ["ターミナル 1 | ターミナル 2 | ターミナル 3", "ターミナル 4"]);
  // 3 つ並べているときは、それ以上加えられない
  await tab(page, 4).click({ button: "right" });
  await expect(tabMenu(page, 4).getByRole("menuitem", { name: "分割表示に追加" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // 3 を、2 の下に並べ直してから（1 | 2 / 3）、3 で位置を入れ替えると、2 と 3 の上下が入れ替わる
  await chooseInTabMenu(page, 3, "上下に並べる");
  await expectStacked(page, 2, 3);
  await chooseInTabMenu(page, 3, "位置を入れ替える");
  await expectStacked(page, 3, 2);
  await expectSideBySide(page, 1, 3);

  await chooseInTabMenu(page, 1, "このビューを閉じる");
  await expect(tab(page, 1)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(2);
  await expectStacked(page, 3, 2);
  await expectEntries(sidebar(page), ["ターミナル 3 | ターミナル 2", "ターミナル 4"]);
});

test("タブをターミナルの領域の右・左・下の端へドラッグすると、今の表示と分割表示になる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);

  await dragTabToEdge(page, 2, "right");
  await expectSideBySide(page, 1, 2);
  await expectEntries(sidebar(page), ["ターミナル 1 | ターミナル 2", "ターミナル 3", "ターミナル 4"]);

  // 分割の外のタブを見てから、左の端へドラッグする
  await tab(page, 3).click();
  await expect(panes(page)).toHaveCount(1);
  await dragTabToEdge(page, 4, "left");
  await expectSideBySide(page, 4, 3);
  // 分割は 2 つ持てる
  await expectEntries(sidebar(page), ["ターミナル 1 | ターミナル 2", "ターミナル 4 | ターミナル 3"]);

  // 下の端へドラッグすると、上下に並ぶ
  await tab(page, 1).click();
  await expect(panes(page)).toHaveCount(2);
  await chooseInTabMenu(page, 2, "分割を解除");
  await expect(panes(page)).toHaveCount(1);
  await dragTabToEdge(page, 2, "bottom");
  await expect(panes(page)).toHaveCount(2);
  await expectStacked(page, 1, 2);
  await expectEntries(sidebar(page), ["ターミナル 1 | ターミナル 2", "ターミナル 4 | ターミナル 3"]);

  // 分割したタブ（項目）は、端へドラッグしても分割を作らない（分割どうしは並べない）
  const source = (await tab(page, 4).boundingBox())!;
  const area = (await page.getByRole("main").boundingBox())!;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width - 10, area.y + area.height / 2, { steps: 10 });
  await page.mouse.move(area.x + area.width - 12, area.y + area.height / 2 - 2);
  await expect(page.getByRole("region", { name: "分割表示を作る" })).toBeHidden();
  await page.mouse.up();
  await expect(panes(page)).toHaveCount(2);
});

test("分割は 1 つのタブとして並べ替え、グループに出し入れする", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 4);
  const guest = await openAsParticipant(browser, accompany.url);
  await chooseInTabMenu(page, 2, "現在のタブと新しい分割表示");
  await expectEntries(sidebar(page), ["ターミナル 1 | ターミナル 2", "ターミナル 3", "ターミナル 4"]);

  // 下へ移すと、分割の 2 つがまとめて 3 の後ろに移る。ほかの参加者の並びも、続けて動く
  await chooseInTabMenu(page, 1, "下へ移す");
  await expectEntries(sidebar(page), ["ターミナル 3", "ターミナル 1 | ターミナル 2", "ターミナル 4"]);
  await expectEntries(sidebar(guest), ["ターミナル 3", "ターミナル 1", "ターミナル 2", "ターミナル 4"]);

  // 新しいグループに入れると、分割の 2 つが一緒に入る
  await chooseInTabMenu(page, 2, "新しいグループに追加");
  const editor = page.getByRole("textbox", { name: "グループの名前" });
  await expect(editor).toBeFocused();
  await editor.fill("pair");
  await editor.press("Enter");
  await expect(page.locator(".group-label:visible")).toHaveText(["pair"]);
  await expect.poll(() =>
    sidebar(guest).locator("[role=tab]").evaluateAll((tabs) => tabs.map((t) => `${t.getAttribute("aria-label")}:${(t as HTMLElement).dataset.group ?? "-"}`)),
  ).toEqual(["ターミナル 3:-", "ターミナル 1:1", "ターミナル 2:1", "ターミナル 4:-"]);

  // グループから外すと、2 つが一緒に外れる
  await chooseInTabMenu(page, 1, "グループから外す");
  await expect(page.locator(".group-label:visible")).toHaveCount(0);
  await expectEntries(sidebar(page), ["ターミナル 3", "ターミナル 1 | ターミナル 2", "ターミナル 4"]);
});

test("分割では、フォーカスしているターミナルは太い枠、ほかのターミナルは薄い枠で囲む", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await pane(page, 1).locator(".xterm-helper-textarea").focus();

  const frame = (n: number) =>
    pane(page, n).evaluate((e) => {
      const style = getComputedStyle(e);
      return { border: style.borderTopColor, outline: style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth) };
    });
  await expect.poll(async () => (await frame(1)).border).not.toBe("rgba(0, 0, 0, 0)");
  expect((await frame(1)).outline).toBe(0);
  const other = await frame(2);
  expect(other.border).toBe("rgba(0, 0, 0, 0)");
  expect(other.outline).toBe(1);
});

test("ペアプロモードでは、相手が分割の外のタブを見てから分割に戻ると、追従している人も分割に戻る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await openTabs(host, 3);
  await chooseInTabMenu(host, 2, "現在のタブと新しい分割表示");
  const guest = await openAsParticipant(browser, accompany.url);
  await toolbar(guest).getByRole("group", { name: "参加者" }).getByRole("button", { name: "参加者 1 とペアプロ" }).click();
  await expect(panes(guest)).toHaveCount(2);
  await expectEntries(sidebar(guest), ["ターミナル 1 | ターミナル 2", "ターミナル 3"]);

  await tab(host, 3).click();
  await expect(panes(guest)).toHaveCount(1);
  await expect(pane(guest, 3)).toBeVisible();
  await tab(host, 1).click();
  await expect(panes(guest)).toHaveCount(2);
  await expectSideBySide(guest, 1, 2);
});

test("形の正しくない分割の操作・まとめて移す操作が直接届いても、表示と並びは変わらない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await openTabs(page, 3);

  // 改造したブラウザなどから、配置の WebSocket に直接送る。この接続も 1 人の参加者で、自分の表示（view）と並び（tabs）が届く
  const result = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/workspace`);
        let received = 0;
        const wait = () => new Promise((r) => setTimeout(r, 150));
        socket.onmessage = (event) => {
          const { type } = JSON.parse(event.data);
          if (type === "view" || type === "tabs") received++;
        };
        socket.onopen = async () => {
          await wait();
          const changed: string[] = [];
          for (const message of [
            { type: "add-to-view", tab: "2", edge: "top" },
            { type: "add-to-view", tab: "9", edge: "left" },
            { type: "separate", tab: "1" },
            { type: "separate", tab: 1 },
            { type: "move-tab", tabs: ["2", "2"], index: 0 },
            { type: "move-tab", tabs: ["2", 3], index: 0 },
            { type: "move-tab", tabs: [], index: 0 },
            { type: "move-tab", tabs: ["2", "3"], index: 2 },
            { type: "new-group", tabs: ["1", "9"] },
            { type: "remove-from-group", tabs: ["1"] },
          ]) {
            const before = received;
            socket.send(JSON.stringify(message));
            await wait();
            if (received !== before) changed.push(JSON.stringify(message));
          }
          socket.close();
          resolve(changed);
        };
      }),
  );

  expect(result).toEqual([]);
  await expectEntries(sidebar(page), ["ターミナル 1", "ターミナル 2", "ターミナル 3"]);
});
