import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { terminalScreen } from "./terminal";

// 端末の大きさは参加者のうち一番小さい画面に合わせるが、下限より小さくはしない。下限はウィンドウの大きさ（ピクセル）で持ち、
// 各ブラウザが、そのウィンドウで Accompany を開いたときに収まる列数・行数に直す。下限は参加者全員に効く設定で、
// 設定の画面で変えられ、再起動しても残る（docs/adr/99-smallest-size.md）

const sizeReporter = ["--", "bun", "e2e/fixtures/size-reporter.ts"];
const large = { width: 1280, height: 720 };
// フル HD を縦に 4 つに分けた 1 つ分のウィンドウ。既定の下限と同じ大きさ
const quarter = { width: 480, height: 1080 };
// 既定の下限より縦横とも小さい画面
const narrow = { width: 400, height: 400 };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
});

async function openAsParticipant(browser: Browser, url: string, viewport = large) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  await expect(terminalScreen(page)).toContainText("size:");
  return page;
}

// コマンドから見えている端末のサイズ（size-reporter が最後に表示したもの）。端末の大きさが変わってから描き直すまでの間は、
// サイズが画面にないことがあるので、読めるまで待つ
async function commandSize(page: Page) {
  let size = "";
  await expect(async () => {
    const sizes = [...((await terminalScreen(page).textContent()) ?? "").matchAll(/size: (\d+)x(\d+)/g)];
    const last = sizes.at(-1);
    size = last ? `${last[1]}x${last[2]}` : "";
    expect(size).not.toBe("");
  }).toPass({ timeout: 5_000 });
  return size;
}

function parse(size: string) {
  const [cols, rows] = size.split("x").map(Number);
  return { cols: cols!, rows: rows! };
}

// 1 人で開いたときの端末の大きさ（自分の画面に合わせた大きさ）
async function sizeAlone(browser: Browser, url: string, viewport: typeof large) {
  const page = await openAsParticipant(browser, url, viewport);
  await expect.poll(() => commandSize(page)).not.toBe("80x24");
  return { page, size: await commandSize(page) };
}

// ターミナルの表示領域が、はみ出した端末をスクロールして見せているか（横・縦）
function scrollable(page: Page) {
  return page
    .locator(".pane-terminal")
    .evaluate((e) => ({ x: e.scrollWidth > e.clientWidth, y: e.scrollHeight > e.clientHeight }));
}

async function openSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "表示の設定" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "表示の設定" }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

function widthInput(page: Page) {
  return page.getByRole("dialog", { name: "表示の設定" }).getByLabel("下限のウィンドウの幅");
}

function heightInput(page: Page) {
  return page.getByRole("dialog", { name: "表示の設定" }).getByLabel("下限のウィンドウの高さ");
}

// 設定の画面で、端末の大きさの下限（ウィンドウの大きさ）を入力する。入力欄を離れたときに反映する
async function setMinWindow(page: Page, size: { width?: number; height?: number }) {
  await openSettings(page);
  for (const [input, value] of [
    [widthInput(page), size.width],
    [heightInput(page), size.height],
  ] as const) {
    if (value === undefined) continue;
    await input.fill(String(value));
    await input.blur();
  }
}

async function closeSettings(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "表示の設定" })).toBeHidden();
}

test("下限の既定はフル HD を縦に 4 つに分けたウィンドウ（480×1080）で、それより画面の小さい人がいても、そのウィンドウに収まる大きさより小さくしない", async ({
  browser,
}) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });
  const { page: quarterPage, size } = await sizeAlone(browser, accompany.url, quarter);
  await openSettings(quarterPage);
  await expect(widthInput(quarterPage)).toHaveValue("480");
  await expect(heightInput(quarterPage)).toHaveValue("1080");
  await closeSettings(quarterPage);

  const narrowPage = await openAsParticipant(browser, accompany.url, narrow);

  // 画面の狭い人が加わっても、下限のウィンドウ（= quarter の画面）に収まる大きさのまま
  await expect.poll(() => commandSize(narrowPage)).toBe(size);
  await narrowPage.waitForTimeout(500);
  expect(await commandSize(quarterPage)).toBe(size);
  // 下限のウィンドウの人ははみ出さず、それより小さい人は、はみ出した部分をスクロールして見る
  expect(await scrollable(quarterPage)).toEqual({ x: false, y: false });
  await expect.poll(() => scrollable(narrowPage)).toEqual({ x: true, y: true });

  // 下限より幅が広く高さが低い人は、端末の周りの余白（横）と、スクロール（縦）で見る
  const largePage = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(largePage)).toBe(size);
  expect(await scrollable(largePage)).toEqual({ x: false, y: true });
});

