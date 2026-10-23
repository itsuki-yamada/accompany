import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { addToView, boxOf, expectPaneToShow, pane, panes, tab } from "./panes";

// 並べたタブ（ペイン）の位置の入れ替えと、分割の向きの変更。変えるのは自分の表示だけで、ペアプロモードで自分に追従している人には写る
// （docs/adr/163-rearrange-panes.md、docs/adr/100-terminal-tabs.md）。
// 分割で増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

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
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

// ターミナル 1 を右に分割する（1 が左、2 が右）
async function splitTwo(page: Page) {
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
}

// さらにターミナル 2 を下に分割する（1 が左、2 が右上、3 が右下）
async function splitThree(page: Page) {
  await splitTwo(page);
  await pane(page, 2).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
}

// a が b の左にある（上端がそろっていなくてもよい）
async function expectLeftOf(page: Page, a: number, b: number) {
  await expect.poll(async () => (await boxOf(page, b)).x - ((await boxOf(page, a)).x + (await boxOf(page, a)).width)).toBeGreaterThanOrEqual(-1);
}

// a が b の上にある
async function expectAbove(page: Page, a: number, b: number) {
  await expect.poll(async () => (await boxOf(page, b)).y - ((await boxOf(page, a)).y + (await boxOf(page, a)).height)).toBeGreaterThanOrEqual(-1);
}

// 左右に並んでいる（上端がそろっている）
async function expectSideBySide(page: Page, left: number, right: number) {
  await expectLeftOf(page, left, right);
  expect(Math.abs((await boxOf(page, left)).y - (await boxOf(page, right)).y)).toBeLessThan(2);
}

// 上下に並んでいる（左端がそろっている）
async function expectStacked(page: Page, top: number, bottom: number) {
  await expectAbove(page, top, bottom);
  expect(Math.abs((await boxOf(page, top)).x - (await boxOf(page, bottom)).x)).toBeLessThan(2);
}

// ターミナルを並べる領域の高さ・幅いっぱいに伸びている
async function expectFullHeight(page: Page, n: number) {
  const area = (await page.getByRole("main").boundingBox())!;
  await expect.poll(async () => (await boxOf(page, n)).height).toBeGreaterThan(area.height * 0.9);
}

async function expectFullWidth(page: Page, n: number) {
  const area = (await page.getByRole("main").boundingBox())!;
  await expect.poll(async () => (await boxOf(page, n)).width).toBeGreaterThan(area.width * 0.9);
}

function menu(page: Page) {
  return page.getByRole("menu");
}

function menuItem(page: Page, name: string) {
  return menu(page).getByRole("menuitem", { name, exact: true });
}

// ターミナルの中央を右クリックして、メニューを出す
async function openPaneMenu(page: Page, n: number) {
  await pane(page, n).locator(".xterm-screen").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
}

// 境界。左右の分割の境界は縦（vertical）、上下の分割の境界は横（horizontal）
function divider(page: Page, orientation: "vertical" | "horizontal") {
  return page.locator(`[role="separator"][aria-orientation="${orientation}"]`);
}

// 同じ向きの境界が 2 つあるときは、index で選ぶ（0 が一番外の分割の境界）
async function openDividerMenu(page: Page, orientation: "vertical" | "horizontal", index = 0) {
  await divider(page, orientation).nth(index).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
}

