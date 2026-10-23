import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

// 入力した行に応じて、OSC 52 でクリップボードへの書き込み・読み出しを頼むアプリを $SHELL の代わりに動かす
const clipboardShell = { SHELL: "e2e/fixtures/clipboard-shell" };
const clipboard = ["clipboard-read", "clipboard-write"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

// 参加者ごとに別のブラウザコンテキストで開く。ブラウザのクリップボードはコンテキストどうしで共有されることがあるので、
// その参加者のページがクリップボードに書き込んだものを、書き込みのたびに記録しておき、参加者ごとに確かめる
async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 }, permissions: clipboard });
  await context.addInitScript(() => {
    const writes: string[] = [];
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    Object.assign(window, { clipboardWrites: writes, rejectNextWrite: false });
    navigator.clipboard.writeText = (text: string) => {
      const w = window as unknown as { rejectNextWrite: boolean };
      // ブラウザが書き込みを断ったとき（ページにフォーカスがない、など）を真似る
      if (w.rejectNextWrite) {
        w.rejectNextWrite = false;
        return Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"));
      }
      writes.push(text);
      return original(text);
    };
  });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Clipboard app ready");
  return page;
}

function clipboardWrites(page: Page) {
  return page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites);
}

async function readClipboard(page: Page) {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

async function enter(page: Page, line: string) {
  await pane(page, 1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(line);
  await page.keyboard.press("Enter");
}

test("アプリが OSC 52 で書き込みを頼むと、入力した参加者のクリップボードに入り、ほかの参加者のクリップボードは変わらない", async ({
  browser,
}) => {
  accompany = await startAccompany([], clipboardShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await enter(guest, "copy from guest\\nsecond line");
  await expectPaneToShow(host, 1, "copy requested");

  await expect.poll(() => clipboardWrites(guest)).toEqual(["from guest\nsecond line"]);
  expect(await readClipboard(guest)).toBe("from guest\nsecond line");
  expect(await clipboardWrites(host)).toEqual([]);

  // 次に入力した人が、次の書き込みを受け取る
  await enter(host, "copy from host");
  await expect.poll(() => clipboardWrites(host)).toEqual(["from host"]);
  expect(await clipboardWrites(guest)).toEqual(["from guest\nsecond line"]);
});

test("クリップボードに入れたことを知らせ、入れた中身は画面に出さない", async ({ browser }) => {
  accompany = await startAccompany([], clipboardShell);
  const page = await openAsParticipant(browser, accompany.url);

  await enter(page, "copy hidden-secret-value");

  await expect(pane(page, 1).getByRole("alert")).toContainText("クリップボードにコピーしました");
  await expect(pane(page, 1).getByRole("alert")).not.toContainText("hidden-secret-value");
});

test("ブラウザが書き込みを断ったときは、押すとクリップボードに入れるボタンを出す", async ({ browser }) => {
  accompany = await startAccompany([], clipboardShell);
  const page = await openAsParticipant(browser, accompany.url);
  await page.evaluate(() => Object.assign(window, { rejectNextWrite: true }));

  await enter(page, "copy after click");

  const copy = pane(page, 1).getByRole("button", { name: "クリップボードに入れる" });
  await expect(copy).toBeVisible();
  expect(await clipboardWrites(page)).toEqual([]);
  // 中身はボタンのまわりにも出さない
  await expect(copy.locator("xpath=..")).not.toContainText("after click");
  await copy.click();

  await expect.poll(() => clipboardWrites(page)).toEqual(["after click"]);
  expect(await readClipboard(page)).toBe("after click");
  await expect(copy).toBeHidden();
});

test("アプリがクリップボードの読み出しを頼んでも、中身を返さない", async ({ browser }) => {
  accompany = await startAccompany([], clipboardShell);
  const page = await openAsParticipant(browser, accompany.url);
  await page.evaluate(() => navigator.clipboard.writeText("do not leak"));

  await enter(page, "read");
  await expectPaneToShow(page, 1, "read requested");
  await enter(page, "check");

  await expectPaneToShow(page, 1, "replies: 0");
  expect(await readClipboard(page)).toBe("do not leak");
});

test("大きすぎる書き込みは、クリップボードに入れずに知らせる", async ({ browser }) => {
  accompany = await startAccompany([], clipboardShell);
  const page = await openAsParticipant(browser, accompany.url);

  await enter(page, "big 800000");

  await expect(pane(page, 1).getByRole("alert")).toContainText("大きすぎる");
  expect(await clipboardWrites(page)).toEqual([]);
});

test("途中から参加した人のクリップボードには、参加前の書き込みが入らない", async ({ browser }) => {
  accompany = await startAccompany([], clipboardShell);
  const host = await openAsParticipant(browser, accompany.url);
  await enter(host, "copy before join");
  await expect.poll(() => clipboardWrites(host)).toEqual(["before join"]);

  const late = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(late, 1, "copy requested");
  // 届いた画面を書き終えたあとも、書き込みが起きないことを確かめる
  await late.waitForTimeout(1000);

  expect(await clipboardWrites(late)).toEqual([]);
  await expect(pane(late, 1).getByRole("button", { name: "クリップボードに入れる" })).toHaveCount(0);
});

test("ページを開き直しても、前の書き込みがクリップボードに入り直さない", async ({ browser }) => {
  accompany = await startAccompany([], clipboardShell);
  const page = await openAsParticipant(browser, accompany.url);
  await enter(page, "copy before reload");
  await expect.poll(() => clipboardWrites(page)).toEqual(["before reload"]);

  await page.reload();
  await expectPaneToShow(page, 1, "copy requested");
  await page.waitForTimeout(1000);

  expect(await clipboardWrites(page)).toEqual([]);
});

test("再起動してスクロールバックを戻しても、前の書き込みがクリップボードに入らない", async ({ browser }) => {
  const stateDir = newStateDir();
  try {
    const env = { ...clipboardShell, ACCOMPANY_STATE_DIR: stateDir };
    accompany = await startAccompany([], env);
    const before = await openAsParticipant(browser, accompany.url);
    await enter(before, "copy before restart");
    await expect.poll(() => clipboardWrites(before)).toEqual(["before restart"]);
    await closeContexts();
    await accompany.stop();

    accompany = await startAccompany([], env);
    const after = await openAsParticipant(browser, accompany.url);
    await expectPaneToShow(after, 1, "copy requested");
    await after.waitForTimeout(1000);

    expect(await clipboardWrites(after)).toEqual([]);
  } finally {
    await rm(join(stateDir, ".."), { recursive: true, force: true });
  }
});
