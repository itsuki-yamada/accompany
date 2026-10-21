import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { pane, panes } from "./panes";
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

  // 下限より幅が広く高さが低い人は、横は端末の周りが余白になる。縦は、参加者のうち一番高い quarter の画面に入る行数
  // （= 下限）になるので、それより低い人は縦にスクロールして見る
  const largePage = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(largePage)).toBe(size);
  expect(await scrollable(largePage)).toEqual({ x: false, y: true });
});

test("1 人で使うときは、画面が下限より小さくても、端末は自分の画面に合わせ、はみ出さない", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });

  const page = await openAsParticipant(browser, accompany.url, large);

  await expect.poll(() => commandSize(page)).not.toBe("80x24");
  await page.waitForTimeout(500);
  expect(await scrollable(page)).toEqual({ x: false, y: false });
});

test("1 人で分割しても、端末はそれぞれの枠に合わせ、自動で拡大しない", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, { SHELL: "e2e/fixtures/size-shell" }, { minWindow: null });
  const page = await openAsParticipant(browser, accompany.url, { width: 1920, height: 1080 });

  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();
  await expect(panes(page)).toHaveCount(2);
  await pane(page, 2).locator(".xterm-helper-textarea").focus();

  await page.waitForTimeout(500);
  await expect(page.getByText("拡大中")).toBeHidden();
  for (const n of [1, 2]) {
    expect(
      await pane(page, n)
        .locator(".pane-terminal")
        .evaluate((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight),
    ).toBe(false);
  }
});

test("全員の画面が下限より小さいときは、一番大きい人の画面に合わせ、その人ははみ出さない", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });
  // どちらも、下限（高さ 1080 のウィンドウ）より低い
  const { page: macbook, size: macbookAlone } = await sizeAlone(browser, accompany.url, { width: 1440, height: 900 });

  const smaller = await openAsParticipant(browser, accompany.url, large);

  // 行数は一番高い人の画面に入る大きさまで。列数は、下限（幅 480）より広い人どうしなので、狭いほうに合わせる
  await expect.poll(async () => parse(await commandSize(smaller)).cols).toBeLessThan(parse(macbookAlone).cols);
  await expect.poll(async () => parse(await commandSize(macbook)).rows).toBe(parse(macbookAlone).rows);
  await expect.poll(async () => (await commandSize(macbook)) === (await commandSize(smaller))).toBe(true);
  await expect.poll(() => scrollable(macbook)).toEqual({ x: false, y: false });
  // 低い人は、縦にはみ出した部分をスクロールして見る
  await expect.poll(() => scrollable(smaller)).toEqual({ x: false, y: true });
});

test("下限を変えると、参加者全員の端末の大きさが変わり、ほかの参加者の設定の画面にも出る", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });
  const host = await openAsParticipant(browser, accompany.url, large);
  const guest = await openAsParticipant(browser, accompany.url, narrow);
  // 既定の下限（480×1080）は、画面の狭い guest より縦横とも大きいので、guest ははみ出す
  await expect.poll(() => scrollable(guest)).toEqual({ x: true, y: true });
  expect(await scrollable(host)).toEqual({ x: false, y: false });
  const before = parse(await commandSize(host));

  // 下げると、guest の画面に合わせた大きさになり、guest もはみ出さなくなる
  await setMinWindow(host, { width: 0, height: 0 });

  await expect.poll(async () => parse(await commandSize(host)).rows).toBeLessThan(before.rows);
  await expect.poll(() => scrollable(guest)).toEqual({ x: false, y: false });
  await expect.poll(async () => (await commandSize(guest)) === (await commandSize(host))).toBe(true);
  const fitted = parse(await commandSize(host));
  expect(fitted.cols).toBeLessThan(before.cols);
  await closeSettings(host);
  await openSettings(guest);
  await expect(widthInput(guest)).toHaveValue("0");
  await expect(heightInput(guest)).toHaveValue("0");

  // 一番大きい人の画面より大きくしても、端末はその人の画面に入る大きさまで
  await setMinWindow(guest, { width: 1920, height: 1080 });

  await expect.poll(async () => parse(await commandSize(host)).cols).toBeGreaterThan(fitted.cols);
  await expect.poll(() => scrollable(host)).toEqual({ x: false, y: false });
  await expect.poll(() => scrollable(guest)).toEqual({ x: true, y: true });
  await closeSettings(guest);
  await openSettings(host);
  await expect(widthInput(host)).toHaveValue("1920");
});