// ターミナルのバー（名前のところ）を、別のターミナルの中央までマウスでドラッグする。
// 手を離す前に、入れ替える先が分かる表示が出ていることを確かめる
async function dragBar(page: Page, from: number, to: number) {
  const source = (await pane(page, from).locator(".pane-title").boundingBox())!;
  const target = await boxOf(page, to);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await expect(pane(page, to)).toHaveAttribute("data-swap-target", "true");
  await page.mouse.up();
  await expect(page.locator("[data-swap-target]")).toHaveCount(0);
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sidebarTabs(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" }).getByRole("tab");
}

function followIndicator(page: Page) {
  return page.getByRole("status", { name: "ペアプロモード" });
}

function toolbarPairButton(page: Page, name: string) {
  return page.getByRole("navigation", { name: "ツールバー" }).getByRole("group", { name: "参加者" }).getByRole("button", {
    name: `${name} とペアプロ`,
  });
}

test("ターミナルのバーを別のターミナルへドラッグすると、2 つの位置が入れ替わる。タブの並び順は変わらない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitTwo(page);

  await dragBar(page, 1, 2);

  await expectSideBySide(page, 2, 1);
  // 入れ替えたターミナルは、つないだまま（画面がそのまま残る）
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 2/]);

  // 3 つ並べているときは、重ねたターミナルとだけ入れ替わる（1 が右下、3 が左）
  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expectSideBySide(page, 2, 1);
  await expectStacked(page, 1, 3);

  await dragBar(page, 2, 3);

  await expectFullHeight(page, 3);
  await expectLeftOf(page, 3, 1);
  await expectStacked(page, 1, 2);
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 2/, /ターミナル 3/]);
});

test("右クリックのメニューの「左右を入れ替える」「上下を入れ替える」で、並びを入れ替える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitThree(page);

  // 1 は上下に並んでいないので、上下には入れ替えられない
  await openPaneMenu(page, 1);
  await expect(menuItem(page, "上下を入れ替える")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  // 2 と 3 の上下を入れ替える
  await openPaneMenu(page, 2);
  await menuItem(page, "上下を入れ替える").click();
  await expectStacked(page, 3, 2);
  await expectLeftOf(page, 1, 3);

  // 1 と、右の 2 つ（3 と 2）の左右を入れ替える。大きさも一緒に動く
  await openPaneMenu(page, 1);
  await menuItem(page, "左右を入れ替える").click();
  await expectLeftOf(page, 3, 1);
  await expectStacked(page, 3, 2);
  await expectFullHeight(page, 1);
});

test("左右・上下を入れ替えると、それぞれの大きさも一緒に動く", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitTwo(page);
  const area = (await page.getByRole("main").boundingBox())!;
  // 境界をドラッグして、1 を狭く（3 割ほどに）する
  const line = (await divider(page, "vertical").boundingBox())!;
  await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.3, line.y + line.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await boxOf(page, 1)).width / area.width).toBeLessThan(0.35);

  await openPaneMenu(page, 1);
  await menuItem(page, "左右を入れ替える").click();

  // 狭い 1 が右に、広い 2 が左に移る（場所ではなく、中身と一緒に大きさが動く）
  await expectSideBySide(page, 2, 1);
  await expect.poll(async () => (await boxOf(page, 1)).width / area.width).toBeLessThan(0.35);
  expect((await boxOf(page, 2)).width / area.width).toBeGreaterThan(0.6);
});

test("右クリックのメニューで、左右の並びを上下に、上下の並びを左右に変える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitTwo(page);

  await openPaneMenu(page, 2);
  await expect(menuItem(page, "左右に並べる")).toHaveCount(0);
  await menuItem(page, "上下に並べる").click();

  await expectStacked(page, 1, 2);
  await expectFullWidth(page, 1);
  await expectFullWidth(page, 2);

  await openPaneMenu(page, 1);
  await menuItem(page, "左右に並べる").click();
  await expectSideBySide(page, 1, 2);
  await expectFullHeight(page, 1);

  // 1 つだけ表示しているときは、入れ替えも向きの変更もメニューに出さない（1 つのときのメニューはこれまでのまま）
  await tab(page, 1).click();
  await expect(panes(page)).toHaveCount(1);
  await openPaneMenu(page, 1);
  await expect(menuItem(page, "右に分割")).toBeVisible();
  for (const name of ["左右を入れ替える", "上下を入れ替える", "上下に並べる", "左右に並べる"]) {
    await expect(menuItem(page, name)).toHaveCount(0);
  }
});

