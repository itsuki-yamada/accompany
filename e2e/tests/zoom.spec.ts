import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes } from "./panes";

// 拡大表示は参加者ごとの表示の切り替えで、サーバーの配置やほかの参加者には反映しない（docs/adr/68-zoom.md）

// 分割や新しいタブで増えるターミナルは $SHELL を起動する。端末のサイズを表示し続けるもの（size-shell）と、
// 入力をそのまま返すもの（fake-shell）を使い分ける
const sizeShell = { SHELL: "e2e/fixtures/size-shell" };
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const large = { width: 1280, height: 720 };
const small = { width: 800, height: 600 };
// ショートカットは macOS 向けの Cmd+Shift と、Windows / Linux 向けの Ctrl+Shift のどちらでも動く（docs/adr/31-shortcuts.md）
const modifiers = ["Meta+Shift", "Control+Shift"] as const;

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
  accompany = undefined;
});

async function openAsParticipant(browser: Browser, url: string, viewport = large) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(url);
  await expect(panes(page).first().locator(".xterm-rows")).not.toBeEmpty();
  return page;
}

function input(page: Page, n: number) {
  return pane(page, n).locator(".xterm-helper-textarea");
}

async function focusPane(page: Page, n: number) {
  await input(page, n).focus();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

// ターミナル 1 を右に分割して、1 が左、2 が右に並んだ状態にする
async function splitRight(page: Page) {
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expect(panes(page)).toHaveCount(2);
}

async function workspaceBox(page: Page) {
  return (await page.locator("#workspace").boundingBox())!;
}

// タブの表示領域いっぱいに出ているか
async function expectToFillWorkspace(page: Page, n: number) {
  const area = await workspaceBox(page);
  await expect.poll(async () => (await boxOf(page, n)).width).toBeGreaterThan(area.width - 2);
  const box = await boxOf(page, n);
  expect(Math.abs(box.x - area.x)).toBeLessThan(2);
  expect(Math.abs(box.y - area.y)).toBeLessThan(2);
  expect(box.height).toBeGreaterThan(area.height - 2);
}

// 隠れているターミナルも含めて探す（getByRole は隠れている要素を探さない）
function anyPane(page: Page, n: number) {
  return page.locator(`.pane[aria-label="ターミナル ${n}"]`);
}

function allPanes(page: Page) {
  return page.locator(".pane");
}

function zoomIndicator(page: Page, n: number) {
  return pane(page, n).getByText("拡大中");
}

async function expectZoomed(page: Page, n: number, hidden: number[]) {
  await expect(zoomIndicator(page, n)).toBeVisible();
  // 隠れているだけで、ターミナルはなくなっていない
  for (const m of hidden) {
    await expect(anyPane(page, m)).toHaveCount(1);
    await expect(anyPane(page, m)).toBeHidden();
  }
  await expectToFillWorkspace(page, n);
}

// 拡大していない分割の表示に戻っている
async function expectNotZoomed(page: Page, shown: number[]) {
  for (const n of shown) {
    await expect(pane(page, n)).toBeVisible();
    await expect(zoomIndicator(page, n)).toBeHidden();
  }
}

// コマンドから見えている端末のサイズ（size-shell が最後に表示したもの）
async function commandSize(page: Page, n: number) {
  const text = (await pane(page, n).locator(".xterm-rows").textContent()) ?? "";
  return [...text.matchAll(/size: (\d+)x(\d+)/g)].at(-1)?.slice(1).join("x") ?? "";
}

async function openMenu(page: Page, n: number) {
  const box = (await pane(page, n).locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
}

for (const modifier of modifiers) {
  test(`${modifier}+Z で、フォーカスしているターミナルをタブの表示領域いっぱいに拡大し、もう一度押すと元の分割に戻る`, async ({
    browser,
  }) => {
    accompany = await startAccompany([], fakeShell);
    const page = await openAsParticipant(browser, accompany.url);
    await splitRight(page);
    await expectPaneToShow(page, 2, "Fake Shell ready");
    const before = [await boxOf(page, 1), await boxOf(page, 2)];
    await focusPane(page, 2);

    await page.keyboard.press(`${modifier}+Z`);

    await expectZoomed(page, 2, [1]);
    // 拡大しても、キー入力の先はそのターミナルのまま
    await expect(input(page, 2)).toBeFocused();
    await page.keyboard.type("typed while zoomed\n");
    await expectPaneToShow(page, 2, "typed while zoomed");

    await page.keyboard.press(`${modifier}+Z`);

    await expectNotZoomed(page, [1, 2]);
    expect([await boxOf(page, 1), await boxOf(page, 2)]).toEqual(before);
    await expect(input(page, 2)).toBeFocused();
  });
}

test("ペインのバーのボタンと右クリックメニューからも、拡大と解除ができる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitRight(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  // バーのボタン。ツールチップにショートカットを併記する
  const zoomButton = pane(page, 1).getByRole("button", { name: "拡大表示" });
  await expect(zoomButton).toHaveAttribute("title", "拡大表示（⌘⇧Z / Ctrl+Shift+Z）");
  await expect(zoomButton).toHaveAttribute("aria-pressed", "false");
  await zoomButton.click();
  await expectZoomed(page, 1, [2]);
  await expect(zoomButton).toHaveAttribute("aria-pressed", "true");
  await zoomButton.click();
  await expectNotZoomed(page, [1, 2]);
  await expect(zoomButton).toHaveAttribute("aria-pressed", "false");

  // 右クリックメニュー
  await openMenu(page, 2);
  await page.getByRole("menuitem", { name: "拡大表示" }).click();
  await expectZoomed(page, 2, [1]);
  await openMenu(page, 2);
  await page.getByRole("menuitem", { name: "拡大を解除" }).click();
  await expectNotZoomed(page, [1, 2]);
});

test("分割していないときは、拡大できない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await expect(pane(page, 1).getByRole("button", { name: "拡大表示" })).toBeDisabled();
  await openMenu(page, 1);
  await expect(page.getByRole("menuitem", { name: "拡大表示" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  await focusPane(page, 1);
  await page.keyboard.press("Control+Shift+Z");
  await expect(zoomIndicator(page, 1)).toBeHidden();
  // ショートカットのキーはシェルに渡さない
  await page.keyboard.type("after zoom key\n");
  await expectPaneToShow(page, 1, "after zoom key");
});

test("拡大はその参加者の画面だけに効き、ほかの参加者の配置と端末の列数・行数は変わらない", async ({ browser }) => {
  accompany = await startAccompany([], sizeShell);
  // 画面の大きい人（host）が拡大する。拡大した広さを端末の大きさとして伝えると、全員の端末が大きくなってしまう
  const host = await openAsParticipant(browser, accompany.url, large);
  const guest = await openAsParticipant(browser, accompany.url, small);
  await splitRight(host);
  await expect(panes(guest)).toHaveCount(2);
  await expect.poll(() => commandSize(guest, 2)).not.toBe("");
  // 2 人の表示領域から決まった大きさに落ち着くのを待つ。左右に半分ずつ分けたので、2 つのターミナルは同じ大きさになる
  const sameSizes = async () =>
    new Set([
      await commandSize(host, 1),
      await commandSize(host, 2),
      await commandSize(guest, 1),
      await commandSize(guest, 2),
    ]).size === 1;
  await expect.poll(sameSizes).toBe(true);
  const sizes = [await commandSize(guest, 1), await commandSize(guest, 2)];
  const guestBoxes = [await boxOf(guest, 1), await boxOf(guest, 2)];

  await focusPane(host, 1);
  await host.keyboard.press("Control+Shift+Z");
  await expectZoomed(host, 1, [2]);
  // 端末の大きさが変わるなら、変わるまでの時間を待ってから確かめる
  await host.waitForTimeout(1000);

  // ほかの参加者の配置は変わらず、拡大の表示も出ない
  await expectNotZoomed(guest, [1, 2]);
  expect([await boxOf(guest, 1), await boxOf(guest, 2)]).toEqual(guestBoxes);
  // 端末の大きさ（コマンドから見える列数・行数）は、拡大する前のまま
  expect([await commandSize(guest, 1), await commandSize(guest, 2)]).toEqual(sizes);
  expect(await commandSize(host, 1)).toBe(sizes[0]);
  // 拡大中の人がウィンドウの大きさを変えても、端末は大きくならない
  await host.setViewportSize({ width: 1600, height: 900 });
  await host.waitForTimeout(1000);
  expect(await commandSize(guest, 1)).toBe(sizes[0]);

  // 解除すると、元の分割での表示領域に合わせ直す（ウィンドウを広げたぶん、大きくなる）
  await host.keyboard.press("Control+Shift+Z");
  await expectNotZoomed(host, [1, 2]);
  await expect.poll(() => commandSize(guest, 1)).not.toBe(sizes[0]);
});

test("拡大中のターミナルがほかの参加者に閉じられると、拡大を解除して残りのターミナルを出す", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await splitRight(host);
  await pane(host, 2).getByRole("button", { name: "右に分割" }).click();
  await expect(panes(guest)).toHaveCount(3);

  await focusPane(guest, 3);
  await guest.keyboard.press("Control+Shift+Z");
  await expectZoomed(guest, 3, [1, 2]);

  // ほかのターミナルが閉じられても、拡大したまま
  await pane(host, 2).getByRole("button", { name: "閉じる" }).click();
  await expect(allPanes(guest)).toHaveCount(2);
  await expectZoomed(guest, 3, [1]);

  // ほかの参加者が分割しても、拡大したまま。増えたターミナルは隠れている
  await pane(host, 1).getByRole("button", { name: "下に分割" }).click();
  await expect(allPanes(guest)).toHaveCount(3);
  await expectZoomed(guest, 3, [1, 4]);

  // 拡大中のターミナルが閉じられると、拡大を解除する
  await pane(host, 3).getByRole("button", { name: "閉じる" }).click();
  await expect(allPanes(guest)).toHaveCount(2);
  await expectNotZoomed(guest, [1, 4]);
  await expect.poll(async () => (await boxOf(guest, 1)).height).toBeGreaterThan(0);
});

test("タブが切り替わると拡大を解除し、戻ったときは分割した表示になる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitRight(page);
  await focusPane(page, 2);
  await page.keyboard.press("Control+Shift+Z");
  await expectZoomed(page, 2, [1]);

  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expect(zoomIndicator(page, 3)).toBeHidden();

  await page.getByRole("tab", { name: "タブ 1", exact: true }).click();
  await expectNotZoomed(page, [1, 2]);
});

test("隠しているターミナルは接続したままで、拡大中に届いた出力も解除すると見える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await splitRight(host);
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await focusPane(guest, 1);
  await guest.keyboard.type("before zoom\n");
  await expectPaneToShow(guest, 1, "before zoom");

  // 拡大・解除で、ターミナルの接続を作り直さない
  const sockets: string[] = [];
  guest.on("websocket", (socket) => sockets.push(socket.url()));
  await focusPane(guest, 2);
  await guest.keyboard.press("Control+Shift+Z");
  await expectZoomed(guest, 2, [1]);

  await focusPane(host, 1);
  await host.keyboard.type("while hidden\n");
  await expectPaneToShow(host, 1, "while hidden");

  await guest.keyboard.press("Control+Shift+Z");
  await expectNotZoomed(guest, [1, 2]);
  await expectPaneToShow(guest, 1, "before zoom");
  await expectPaneToShow(guest, 1, "while hidden");
  expect(sockets).toEqual([]);
});

test("ショートカットの一覧に、拡大表示の切り替えが載る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toBeVisible();
  const row = list.getByRole("row").filter({ hasText: "拡大表示の切り替え" });
  await expect(row).toContainText("⌘⇧Z");
  await expect(row).toContainText("Ctrl+Shift+Z");
});