test("下限を変えると、参加者全員の端末の大きさが変わり、ほかの参加者の設定の画面にも出る", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  // 既定の下限（高さ 1080）は 1280×720 の画面より高いので、縦にはみ出す
  await expect.poll(() => scrollable(host)).toEqual({ x: false, y: true });
  await expect.poll(() => scrollable(guest)).toEqual({ x: false, y: true });
  const before = parse(await commandSize(host));

  // 下げると、画面に合わせた大きさになり、はみ出さなくなる
  await setMinWindow(host, { height: 400 });

  await expect.poll(async () => parse(await commandSize(host)).rows).toBeLessThan(before.rows);
  const fitted = await commandSize(host);
  await expect.poll(() => commandSize(guest)).toBe(fitted);
  await expect.poll(() => scrollable(host)).toEqual({ x: false, y: false });
  await expect.poll(() => scrollable(guest)).toEqual({ x: false, y: false });
  await closeSettings(host);
  await openSettings(guest);
  await expect(heightInput(guest)).toHaveValue("400");

  // 画面より広くすると、全員が横にはみ出した部分をスクロールして見る
  await setMinWindow(guest, { width: 1900 });

  await expect.poll(async () => parse(await commandSize(host)).cols).toBeGreaterThan(parse(fitted).cols);
  expect(parse(await commandSize(host)).rows).toBe(parse(fitted).rows);
  await expect.poll(() => commandSize(guest)).toBe(await commandSize(host));
  await expect.poll(() => scrollable(host)).toEqual({ x: true, y: false });
  await openSettings(host);
  await expect(widthInput(host)).toHaveValue("1900");
});

test("下限は保存し、再起動しても残る", async ({ browser }) => {
  const env = { ACCOMPANY_STATE_DIR: newStateDir() };
  accompany = await startAccompany(sizeReporter, env, { minWindow: null });
  const page = await openAsParticipant(browser, accompany.url);
  await setMinWindow(page, { width: 1900, height: 400 });
  await expect.poll(() => scrollable(page)).toEqual({ x: true, y: false });
  const size = await commandSize(page);
  await page.context().close();
  await accompany.stop();

  accompany = await startAccompany(sizeReporter, env, { minWindow: null });
  const reopened = await openAsParticipant(browser, accompany.url);

  await expect.poll(() => commandSize(reopened)).toBe(size);
  await openSettings(reopened);
  await expect(widthInput(reopened)).toHaveValue("1900");
  await expect(heightInput(reopened)).toHaveValue("400");
});

test("下限は 0〜1920 × 0〜1080 の整数だけを受け付け、範囲外の値は反映しない", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });
  const page = await openAsParticipant(browser, accompany.url);
  await expect.poll(() => scrollable(page)).toEqual({ x: false, y: true });
  const before = await commandSize(page);

  await setMinWindow(page, { width: 2000, height: -1 });

  // 入力欄は使っている値に戻り、端末の大きさも変わらない
  await expect(widthInput(page)).toHaveValue("480");
  await expect(heightInput(page)).toHaveValue("1080");

  // 改造したブラウザなどから、範囲外の値が直接届いたときも反映しない
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/workspace`);
        socket.onopen = () => {
          for (const [width, height] of [
            [3000, 1080],
            [480, -1],
            [480.5, 1080],
          ]) {
            socket.send(JSON.stringify({ type: "set-min-window", width, height }));
          }
          resolve();
        };
      }),
  );
  await page.waitForTimeout(500);
  expect(await commandSize(page)).toBe(before);
  await expect(widthInput(page)).toHaveValue("480");
  await expect(heightInput(page)).toHaveValue("1080");
});
