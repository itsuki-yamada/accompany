import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { addToView, boxOf, expectPaneToShow, pane } from "./panes";
import { expectTerminalToShow, terminalScreen, typeInTerminal } from "./terminal";

// 分割で増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
// マウスの報告モードとアプリケーションカーソルキーモードを有効にしたまま、受け取った入力を 16 進で表示する TUI
const modeReporter = ["--", "bun", "e2e/fixtures/mode-reporter.ts"];
const clipboard = ["clipboard-read", "clipboard-write"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function open(browser: Browser, url: string, permissions: string[] = []) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 }, permissions });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

function menu(page: Page) {
  return page.getByRole("menu");
}

function menuItem(page: Page, name: string) {
  return menu(page).getByRole("menuitem", { name });
}

// ターミナルの中央（または指定した位置）を右クリックして、メニューを出す
async function openMenu(page: Page, n = 1, at?: { x: number; y: number }) {
  const box = (await pane(page, n).locator(".xterm-screen").boundingBox())!;
  const { x, y } = at ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(x, y, { button: "right" });
  await expect(menu(page)).toBeVisible();
}

async function clickTerminal(page: Page) {
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function pressArrowUp(page: Page) {
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("ArrowUp");
}

// 行の中央をトリプルクリックして、その行を選択する。選択した行の位置を返す
async function selectLine(page: Page, text: RegExp) {
  const line = page.locator(".xterm-rows > div").filter({ hasText: text }).last();
  const box = (await line.boundingBox())!;
  const at = { x: box.x + 20, y: box.y + box.height / 2 };
  await page.mouse.click(at.x, at.y, { clickCount: 3 });
  return at;
}

test("ターミナルを右クリックすると、Accompany のメニューが出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");

  await openMenu(page);

  for (const name of ["コピー", "ペースト", "すべて選択", "ターミナルのリセット", "右に分割", "下に分割"]) {
    await expect(menuItem(page, name)).toBeVisible();
  }
});

test("メニューは Escape で閉じ、キー入力の先がターミナルに戻る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await openMenu(page);

  await page.keyboard.press("Escape");

  await expect(menu(page)).toBeHidden();
  await page.keyboard.type("typed after escape\n");
  await expectTerminalToShow(page, "typed after escape");
});

test("メニューの外側をクリックすると、メニューが閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await openMenu(page);

  await pane(page, 1).locator(".pane-title").click();

  await expect(menu(page)).toBeHidden();
});

test("メニューは矢印キーで項目を移り、Enter で選べる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await openMenu(page);
  await expect(menuItem(page, "コピー")).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(menuItem(page, "下に分割")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menuItem(page, "右に分割")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItem(page, "下に分割")).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(menu(page)).toBeHidden();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [top, bottom] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
});

test("メニューの「右に分割」で、新しいターミナルが右に並ぶ", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await openMenu(page);

  await menuItem(page, "右に分割").click();

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
});

test("文字を選択して「コピー」を選ぶと、選択した文字がクリップボードに入る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url, clipboard);
  await expectTerminalToShow(page, "Fake Shell ready");
  await typeInTerminal(page, "copy me please\n");
  await expectTerminalToShow(page, "copy me please");
  const at = await selectLine(page, /copy\sme\splease/);

  await openMenu(page, 1, at);
  await menuItem(page, "コピー").click();

  await expect(menu(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("copy me please");
});

test("文字を選択していないときは、「コピー」を選べない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");

  await openMenu(page);

  await expect(menuItem(page, "コピー")).toBeDisabled();
});

test("「すべて選択」でターミナルの出力をまとめて選択し、コピーできる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url, clipboard);
  await expectTerminalToShow(page, "Fake Shell ready");
  await typeInTerminal(page, "first line\nsecond line\n");
  await expectTerminalToShow(page, "second line");

  await openMenu(page);
  await menuItem(page, "すべて選択").click();
  await openMenu(page);
  await menuItem(page, "コピー").click();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Fake Shell ready");
  expect(copied).toContain("first line");
  expect(copied).toContain("second line");
});

test("「ペースト」を選ぶと、クリップボードの文字がコマンドに届く", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url, clipboard);
  await expectTerminalToShow(page, "Fake Shell ready");
  await page.evaluate(() => navigator.clipboard.writeText("pasted from menu\r"));

  await openMenu(page);
  await menuItem(page, "ペースト").click();

  await expect(menu(page)).toBeHidden();
  await expectTerminalToShow(page, "pasted from menu");
});

test("クリップボードの読み取りが許可されていないときは、キーボードでのペーストを案内する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");

  await openMenu(page);
  await menuItem(page, "ペースト").click();

  await expect(pane(page, 1).getByRole("alert")).toContainText("Ctrl+V");
});