test("3 つ並べているときは、境界の右クリックのメニューで、その境界の分割の向きを変えたり入れ替えたりする", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitThree(page);

  // 右上・右下の境界（横の線）で上下を入れ替え、左右に並べる。同じ向きに並んだ 3 つは均等な幅になる
  await openDividerMenu(page, "horizontal");
  await menuItem(page, "上下を入れ替える").click();
  await expectStacked(page, 3, 2);
  await openDividerMenu(page, "horizontal");
  await menuItem(page, "左右に並べる").click();

  await expectSideBySide(page, 1, 3);
  await expectSideBySide(page, 3, 2);
  await expect
    .poll(async () => {
      const widths = await Promise.all([1, 2, 3].map(async (n) => (await boxOf(page, n)).width));
      return Math.max(...widths) - Math.min(...widths);
    })
    .toBeLessThan(10);

  // 一番外の境界（1 と、ほかの 2 つの間）で上下に並べると、1 が上いっぱいに、3 と 2 が下に左右に並ぶ
  await expect(divider(page, "vertical")).toHaveCount(2);
  await openDividerMenu(page, "vertical", 0);
  await menuItem(page, "上下に並べる").click();
  await expectFullWidth(page, 1);
  await expectAbove(page, 1, 3);
  await expectSideBySide(page, 3, 2);
});

for (const modifier of modifiers) {
  test(`${modifier}+Y で分割の向きを変え、${modifier}+K で並びを入れ替える。キー入力の先はそのまま`, async ({ browser }) => {
    accompany = await startAccompany([], fakeShell);
    const page = await openAsParticipant(browser, accompany.url);
    await splitThree(page);
    const input = pane(page, 2).locator(".xterm-helper-textarea");
    await input.focus();

    // キー入力の先（2）を含む分割（2 と 3 の上下）を入れ替える
    await page.keyboard.press(`${modifier}+K`);
    await expectStacked(page, 3, 2);
    await expect(input).toBeFocused();

    // キー入力の先を含む分割の向きを変える（3 と 2 が左右に並ぶ）
    await page.keyboard.press(`${modifier}+Y`);
    await expectSideBySide(page, 3, 2);
    await expectSideBySide(page, 1, 3);
    await expect(input).toBeFocused();

    // シェルには届かない
    await page.keyboard.type("after keys\n");
    await expectPaneToShow(page, 2, "after keys");
  });
}

test("入れ替え・向きの変更のショートカットとドラッグが、ショートカットの一覧に載る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toBeVisible();
  for (const [label, mac, other] of [
    ["分割の向きを変える", "⌘⇧Y", "Ctrl+Shift+Y"],
    ["並べたターミナルを入れ替える", "⌘⇧K", "Ctrl+Shift+K"],
    ["ターミナルの位置を入れ替える", "バーを別のターミナルへドラッグ", "バーを別のターミナルへドラッグ"],
    // 3 つ並べたときの外側の分割は、境界の右クリックで選ぶ
    ["分割を入れ替える・向きを変える", "境界を右クリック", "境界を右クリック"],
  ]) {
    await expect(list.getByRole("row").filter({ hasText: label! })).toHaveText(new RegExp([label, mac, other].map(escape).join(".*")));
  }
});

test("入れ替えや向きの変更は自分の表示だけに効き、ほかの参加者の表示は変わらない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await splitTwo(host);
  const guest = await openAsParticipant(browser, accompany.url);
  await addToView(guest, 2);
  await expectSideBySide(guest, 1, 2);

  await dragBar(host, 1, 2);
  await expectSideBySide(host, 2, 1);
  await openPaneMenu(host, 1);
  await menuItem(host, "上下に並べる").click();
  await expectStacked(host, 2, 1);

  await host.waitForTimeout(300);
  await expectSideBySide(guest, 1, 2);
});

