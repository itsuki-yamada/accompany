import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes } from "./panes";

// 分割した画面で、フォーカスしているターミナルが自分の枠に収まらないときは、そのターミナルを自分の画面だけで拡大して見る。
// 拡大はサーバーの配置やほかの参加者には反映しない（docs/adr/68-zoom.md）

// 分割や新しい Workspace で増えるターミナルは $SHELL を起動する。端末のサイズを表示し続けるもの（size-shell）と、
// 入力をそのまま返すもの（fake-shell）を使い分ける
const sizeShell = { SHELL: "e2e/fixtures/size-shell" };
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const large = { width: 1280, height: 720 };
const small = { width: 800, height: 720 };
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

// Workspace の表示領域いっぱいに出ているか
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

// 自分で拡大を外していることの表示
function zoomOffIndicator(page: Page, n: number) {
  return pane(page, n).getByText("拡大を外しています");
}

// 画面の大きい人（host）と小さい人（guest）が参加し、host が右に分割した状態にする。
// 端末の大きさは host に合わせるので、guest の画面では分割した枠に収まらない
async function openLargeAndSmall(browser: Browser, shell: Record<string, string>) {
  accompany = await startAccompany([], shell);
  const host = await openAsParticipant(browser, accompany.url, large);
  const guest = await openAsParticipant(browser, accompany.url, small);
  await splitRight(host);
  await expect(allPanes(guest)).toHaveCount(2);
  return { host, guest };
}

// ターミナルの表示領域に、端末が収まっている（スクロールバーが出ていない）
function fitsInPane(page: Page, n: number) {
  return pane(page, n)
    .locator(".pane-terminal")
    .evaluate((e) => e.scrollWidth <= e.clientWidth && e.scrollHeight <= e.clientHeight);
}

// コマンドから見えている端末のサイズ（size-shell が最後に表示したもの）
async function commandSize(page: Page, n: number) {
  const text = (await anyPane(page, n).locator(".xterm-rows").textContent()) ?? "";
  return [...text.matchAll(/size: (\d+)x(\d+)/g)].at(-1)?.slice(1).join("x") ?? "";
}

async function openMenu(page: Page, n: number) {
  const box = (await pane(page, n).locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
}

test("分割した枠に端末が収まらないときは、フォーカスしているターミナルを自動で拡大し、ほかの参加者の配置と端末の大きさは変わらない", async ({
  browser,
}) => {
  const { host, guest } = await openLargeAndSmall(browser, sizeShell);
  // 左右に半分ずつ分けたので、2 つのターミナルは同じ大きさになる。host の画面に合わせた大きさに落ち着くのを待つ
  const sameSizes = async () =>
    new Set([
      await commandSize(host, 1),
      await commandSize(host, 2),
      await commandSize(guest, 1),
      await commandSize(guest, 2),
    ]).size === 1;
  await expect.poll(sameSizes).toBe(true);
  const size = await commandSize(host, 1);

  // guest は、最初にフォーカスしたターミナル 1 を拡大して、スクロールせずに見られる
  await expectZoomed(guest, 1, [2]);
  expect(await fitsInPane(guest, 1)).toBe(true);
  // 拡大中も、キー入力の先はそのターミナルのまま
  await expect(input(guest, 1)).toBeFocused();

  // host の画面は分割したまま
  const hostBoxes = [await boxOf(host, 1), await boxOf(host, 2)];
  await expectNotZoomed(host, [1, 2]);
  // 拡大した広さで端末の大きさを伝えると大きくなるので、変わるまでの時間を待ってから確かめる
  await guest.waitForTimeout(1000);
  expect([await boxOf(host, 1), await boxOf(host, 2)]).toEqual(hostBoxes);
  expect([await commandSize(host, 1), await commandSize(host, 2)]).toEqual([size, size]);
  expect(await commandSize(guest, 1)).toBe(size);
});

test("枠に収まるようになると、元の分割の表示に戻る", async ({ browser }) => {
  const { host, guest } = await openLargeAndSmall(browser, sizeShell);
  await expectZoomed(guest, 1, [2]);

  // 画面の大きい人が抜けると、端末は guest の画面に合わせた大きさになり、枠に収まる
  await host.context().close();

  await expectNotZoomed(guest, [1, 2]);
  await expect.poll(() => fitsInPane(guest, 1)).toBe(true);
  await expect(input(guest, 1)).toBeFocused();
});

test("分割していても枠に収まっていれば、拡大しない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await splitRight(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await focusPane(page, 2);

  await page.waitForTimeout(500);
  await expectNotZoomed(page, [1, 2]);
  await expect(pane(page, 2).getByRole("button", { name: "拡大表示" })).toBeDisabled();
  // ショートカットは何もせず、シェルにも渡さない
  await page.keyboard.press("Control+Shift+Z");
  await expectNotZoomed(page, [1, 2]);
  await expect(zoomOffIndicator(page, 2)).toBeHidden();
  await page.keyboard.type("after zoom key\n");
  await expectPaneToShow(page, 2, "after zoom key");
});

