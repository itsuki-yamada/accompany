import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

const searchOutput = ["--", "bun", "e2e/fixtures/search-output.ts"];

async function open(page: Page, url: string) {
  await page.goto(url);
  await expectPaneToShow(page, 1, "Search output ready");
}

function searchBar(page: Page, n = 1) {
  return pane(page, n).getByRole("search", { name: "ターミナルの検索" });
}

function searchInput(page: Page, n = 1) {
  return searchBar(page, n).getByRole("textbox", { name: "検索する文字" });
}

// ヒット件数（例: 1/3）
function hitCount(page: Page, n = 1) {
  return searchBar(page, n).getByRole("status");
}

function screen(page: Page, n = 1) {
  return pane(page, n).locator(".xterm-rows");
}

async function focusTerminal(page: Page, n = 1) {
  await pane(page, n).locator(".xterm-helper-textarea").focus();
}

async function openSearch(page: Page, text: string) {
  await focusTerminal(page);
  await page.keyboard.press(openKey);
  await page.keyboard.type(text);
}

// macOS の Cmd+F。Playwright は Linux（CI）でも Meta を付けたキーをページに送れる。
// ControlOrMeta だと Linux では Ctrl+F になり、シェルのキーと区別できないので使わない
const openKey = "Meta+F";

test("Cmd+F で検索バーが開き、入力欄にフォーカスが移る", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  await expect(searchBar(page)).toBeHidden();

  await focusTerminal(page);
  await page.keyboard.press(openKey);

  await expect(searchBar(page)).toBeVisible();
  await expect(searchInput(page)).toBeFocused();
});

test("Windows / Linux 向けの Ctrl+Shift+F でも、ターミナルのバーのボタンでも検索バーが開く", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);

  await focusTerminal(page);
  await page.keyboard.press("Control+Shift+F");
  await expect(searchBar(page)).toBeVisible();
  await expect(searchInput(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(searchBar(page)).toBeHidden();

  await pane(page, 1).getByRole("button", { name: "検索", exact: true }).click();
  await expect(searchBar(page)).toBeVisible();
  await expect(searchInput(page)).toBeFocused();
});

test("Ctrl+F では検索バーは開かず、キーはコマンドに届く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expectPaneToShow(page, 1, "Key reporter ready");

  await focusTerminal(page);
  await page.keyboard.press("Control+F");

  await expect(screen(page)).toContainText("keys: 06");
  await expect(searchBar(page)).toBeHidden();
});

test("スクロールバックを含めて検索し、件数を見ながら Enter / Shift+Enter で前後のヒットに移動できる", async ({
  page,
}) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  // 最初のヒットは、画面から流れたスクロールバックにある
  await expect(screen(page)).not.toContainText("Needle in the scrollback");

  await openSearch(page, "needle");
  await expect(hitCount(page)).toHaveText(/^\d\/3$/);

  // 1 件目（スクロールバック）に移ると、その行が見える位置までスクロールする
  await expect(async () => {
    await searchInput(page).press("Enter");
    await expect(hitCount(page)).toHaveText("1/3", { timeout: 100 });
  }).toPass();
  await expect(screen(page)).toContainText("Needle in the scrollback");

  await searchInput(page).press("Enter");
  await expect(hitCount(page)).toHaveText("2/3");
  await expect(screen(page)).toContainText("a needle in the middle");

  await searchInput(page).press("Shift+Enter");
  await expect(hitCount(page)).toHaveText("1/3");
  await expect(screen(page)).toContainText("Needle in the scrollback");
});

test("前後のボタンでヒットを移動できる", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  await openSearch(page, "needle");
  await expect(hitCount(page)).toHaveText(/^\d\/3$/);

  const next = searchBar(page).getByRole("button", { name: "次のヒット" });
  const previous = searchBar(page).getByRole("button", { name: "前のヒット" });
  await expect(async () => {
    await next.click();
    await expect(hitCount(page)).toHaveText("2/3", { timeout: 100 });
  }).toPass();
  await expect(screen(page)).toContainText("a needle in the middle");

  await next.click();
  await expect(hitCount(page)).toHaveText("3/3");
  await previous.click();
  await expect(hitCount(page)).toHaveText("2/3");
});