test("TUI がマウスの報告モードを有効にしていても、右クリックはアプリに渡さずにメニューを出す", async ({ browser }) => {
  accompany = await startAccompany(modeReporter);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Mode reporter ready");

  await openMenu(page);
  await page.keyboard.press("Escape");
  await typeInTerminal(page, "x");

  await expectTerminalToShow(page, "keys: 78");
  // 右クリックの報告（ESC [ < 2 ...）は届いていない
  await expect(terminalScreen(page)).not.toContainText("keys: 1b");
});

test("「ターミナルのリセット」で、TUI が残したマウスの報告やカーソルキーのモードが戻る。コマンドは動き続ける", async ({
  browser,
}) => {
  accompany = await startAccompany(modeReporter);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Mode reporter ready");
  // リセットする前は、左クリックがアプリに報告され（ESC [ < 0 ...）、上矢印は ESC O A になる
  await clickTerminal(page);
  await expectTerminalToShow(page, "keys: 1b 5b 3c 30");
  await pressArrowUp(page);
  await expectTerminalToShow(page, "keys: 1b 4f 41");

  await openMenu(page);
  await menuItem(page, "ターミナルのリセット").click();

  await expect(menu(page)).toBeHidden();
  await expect(terminalScreen(page)).not.toContainText("keys:");
  await clickTerminal(page);
  await pressArrowUp(page);
  await typeInTerminal(page, "x");
  // 同じコマンドが入力を受け取り続けていて、クリックはもう報告されず、上矢印は通常の ESC [ A になる
  await expectTerminalToShow(page, "keys: 78");
  await expectTerminalToShow(page, "keys: 1b 5b 41");
  await expect(terminalScreen(page)).not.toContainText("keys: 1b 5b 3c");
  await expect(terminalScreen(page)).not.toContainText("keys: 1b 4f 41");
});

test("リセットは、ほかの参加者の画面と、あとから参加した人の画面にも反映される", async ({ browser }) => {
  accompany = await startAccompany(modeReporter);
  const host = await open(browser, accompany.url);
  const guest = await open(browser, accompany.url);
  await expectTerminalToShow(host, "Mode reporter ready");
  await expectTerminalToShow(guest, "Mode reporter ready");

  await openMenu(host);
  await menuItem(host, "ターミナルのリセット").click();
  await expect(terminalScreen(guest)).not.toContainText("Mode reporter ready");
  const late = await open(browser, accompany.url);
  // あとから参加した人の画面が復元されるのを、リセットのあとの出力で待つ
  await typeInTerminal(host, "z");
  await expect(terminalScreen(late)).toContainText("keys: 7a");

  await clickTerminal(guest);
  await pressArrowUp(guest);
  await typeInTerminal(guest, "x");
  await expect(terminalScreen(guest)).toContainText("keys: 78");
  await clickTerminal(late);
  await pressArrowUp(late);
  await typeInTerminal(late, "y");
  await expect(terminalScreen(late)).toContainText("keys: 79");

  // どちらの画面でも、クリックは報告されず、上矢印は通常の ESC [ A になる
  for (const page of [guest, late]) {
    await expect(terminalScreen(page)).not.toContainText("keys: 1b 5b 3c");
    await expect(terminalScreen(page)).not.toContainText("keys: 1b 4f 41");
  }
});

test("「ターミナルのリセット」で、コマンドが残したタイトルも全員の画面から消える", async ({ browser }) => {
  // 入力した行（「2;タイトル」）を OSC 2 でタイトルとして設定する偽のシェル
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/title-shell" });
  const host = await open(browser, accompany.url);
  const guest = await open(browser, accompany.url);
  await expectTerminalToShow(host, "Title setter ready");
  await typeInTerminal(host, "2;stale title\n");
  for (const page of [host, guest]) {
    await expect(pane(page, 1).locator(".pane-program")).toHaveText("stale title");
  }

  await openMenu(host);
  await menuItem(host, "ターミナルのリセット").click();

  for (const page of [host, guest]) {
    await expect(pane(page, 1).locator(".pane-program")).toBeHidden();
  }
});

test("メニューを開いている間に、ほかの参加者がそのターミナルを閉じると、メニューも閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await open(browser, accompany.url);
  const guest = await open(browser, accompany.url);
  await expectTerminalToShow(host, "Fake Shell ready");
  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await addToView(guest, 2);
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await openMenu(host, 2);

  await pane(guest, 2).getByRole("button", { name: "閉じる" }).click();

  await expect(pane(host, 2)).toHaveCount(0);
  await expect(menu(host)).toBeHidden();
});

test("メニューには、どのターミナルのメニューかがわかる名前が付いている", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");

  await openMenu(page);

  await expect(page.getByRole("menu", { name: "ターミナル 1 のメニュー" })).toBeVisible();
});
