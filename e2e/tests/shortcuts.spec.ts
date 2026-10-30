import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes, tab } from "./panes";
import { terminalScreen } from "./terminal";

// 分割や新しいタブで増えるターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

// ショートカットは macOS 向けの Cmd+Shift と、Windows / Linux 向けの Ctrl+Shift のどちらでも動く（docs/adr/31-shortcuts.md）。
// Playwright は Linux（CI）でも Meta を付けたキーをページに送れる。ControlOrMeta は Linux では Ctrl になるので使わない
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

function input(page: Page, n: number) {
  return pane(page, n).locator(".xterm-helper-textarea");
}

async function focusPane(page: Page, n: number) {
  await input(page, n).focus();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

// キー入力の先がそのターミナルにあり、全員の画面の表示（「あなた」）もそこにある
async function expectFocusOn(page: Page, n: number) {
  await expect(input(page, n)).toBeFocused();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

function sidebarTabs(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" }).getByRole("tab");
}

for (const modifier of modifiers) {
  test(`${modifier}+R で、キー入力の先のターミナルを右に分割する`, async ({ browser }) => {
    accompany = await startAccompany([], fakeShell);
    const page = await openAsParticipant(browser, accompany.url);
    await focusPane(page, 1);

    await page.keyboard.press(`${modifier}+R`);

    await expectPaneToShow(page, 2, "Fake Shell ready");
    const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
    // 分割で配置が組み直されても、キー入力の先は元のターミナルに残り、続けて操作できる
    await expectFocusOn(page, 1);
    await page.keyboard.type("typed after split\n");
    await expectPaneToShow(page, 1, "typed after split");
  });
}

test("Ctrl+Shift+D で、キー入力の先のターミナルを下に分割する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await page.keyboard.press("Control+Shift+D");

  await expectPaneToShow(page, 2, "Fake Shell ready");
  const [top, bottom] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
  expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
  await expectFocusOn(page, 1);
});

test("Cmd+Shift+X でキー入力の先のターミナルを閉じると、残りのターミナルにキー入力の先が移る", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);
  await page.keyboard.press("Control+Shift+R");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await focusPane(page, 2);

  await page.keyboard.press("Meta+Shift+X");

  await expect(pane(page, 2)).toHaveCount(0);
  await expect(panes(page)).toHaveCount(1);
  await expectFocusOn(page, 1);
  await page.keyboard.type("still typing\n");
  await expectPaneToShow(page, 1, "still typing");
});

test("Cmd+Shift+矢印 / Ctrl+Shift+矢印 で、隣のターミナルへフォーカスを移す", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  // キーボードだけで、1 が左、2 が右上、3 が右下になるように分割していく
  await focusPane(page, 1);
  await page.keyboard.press("Control+Shift+R");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expectFocusOn(page, 1);

  await page.keyboard.press("Meta+Shift+ArrowRight");
  await expectFocusOn(page, 2);

  await page.keyboard.press("Control+Shift+D");
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expectFocusOn(page, 2);
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expectFocusOn(page, 3);

  await page.keyboard.press("Control+Shift+ArrowUp");
  await expectFocusOn(page, 2);
  await page.keyboard.press("Meta+Shift+ArrowDown");
  await expectFocusOn(page, 3);
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expectFocusOn(page, 1);

  // 端では、その向きに隣がないので動かない
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expectFocusOn(page, 1);
  await page.keyboard.type("typed in left\n");
  await expectPaneToShow(page, 1, "typed in left");
});

test("Ctrl+Shift+O で新しいタブを開き、Cmd+Shift+. / , や Ctrl+Shift+. / , で次・前のタブだけを表示する", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  await page.keyboard.press("Control+Shift+O");
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 2/]);
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expectFocusOn(page, 2);

  await page.keyboard.press("Meta+Shift+O");
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 2/, /ターミナル 3/]);
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);

  await page.keyboard.press("Control+Shift+Comma");
  await expect(tab(page, 2)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 2);

  await page.keyboard.press("Meta+Shift+Period");
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);

  // 端では反対側に回る
  await page.keyboard.press("Control+Shift+Period");
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 1);

  await page.keyboard.press("Meta+Shift+Comma");
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);
});