test("拡大中でも隣のターミナルへフォーカスを移せ、移った先も収まらなければそのターミナルを拡大する", async ({
  browser,
}) => {
  const { guest } = await openLargeAndSmall(browser, sizeShell);
  await expectZoomed(guest, 1, [2]);

  // 隠れているターミナルの向きは、元の分割の配置で決める
  await guest.keyboard.press("Control+Shift+ArrowRight");
  await expectZoomed(guest, 2, [1]);
  await expect(input(guest, 2)).toBeFocused();

  await guest.keyboard.press("Meta+Shift+ArrowLeft");
  await expectZoomed(guest, 1, [2]);
  await expect(input(guest, 1)).toBeFocused();
});

for (const modifier of modifiers) {
  test(`${modifier}+Z で拡大を外して分割の全体を見られ、もう一度押すと拡大に戻る`, async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser, sizeShell);
    await expectZoomed(guest, 1, [2]);

    await guest.keyboard.press(`${modifier}+Z`);

    await expectNotZoomed(guest, [1, 2]);
    await expect(zoomOffIndicator(guest, 1)).toBeVisible();
    await expect(input(guest, 1)).toBeFocused();
    // 外している間は、フォーカスを移しても拡大しない
    await guest.keyboard.press("Control+Shift+ArrowRight");
    await expect(input(guest, 2)).toBeFocused();
    await expectNotZoomed(guest, [1, 2]);
    await expect(zoomOffIndicator(guest, 2)).toBeVisible();

    await guest.keyboard.press(`${modifier}+Z`);

    await expectZoomed(guest, 2, [1]);
    await expect(zoomOffIndicator(guest, 2)).toBeHidden();
    await expect(input(guest, 2)).toBeFocused();
  });
}

test("ペインのバーのボタンと右クリックメニューからも、拡大を外したり戻したりできる", async ({ browser }) => {
  const { guest } = await openLargeAndSmall(browser, sizeShell);
  await expectZoomed(guest, 1, [2]);

  // バーのボタン。ツールチップにショートカットを併記する
  const zoomButton = pane(guest, 1).getByRole("button", { name: "拡大表示" });
  await expect(zoomButton).toHaveAttribute("title", "拡大表示（⌘⇧Z / Ctrl+Shift+Z）");
  await expect(zoomButton).toHaveAttribute("aria-pressed", "true");
  await zoomButton.click();
  await expectNotZoomed(guest, [1, 2]);
  await expect(zoomButton).toHaveAttribute("aria-pressed", "false");
  await zoomButton.click();
  await expectZoomed(guest, 1, [2]);
  await expect(zoomButton).toHaveAttribute("aria-pressed", "true");

  // 右クリックメニュー
  await openMenu(guest, 1);
  await guest.getByRole("menuitem", { name: "拡大を解除" }).click();
  await expectNotZoomed(guest, [1, 2]);
  await openMenu(guest, 1);
  await guest.getByRole("menuitem", { name: "拡大表示" }).click();
  await expectZoomed(guest, 1, [2]);
});

test("拡大中のターミナルが閉じられると拡大を解除し、ほかのターミナルが閉じられても拡大は続く", async ({ browser }) => {
  const { host, guest } = await openLargeAndSmall(browser, sizeShell);
  await pane(host, 2).getByRole("button", { name: "下に分割" }).click();
  await expect(allPanes(guest)).toHaveCount(3);
  await expectZoomed(guest, 1, [2, 3]);

  await pane(host, 3).getByRole("button", { name: "閉じる" }).click();
  await expect(allPanes(guest)).toHaveCount(2);
  await expectZoomed(guest, 1, [2]);

  await pane(host, 1).getByRole("button", { name: "閉じる" }).click();
  await expect(allPanes(guest)).toHaveCount(1);
  await expectNotZoomed(guest, [2]);
  await expect(zoomIndicator(guest, 2)).toBeHidden();
});

test("隠しているターミナルは接続したままで、拡大中に届いた出力も拡大を外すと見える", async ({ browser }) => {
  const { host, guest } = await openLargeAndSmall(browser, fakeShell);
  await expectZoomed(guest, 1, [2]);

  // 拡大・解除で、ターミナルの接続を作り直さない
  const sockets: string[] = [];
  guest.on("websocket", (socket) => sockets.push(socket.url()));
  await focusPane(host, 2);
  await host.keyboard.type("while hidden\n");
  await expectPaneToShow(host, 2, "while hidden");

  await guest.keyboard.press("Control+Shift+Z");
  await expectNotZoomed(guest, [1, 2]);
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await expectPaneToShow(guest, 2, "while hidden");
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
