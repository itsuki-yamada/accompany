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

  await prefixed(page, "}");
  await expect.poll(async () => (await boxOf(page, 1)).x).toBeGreaterThan((await boxOf(page, 2)).x);
  // 入れ替えたターミナルにキー入力の先が残る
  await expectFocusOn(page, 1);
  await prefixed(page, "{");
  await expect.poll(async () => (await boxOf(page, 2)).x).toBeGreaterThan((await boxOf(page, 1)).x);
  await expectFocusOn(page, 1);

  await prefixed(page, " ");
  await expect.poll(async () => (await boxOf(page, 2)).y).toBeGreaterThan((await boxOf(page, 1)).y + 10);
  expect(Math.abs((await boxOf(page, 1)).x - (await boxOf(page, 2)).x)).toBeLessThan(2);
  await prefixed(page, " ");
  await expect.poll(async () => (await boxOf(page, 2)).x).toBeGreaterThan((await boxOf(page, 1)).x + 10);
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
  await expect(terminalScreen(page)).toContainText("keys: 14");
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
  await expect(pane(page, 1).getByRole("button", { name: "直前のコマンドの出力をコピー" })).toHaveAttribute(
    "title",
    /Ctrl\+T → y/,
  );

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

  // 右クリックのメニューにもキーを出す
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  const box = (await pane(page, 1).locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + 50, box.y + 50, { button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "右に分割" })).toHaveAttribute(
    "title",
    "右に分割（Ctrl+T → %）",
  );
});