test("ペアプロモードで追従している人には入れ替えと向きの変更が写り、追従している人が自分で変えるとペアプロモードをやめる", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await splitThree(host);
  const guest = await openAsParticipant(browser, accompany.url);
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(panes(guest)).toHaveCount(3);

  // host が入れ替えると、guest にも写る
  await dragBar(host, 1, 3);
  await expectLeftOf(guest, 3, 1);
  await expectStacked(guest, 2, 1);
  // host が向きを変えると、guest にも写る
  await openDividerMenu(host, "horizontal");
  await menuItem(host, "左右に並べる").click();
  await expectSideBySide(guest, 3, 2);
  await expectSideBySide(guest, 2, 1);
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");

  // guest が自分で入れ替えると、ペアプロモードをやめ、host の表示は変わらない
  // （一番外の境界で、3 と、右の 2 つ（2 と 1）を入れ替える）
  await openDividerMenu(guest, "vertical", 0);
  await menuItem(guest, "左右を入れ替える").click();
  await expect(followIndicator(guest)).toHaveCount(0);
  await expectSideBySide(guest, 2, 1);
  await expectSideBySide(guest, 1, 3);
  await guest.waitForTimeout(300);
  await expectSideBySide(host, 3, 2);
  await expectSideBySide(host, 2, 1);

  // そのあと host が変えても、guest の表示は変わらない
  await dragBar(host, 3, 1);
  await expectSideBySide(host, 1, 2);
  await host.waitForTimeout(300);
  await expectSideBySide(guest, 2, 1);
  await expectSideBySide(guest, 1, 3);
});

test("ないタブ・ない分割・表示していないタブの入れ替えや向きの変更が直接届いても、表示は変わらない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitTwo(page);
  // 3 つ目のタブも開くが、下の接続の表示には並べない
  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await tab(page, 1).click();
  await expect(panes(page)).toHaveCount(1);

  // 改造したブラウザなどから、配置の WebSocket に直接送る。この接続も 1 人の参加者で、自分の表示（view）が届く。
  // タブ 1 と 2 を並べてから、正しくないものを 1 件ずつ送り、表示が届かない（変わらない）ことを確かめる
  const result = await page.evaluate(
    () =>
      new Promise<{ invalid: string[]; valid: string[] }>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/workspace`);
        const views: unknown[] = [];
        const wait = () => new Promise((r) => setTimeout(r, 150));
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "view") views.push(message.layout);
        };
        socket.onopen = async () => {
          await wait();
          socket.send(JSON.stringify({ type: "add-to-view", tab: "2" }));
          await wait();
          const layout = views.at(-1) as { id: string };
          const invalid: string[] = [];
          for (const message of [
            { type: "swap-panes", tab: "1", with: "9" },
            // 開いているが、表示していないタブ
            { type: "swap-panes", tab: "1", with: "3" },
            { type: "swap-panes", tab: "1", with: "1" },
            { type: "swap-panes", tab: 1, with: 2 },
            { type: "swap-panes", tab: "1" },
            { type: "flip-split", split: "split-999" },
            { type: "flip-split", split: 1 },
            { type: "flip-split" },
            { type: "rotate-split", split: "split-999" },
            { type: "rotate-split", split: null },
          ]) {
            const before = views.length;
            socket.send(JSON.stringify(message));
            await wait();
            if (views.length !== before) invalid.push(JSON.stringify(message));
          }
          const valid: string[] = [];
          for (const message of [
            { type: "swap-panes", tab: "1", with: "2" },
            { type: "flip-split", split: layout.id },
            { type: "rotate-split", split: layout.id },
          ]) {
            const before = views.length;
            socket.send(JSON.stringify(message));
            await wait();
            if (views.length !== before) valid.push(JSON.stringify(views.at(-1)));
          }
          socket.close();
          resolve({ invalid, valid });
        };
      }),
  );

  expect(result.invalid).toEqual([]);
  expect(result.valid).toHaveLength(3);
  // 入れ替えると葉の順が変わり、向きを変えると column になる
  expect(result.valid[0]).toMatch(/"id":"2".*"id":"1"/);
  expect(result.valid[2]).toContain('"direction":"column"');
  // ほかの参加者（このページ）の表示は変わらない
  await expect(panes(page)).toHaveCount(1);
});