test("大文字・小文字の区別を切り替えられる", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  await openSearch(page, "Needle");
  await expect(hitCount(page)).toHaveText(/^\d\/3$/);

  const caseSensitive = searchBar(page).getByRole("button", { name: "大文字と小文字を区別" });
  await caseSensitive.click();
  await expect(caseSensitive).toHaveAttribute("aria-pressed", "true");
  await expect(hitCount(page)).toHaveText("1/1");
  await expect(screen(page)).toContainText("Needle in the scrollback");

  await caseSensitive.click();
  await expect(caseSensitive).toHaveAttribute("aria-pressed", "false");
  await expect(hitCount(page)).toHaveText(/^\d\/3$/);
});

test("正規表現で検索できる", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  await openSearch(page, "ne+dle (in|near) the (middle|end)");
  // 正規表現にしていなければ、文字どおりに探すのでヒットしない
  await expect(hitCount(page)).toHaveText("結果なし");

  const regex = searchBar(page).getByRole("button", { name: "正規表現" });
  await regex.click();
  await expect(regex).toHaveAttribute("aria-pressed", "true");
  await expect(hitCount(page)).toHaveText(/^\d\/2$/);
});

test("Escape で検索バーが閉じ、キー入力がターミナルに戻る", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  await openSearch(page, "needle");
  await expect(hitCount(page)).toHaveText(/^\d\/3$/);

  await page.keyboard.press("Escape");
  await expect(searchBar(page)).toBeHidden();

  await page.keyboard.type("after search\n");
  await expectPaneToShow(page, 1, "got: after search");
});

test("閉じるボタンで検索バーが閉じる", async ({ page }) => {
  accompany = await startAccompany(searchOutput);
  await open(page, accompany.url);
  await focusTerminal(page);
  await page.keyboard.press(openKey);

  await searchBar(page).getByRole("button", { name: "検索を閉じる" }).click();
  await expect(searchBar(page)).toBeHidden();
});

test("分割したターミナルでは、キー入力の先のターミナルだけで検索バーが開く", async ({ page }) => {
  accompany = await startAccompany(searchOutput, { SHELL: "e2e/fixtures/fake-shell" });
  await open(page, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await focusTerminal(page, 2);
  await page.keyboard.press(openKey);

  await expect(searchBar(page, 2)).toBeVisible();
  await expect(searchBar(page, 1)).toBeHidden();
});

test("バーの検索ボタンで開くと、そのターミナルにフォーカスが移る", async ({ page }) => {
  accompany = await startAccompany(searchOutput, { SHELL: "e2e/fixtures/fake-shell" });
  await open(page, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await focusTerminal(page, 1);
  await expect(pane(page, 1)).toHaveAttribute("data-focused", "true");

  await pane(page, 2).getByRole("button", { name: "検索", exact: true }).click();

  await expect(searchInput(page, 2)).toBeFocused();
  await expect(pane(page, 2)).toHaveAttribute("data-focused", "true");
  await expect(pane(page, 1)).not.toHaveAttribute("data-focused", "true");
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await open(page, url);
  return page;
}

test("検索は参加者ごとの操作で、ほかの参加者の画面には影響しない", async ({ browser }) => {
  accompany = await startAccompany(searchOutput);
  const alice = await openAsParticipant(browser, accompany.url);
  const bob = await openAsParticipant(browser, accompany.url);

  await openSearch(alice, "needle");
  await expect(async () => {
    await searchInput(alice).press("Enter");
    await expect(hitCount(alice)).toHaveText("1/3", { timeout: 100 });
  }).toPass();
  await expect(screen(alice)).toContainText("Needle in the scrollback");

  // 相手の画面には検索バーが出ず、スクロールも動かない
  await expect(searchBar(bob)).toBeHidden();
  await expect(screen(bob)).toContainText("Search output ready");
  await expect(screen(bob)).not.toContainText("Needle in the scrollback");
});

// 端末の大きさは参加者の表示領域から決める（一番大きいものに合わせる）ので、検索バーでターミナルの表示領域が狭まると、
// ほかの参加者の端末も小さくなってしまう
test("検索バーを開いても、端末の大きさは変わらない", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/size-reporter.ts"]);
  await page.goto(accompany.url);
  // コマンドは既定の 80x24 で起動し、ブラウザの表示領域に合わせた大きさに変わるので、それを待つ
  await expect(screen(page)).toContainText(/size: (?!80x24)\d+x\d+/);
  const before = (await screen(page).textContent())!.match(/size: \d+x\d+/g);

  await focusTerminal(page);
  await page.keyboard.press(openKey);
  await expect(searchBar(page)).toBeVisible();

  // 大きさが変わると、偽のエージェントが新しい大きさを表示する
  await page.waitForTimeout(500);
  expect((await screen(page).textContent())!.match(/size: \d+x\d+/g)).toEqual(before);
});
