import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes, tab } from "./panes";
import { terminalScreen } from "./terminal";

// tmux のように、プレフィックス Ctrl+T を押してから 1 つキーを押して操作する（docs/adr/177-prefix-keys.md）。
// 分割や新しいタブで増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
// OSC 133 の印を出す偽のシェル（直前のコマンドの出力のコピーを確かめる）
const promptShell = ["--", "bun", "e2e/fixtures/prompt-shell.ts"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
});

async function openAsParticipant(browser: Browser, url: string, ready = "Fake Shell ready") {
  const context = await newContext(browser, {
    viewport: { width: 1280, height: 720 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, ready);
  return page;
}

function input(page: Page, n: number) {
  return pane(page, n).locator(".xterm-helper-textarea");
}

async function focusPane(page: Page, n: number) {
  await input(page, n).focus();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

async function expectFocusOn(page: Page, n: number) {
  await expect(input(page, n)).toBeFocused();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

function sidebarTabs(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" }).getByRole("tab");
}

// プレフィックスを押して待ち受けていることの表示
function indicator(page: Page) {
  return page.getByRole("status", { name: "プレフィックスキー" });
}

// Ctrl+T を押してから key を押す
async function prefixed(page: Page, key: string) {
  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();
  await page.keyboard.press(key);
  await expect(indicator(page)).toBeHidden();
}

test("Ctrl+T のあと c で新しいタブを開き、n / p で次・前のタブ、数字でその番目のタブだけを表示する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await prefixed(page, "c");
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expectFocusOn(page, 2);
  await prefixed(page, "c");
  await expect(sidebarTabs(page)).toHaveCount(3);
  await expectFocusOn(page, 3);

  await prefixed(page, "p");
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 2);
  await prefixed(page, "n");
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);
  // 端では反対側に回る
  await prefixed(page, "n");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 1);

  await prefixed(page, "3");
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);
  await prefixed(page, "1");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 1);
  // ないタブの番号では何もしない
  await prefixed(page, "9");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 1);

  // 操作のキーはターミナルに届かない
  await page.keyboard.type("after keys\n");
  await expectPaneToShow(page, 1, "after keys");
  await expect(pane(page, 1).locator(".xterm-rows")).not.toContainText("c");
});

test("Ctrl+T のあと % で右に、\" で下に分割し、矢印と o で隣のターミナルへ移り、x で閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await prefixed(page, "%");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  await expectFocusOn(page, 1);

  await prefixed(page, "ArrowRight");
  await expectFocusOn(page, 2);
  await prefixed(page, '"');
  await expectPaneToShow(page, 3, "Fake Shell ready");
  const [top, bottom] = [await boxOf(page, 2), await boxOf(page, 3)];
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  await expectFocusOn(page, 2);

  await prefixed(page, "ArrowDown");
  await expectFocusOn(page, 3);
  await prefixed(page, "ArrowLeft");
  await expectFocusOn(page, 1);
  // o は、並べている順に次のターミナルへ移る（最後からは最初に戻る）
  await prefixed(page, "o");
  await expectFocusOn(page, 2);
  await prefixed(page, "o");
  await expectFocusOn(page, 3);
  await prefixed(page, "o");
  await expectFocusOn(page, 1);

  await prefixed(page, "ArrowRight");
  await expectFocusOn(page, 2);
  await prefixed(page, "x");
  await expect(pane(page, 2)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(2);
  await page.keyboard.type("still typing\n");
  await expect(page.getByRole("main")).toContainText("still typing");
});

