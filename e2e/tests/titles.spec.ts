import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

// 入力した行（「2;タイトル」など）を OSC でタイトルとして設定する偽のシェル
const titleShell = { SHELL: "e2e/fixtures/title-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Title setter ready");
  return page;
}

// ペインのバーに出る、コマンドが設定したタイトル
function paneTitle(page: Page, n: number) {
  return pane(page, n).locator(".pane-program");
}

async function setTitle(page: Page, n: number, line: string) {
  await pane(page, n).locator(".xterm-helper-textarea").focus();
  // 長い行も 1 回で入力する
  await page.keyboard.insertText(line);
  await page.keyboard.press("Enter");
}

test("コマンドが OSC 2 で設定したタイトルが、ターミナルのバーに「ターミナル N」と並んで出る", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const page = await openAsParticipant(browser, accompany.url);

  await setTitle(page, 1, "2;vim notes.md");

  await expect(paneTitle(page, 1)).toHaveText("vim notes.md");
  await expect(pane(page, 1).locator(".pane-title")).toHaveText("ターミナル 1");
});

test("OSC 0 で設定したタイトルも出る", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const page = await openAsParticipant(browser, accompany.url);

  await setTitle(page, 1, "0;~/work/accompany");

  await expect(paneTitle(page, 1)).toHaveText("~/work/accompany");
});

test("タイトルが変わると表示も変わり、空にすると「ターミナル N」だけに戻る", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await setTitle(page, 1, "2;first");
  await expect(paneTitle(page, 1)).toHaveText("first");

  await setTitle(page, 1, "2;second");
  await expect(paneTitle(page, 1)).toHaveText("second");

  await setTitle(page, 1, "2;");
  await expect(paneTitle(page, 1)).toBeHidden();
  await expect(pane(page, 1).locator(".pane-title")).toHaveText("ターミナル 1");
});

test("分割した各ターミナルは、それぞれのタイトルを出す", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Title setter ready");

  await setTitle(page, 1, "2;left");
  await setTitle(page, 2, "2;right");

  await expect(paneTitle(page, 1)).toHaveText("left");
  await expect(paneTitle(page, 2)).toHaveText("right");
});

test("タイトルは参加者全員の画面に出て、途中から参加した人にも今のタイトルが出る", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await setTitle(host, 1, "2;shared title");
  await expect(paneTitle(guest, 1)).toHaveText("shared title");

  const late = await openAsParticipant(browser, accompany.url);
  await expect(paneTitle(late, 1)).toHaveText("shared title");
});

test("長いタイトルはバーの中で省略して表示し、全文はツールチップで見られる", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const page = await openAsParticipant(browser, accompany.url);
  const long = `claude: ${"とても長い会話の名前 ".repeat(20)}end`;

  await setTitle(page, 1, `2;${long}`);

  await expect(paneTitle(page, 1)).toHaveAttribute("title", long);
  // 省略して表示し（中身が表示幅より長い）、フォーカスしている人の表示やバーのボタンは削られない
  const title = paneTitle(page, 1);
  expect(await title.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  // 「あなた」が折り返されずに 1 行で出る
  const badge = pane(page, 1).getByRole("status").getByText("あなた", { exact: true });
  await expect(badge).toBeVisible();
  expect((await badge.boundingBox())!.height).toBeLessThanOrEqual(16);
  const paneBox = (await pane(page, 1).boundingBox())!;
  const closeBox = (await pane(page, 1).getByRole("button", { name: "閉じる" }).boundingBox())!;
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
  await expect(pane(page, 1).locator(".pane-bar")).toHaveCSS("height", "22px");
});

test("タイトルの中の制御文字は取り除き、極端に長いタイトルは切り詰める", async ({ browser }) => {
  accompany = await startAccompany([], titleShell);
  const page = await openAsParticipant(browser, accompany.url);

  // 双方向テキストの上書き（U+202E）は取り除き、行の区切り（U+2028）は空白にする
  await setTitle(page, 1, "2;abc\\u202Edef\\u2028ghi");
  await expect(paneTitle(page, 1)).toHaveAttribute("title", "abcdef ghi");

  // 256 文字を超える部分は切り詰め、省略したことがわかるよう末尾に … を付ける
  await setTitle(page, 1, `2;${"x".repeat(600)}`);
  await expect(paneTitle(page, 1)).toHaveAttribute("title", `${"x".repeat(255)}…`);
});