// サーバーが配った下限が、ほかの参加者（observer）の設定の画面に出るのを待つ。止める前に、変えた下限がサーバーに
// 届いたことを確かめるため（幅と高さは 1 つずつ送るので、届く前に止めると、途中の値で保存される）
async function expectMinWindowShown(observer: Page, width: number, height: number) {
  await openSettings(observer);
  await expect(widthInput(observer)).toHaveValue(String(width));
  await expect(heightInput(observer)).toHaveValue(String(height));
  await closeSettings(observer);
}

// 画面の大きい人と狭い人が参加したときの端末の大きさ
async function sizeWithLargeAndNarrow(browser: Browser, url: string) {
  const largePage = await openAsParticipant(browser, url, large);
  const narrowPage = await openAsParticipant(browser, url, narrow);
  await expect.poll(async () => (await commandSize(largePage)) === (await commandSize(narrowPage))).toBe(true);
  await largePage.waitForTimeout(500);
  return { largePage, narrowPage, size: await commandSize(largePage) };
}

test("下限は保存し、再起動しても残る", async ({ browser }) => {
  const env = { ACCOMPANY_STATE_DIR: newStateDir() };
  accompany = await startAccompany(sizeReporter, env, { minWindow: null });
  const { largePage, narrowPage, size: defaultSize } = await sizeWithLargeAndNarrow(browser, accompany.url);
  await setMinWindow(largePage, { width: 1000, height: 600 });
  await expectMinWindowShown(narrowPage, 1000, 600);
  await expect.poll(() => commandSize(largePage)).not.toBe(defaultSize);
  const { size } = await sizeWithLargeAndNarrow(browser, accompany.url);
  await closeContexts();
  await accompany.stop();

  accompany = await startAccompany(sizeReporter, env, { minWindow: null });
  const reopened = await sizeWithLargeAndNarrow(browser, accompany.url);

  expect(reopened.size).toBe(size);
  await openSettings(reopened.largePage);
  await expect(widthInput(reopened.largePage)).toHaveValue("1000");
  await expect(heightInput(reopened.largePage)).toHaveValue("600");
});

test("起動オプションで渡した下限は、その起動のあいだだけ使い、保存した下限は変えない", async ({ browser }) => {
  const env = { ACCOMPANY_STATE_DIR: newStateDir() };
  accompany = await startAccompany(sizeReporter, env, { minWindow: null });
  const page = await openAsParticipant(browser, accompany.url);
  const observer = await openAsParticipant(browser, accompany.url);
  await setMinWindow(page, { width: 1000, height: 600 });
  await expectMinWindowShown(observer, 1000, 600);
  await closeContexts();
  await accompany.stop();

  accompany = await startAccompany(sizeReporter, env, { minWindow: "300x200" });
  const withOption = await openAsParticipant(browser, accompany.url);
  await openSettings(withOption);
  await expect(widthInput(withOption)).toHaveValue("300");
  await expect(heightInput(withOption)).toHaveValue("200");
  // 画面の配置などは保存する
  await withOption.waitForTimeout(1500);
  await closeContexts();
  await accompany.stop();

  accompany = await startAccompany(sizeReporter, env, { minWindow: null });
  const reopened = await openAsParticipant(browser, accompany.url);
  await openSettings(reopened);
  await expect(widthInput(reopened)).toHaveValue("1000");
  await expect(heightInput(reopened)).toHaveValue("600");
});

test("下限は 0〜1920 × 0〜1080 の整数だけを受け付け、範囲外の値は反映しない", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter, {}, { minWindow: null });
  const page = await openAsParticipant(browser, accompany.url);
  await expect.poll(() => commandSize(page)).not.toBe("80x24");
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