test("Ctrl+T のあと { / } で前・次のターミナルと入れ替え、space で分割の向きを変える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);
  await prefixed(page, "%");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  // 1 が左、2 が右

  // b の左端から a の左端までの距離・上端から上端までの距離
  const dx = async (a: number, b: number) => (await boxOf(page, a)).x - (await boxOf(page, b)).x;
  const dy = async (a: number, b: number) => (await boxOf(page, a)).y - (await boxOf(page, b)).y;

  await prefixed(page, "}");
  await expect.poll(() => dx(1, 2)).toBeGreaterThan(10);
  // 入れ替えたターミナルにキー入力の先が残る
  await expectFocusOn(page, 1);
  await prefixed(page, "{");
  await expect.poll(() => dx(2, 1)).toBeGreaterThan(10);
  await expectFocusOn(page, 1);

  await prefixed(page, " ");
  await expect.poll(() => dy(2, 1)).toBeGreaterThan(10);
  expect(Math.abs(await dx(1, 2))).toBeLessThan(2);
  await prefixed(page, " ");
  await expect.poll(() => dx(2, 1)).toBeGreaterThan(10);
  await expectFocusOn(page, 1);
});

test("Ctrl+T のあと , でタブの名前を変える", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await prefixed(page, ",");
  const editor = page.getByRole("textbox", { name: "ターミナルの名前" });
  await expect(editor).toBeFocused();
  await editor.fill("server");
  await editor.press("Enter");

  await expect(page.getByRole("tab", { name: "server", exact: true })).toHaveCount(1);
  await expectFocusOn(page, 1);
});

test("Ctrl+T のあと y で、直前のコマンドの出力をコピーする", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await openAsParticipant(browser, accompany.url, "Prompt shell ready");
  await focusPane(page, 1);
  await page.keyboard.type("lines 2 copied\n");
  await expectPaneToShow(page, 1, "copied 2");
  await expect(pane(page, 1).getByRole("button", { name: "直前のコマンドの出力をコピー" })).toHaveAttribute(
    "title",
    "直前のコマンドの出力をコピー（Ctrl+T → y）",
  );

  await prefixed(page, "y");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copied 1\ncopied 2");
  await expect(pane(page, 1).getByRole("alert")).toContainText("直前のコマンドの出力をコピーしました（2 行）");
});

test("Ctrl+T を 2 回押すと、ターミナルに Ctrl+T（0x14）が届く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expect(terminalScreen(page)).toContainText("Key reporter ready");
  await page.locator(".xterm-helper-textarea").focus();

  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();
  await page.keyboard.press("Control+KeyT");

  await expect(indicator(page)).toBeHidden();
  // 次のキーが届くのを待ってから、それまでに届いたものを確かめる。1 回目の Ctrl+T はもれず、0x14 は 1 回だけ届く
  await page.keyboard.press("a");
  await expect(terminalScreen(page)).toContainText("keys: 61");
  expect(await reportedKeys(page)).toEqual(["14", "61"]);
});

// キーを報告するプログラムに届いたキー（16 進）を、届いた順に
async function reportedKeys(page: Page) {
  const text = await terminalScreen(page).innerText();
  return [...text.matchAll(/keys: ([0-9a-f ]+)/g)].map((m) => m[1]!.trim());
}

async function openKeyReporter(page: Page) {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expect(terminalScreen(page)).toContainText("Key reporter ready");
  await page.locator(".xterm-helper-textarea").focus();
}