test("次・前のタブへ移ると、一覧の項目ごとに移り、分割は 1 つの項目として飛ばす。分割に移ると、分割で最後にフォーカスしていたターミナルにフォーカスする", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);
  await page.keyboard.press("Control+Shift+R");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await focusPane(page, 2);
  await page.keyboard.press("Control+Shift+O");
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expectFocusOn(page, 3);
  // 一覧は「1 | 2」の分割と 3。分割をしまって、3 だけを表示している（docs/adr/215-split-view.md）

  // 前の項目（分割）に移ると、分割を出して、分割で最後にフォーカスしていた 2 にフォーカスする
  await page.keyboard.press("Control+Shift+Comma");
  await expect(panes(page)).toHaveCount(2);
  await expectFocusOn(page, 2);

  // 分割の中の 1 には移らず、端では反対側（3）に回る
  await page.keyboard.press("Control+Shift+Comma");
  await expect(panes(page)).toHaveCount(1);
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectFocusOn(page, 3);

  await page.keyboard.press("Control+Shift+Period");
  await expect(panes(page)).toHaveCount(2);
  await expectFocusOn(page, 2);

  // 分割の中でフォーカスを 1 に移してから離れて戻ると、1 にフォーカスする
  await focusPane(page, 1);
  await page.keyboard.press("Control+Shift+Period");
  await expect(panes(page)).toHaveCount(1);
  await expectFocusOn(page, 3);
  await page.keyboard.press("Control+Shift+Comma");
  await expect(panes(page)).toHaveCount(2);
  await expectFocusOn(page, 1);
});

test("キーを押し続けても、分割・閉じる・新しいタブは 1 回だけ行う", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);
  await page.keyboard.press("Control+Shift+R");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await page.keyboard.press("Control+Shift+D");
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expectFocusOn(page, 1);

  // 押しっぱなしにすると、2 回目以降の keydown は repeat になる
  const hold = async (key: string) => {
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    for (let i = 0; i < 3; i++) await page.keyboard.down(key);
    await page.keyboard.up(key);
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
  };

  await hold("KeyX");
  await expect(pane(page, 1)).toHaveCount(0);
  // 続けて閉じていれば、少し待つ間に残りのターミナルも閉じる
  await page.waitForTimeout(500);
  await expect(panes(page)).toHaveCount(2);

  await hold("KeyO");
  // 残った 3 と 2 の分割は、一覧で表示の並び（左から）に並ぶ（docs/adr/215-split-view.md）
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 3/, /ターミナル 2/, /ターミナル 4/]);
  await page.waitForTimeout(500);
  await expect(sidebarTabs(page)).toHaveCount(3);
});

test("Latin 以外の配列でも、キーの位置（event.code）でショートカットが効く", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await focusPane(page, 1);

  // ロシア語配列で R の位置のキー（К）を Ctrl+Shift で押したときの keydown
  await input(page, 1).dispatchEvent("keydown", {
    key: "К",
    code: "KeyR",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });

  await expectPaneToShow(page, 2, "Fake Shell ready");
});

test("ショートカットと同じ文字・矢印でも、Shift なしの Ctrl キーはこれまでどおりコマンドに届く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expect(terminalScreen(page)).toContainText("Key reporter ready");
  await page.locator(".xterm-helper-textarea").focus();

  const keys = [
    { key: "Control+R", bytes: "12" },
    { key: "Control+D", bytes: "04" },
    { key: "Control+X", bytes: "18" },
    { key: "Control+O", bytes: "0f" },
    { key: "Control+ArrowRight", bytes: "1b 5b 31 3b 35 43" },
  ];
  for (const { key, bytes } of keys) {
    await page.keyboard.press(key);
    await expect(terminalScreen(page)).toContainText(`keys: ${bytes}`);
  }
  await expect(panes(page)).toHaveCount(1);
  await expect(page.getByRole("tab")).toHaveCount(1);
});

// ボタンのツールチップは、プレフィックスのキー（Ctrl+T のあと）を出す（e2e/tests/prefix-keys.spec.ts、docs/adr/177-prefix-keys.md）
test("ショートカットの一覧を、ツールバーのボタンで確かめられる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);

  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toBeHidden();
  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  await expect(list).toBeVisible();
  for (const text of [
    "右に分割",
    "下に分割",
    "ターミナルを閉じる",
    "隣のターミナルへ移る",
    "新しいタブ",
    "次のタブ",
    "前のタブ",
    "⌘⇧R",
    "Ctrl+Shift+.",
    // マウスの報告モードを使うアプリ（Codex など）の上で選択する方法
    "範囲を強制して選択",
    "Option+ドラッグ",
    "Shift+ドラッグ",
  ]) {
    await expect(list).toContainText(text);
  }

  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
});