test("待ち受けている間にクリックすると、待ち受けをやめる", async ({ page }) => {
  await openKeyReporter(page);
  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();

  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(indicator(page)).toBeHidden();
  // やめたあとのキーは、操作ではなく、ふだんどおりターミナルに届く
  await page.keyboard.press("c");
  await expect(terminalScreen(page)).toContainText("keys: 63");
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("待ち受けている間にページの外へフォーカスが移ると（blur）、待ち受けをやめる", async ({ page }) => {
  await openKeyReporter(page);
  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();

  // ほかのウィンドウやアプリへ移ったとき
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("blur")));

  await expect(indicator(page)).toBeHidden();
  await page.keyboard.press("c");
  await expect(terminalScreen(page)).toContainText("keys: 63");
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("Shift を押してから % を押しても、Shift で待ち受けをやめずに右に分割する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();
  // press("%") は Shift の keydown を出さないので、実際の押し方と同じく Shift を先に押す
  await page.keyboard.down("Shift");
  await expect(indicator(page)).toBeVisible();
  await page.keyboard.press("%");
  await page.keyboard.up("Shift");

  await expect(indicator(page)).toBeHidden();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
});

test("押し続けて繰り返し届いたキーは、ターミナルに送らない", async ({ page }) => {
  await openKeyReporter(page);

  // Ctrl+T を押し続けても、待ち受けたままで、Ctrl+T（0x14）を送らない
  await page.keyboard.down("Control");
  for (let i = 0; i < 3; i++) await page.keyboard.down("KeyT");
  await page.keyboard.up("KeyT");
  await page.keyboard.up("Control");
  await expect(indicator(page)).toBeVisible();

  // 待ち受けをやめたキー（q）を押し続けても、繰り返しはターミナルに送らない
  for (let i = 0; i < 3; i++) await page.keyboard.down("q");
  await page.keyboard.up("q");
  await expect(indicator(page)).toBeHidden();

  await page.keyboard.press("a");
  await expect(terminalScreen(page)).toContainText("keys: 61");
  expect(await reportedKeys(page)).toEqual(["61"]);
});

test("プレフィックスを押すと待ち受けていることを出し、Escape や関係ないキーでやめる。やめたキーはターミナルに届かない", async ({
  page,
}) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expect(terminalScreen(page)).toContainText("Key reporter ready");
  await page.locator(".xterm-helper-textarea").focus();
  await expect(indicator(page)).toBeHidden();

  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();
  await expect(indicator(page)).toContainText("Ctrl+T");
  await page.keyboard.press("Escape");
  await expect(indicator(page)).toBeHidden();

  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();
  await page.keyboard.press("q");
  await expect(indicator(page)).toBeHidden();

  // やめたあとのキーは、ふだんどおりターミナルに届く。Escape と q は届いていない
  await page.keyboard.press("a");
  await expect(terminalScreen(page)).toContainText("keys: 61");
  await expect(terminalScreen(page)).not.toContainText("keys: 1b");
  await expect(terminalScreen(page)).not.toContainText("keys: 71");
  await expect(panes(page)).toHaveCount(1);
});

test("JIS 配列でも、入力される文字（\"）で下に分割する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await page.keyboard.press("Control+KeyT");
  await expect(indicator(page)).toBeVisible();
  // JIS 配列では " は Shift+2 で入力する
  await input(page, 1).dispatchEvent("keydown", {
    key: '"',
    code: "Digit2",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [top, bottom] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
});

test("Ctrl+T のあと ? でショートカットの一覧を開き、一覧とツールチップに新しいキーが出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await expect(pane(page, 1).getByRole("button", { name: "右に分割" })).toHaveAttribute("title", "右に分割（Ctrl+T → %）");
  await expect(pane(page, 1).getByRole("button", { name: "下に分割" })).toHaveAttribute("title", '下に分割（Ctrl+T → "）');
  await expect(pane(page, 1).getByRole("button", { name: "閉じる" })).toHaveAttribute("title", "閉じる（Ctrl+T → x）");
  await expect(page.getByRole("button", { name: "新しいタブ" }).first()).toHaveAttribute("title", "新しいタブ（Ctrl+T → c）");

  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toBeHidden();
  await prefixed(page, "?");
  await expect(list).toBeVisible();
  for (const text of [
    "Ctrl+T のあと",
    "新しいタブ",
    "タブの名前を変える",
    "前・次のターミナルと入れ替える",
    "分割の向きを変える",
    "直前のコマンドの出力をコピー",
    "Ctrl+T をターミナルに送る",
    // Windows / Linux の Chrome で使う、これまでのキー
    "Ctrl+Shift+R",
  ]) {
    await expect(list).toContainText(text);
  }

  // Escape で閉じると、ターミナルにキー入力の先が戻る
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expectFocusOn(page, 1);

  // 右クリックのメニューにもキーを出す
  const box = (await pane(page, 1).locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + 50, box.y + 50, { button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "右に分割" })).toHaveAttribute(
    "title",
    "右に分割（Ctrl+T → %）",
  );
});
