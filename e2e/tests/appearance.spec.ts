import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { terminalScreen } from "./terminal";

// 端末の大きさを表示し続ける偽のエージェント
const sizeReporter = ["--", "bun", "e2e/fixtures/size-reporter.ts"];
const viewport = { width: 1280, height: 720 };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  await expect(terminalScreen(page)).toContainText("size:");
  return page;
}

// 表示の設定は、ツールバーのボタンで開く
async function openSettings(page: Page) {
  const dialog = page.getByRole("dialog", { name: "表示の設定" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "表示の設定" }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseTheme(page: Page, theme: string) {
  const dialog = await openSettings(page);
  await dialog.getByLabel("配色").selectOption({ label: theme });
}

async function setFontSize(page: Page, size: number) {
  const dialog = await openSettings(page);
  await dialog.getByLabel("フォントの大きさ").fill(String(size));
}

// ターミナルの背景色と文字色（[r, g, b]）。背景色は、端末の画面から外側へたどって最初に色の付いた要素のもの
async function terminalColors(page: Page) {
  return page.evaluate(() => {
    const rgb = (color: string) => (color.match(/[\d.]+/g) ?? []).map(Number);
    let element: Element | null = document.querySelector(".xterm-screen");
    let background = "";
    while (element) {
      background = getComputedStyle(element).backgroundColor;
      if (rgb(background)[3] !== 0) break;
      element = element.parentElement;
    }
    const foreground = getComputedStyle(document.querySelector(".xterm-rows")!).color;
    return { background: rgb(background).slice(0, 3), foreground: rgb(foreground).slice(0, 3) };
  });
}

// 相対輝度（0 が黒、1 が白）とコントラスト比（WCAG の定義）
function luminance([r, g, b]: number[]) {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
}

function contrast(a: number[], b: number[]) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

async function fontSizeOf(page: Page) {
  return page.locator(".xterm-rows").evaluate((element) => getComputedStyle(element).fontSize);
}

// コマンドから見えている端末のサイズ（偽のエージェントが最後に表示したもの）
async function commandSize(page: Page) {
  const sizes = [...((await terminalScreen(page).textContent()) ?? "").matchAll(/size: (\d+)x(\d+)/g)];
  const last = sizes.at(-1);
  return last ? { cols: Number(last[1]), rows: Number(last[2]) } : undefined;
}

test("配色を「明るい」にすると、自分のターミナルだけが明るい背景に暗い文字になる", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  const before = await terminalColors(host);
  // 既定は暗い配色
  expect(luminance(before.background)).toBeLessThan(0.1);

  await chooseTheme(host, "明るい");

  await expect.poll(async () => luminance((await terminalColors(host)).background)).toBeGreaterThan(0.8);
  expect(luminance((await terminalColors(host)).foreground)).toBeLessThan(0.2);
  // ほかの参加者の見え方は変わらない
  expect(await terminalColors(guest)).toEqual(before);
});

test("配色を「見やすさ重視」にすると、背景と文字のコントラストが既定より強くなる", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const page = await openAsParticipant(browser, accompany.url);
  const before = await terminalColors(page);

  await chooseTheme(page, "見やすさ重視");

  await expect
    .poll(async () => {
      const after = await terminalColors(page);
      return contrast(after.background, after.foreground);
    })
    .toBeGreaterThan(contrast(before.background, before.foreground));
  const after = await terminalColors(page);
  // WCAG の AAA（7:1）を満たす
  expect(contrast(after.background, after.foreground)).toBeGreaterThanOrEqual(7);
});

test("フォントの大きさを変えると、ターミナルの文字が大きくなる", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const page = await openAsParticipant(browser, accompany.url);
  const rowHeight = async () => (await page.locator(".xterm-rows > div").first().boundingBox())!.height;
  const before = await rowHeight();

  await setFontSize(page, 24);

  await expect.poll(() => fontSizeOf(page)).toBe("24px");
  expect(await rowHeight()).toBeGreaterThan(before);
});

test("配色とフォントの大きさは、次に開いたときも使われる", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const page = await openAsParticipant(browser, accompany.url);
  await chooseTheme(page, "明るい");
  await setFontSize(page, 20);
  await expect.poll(() => fontSizeOf(page)).toBe("20px");
  const colors = await terminalColors(page);

  await page.reload();
  await expect(terminalScreen(page)).toContainText("size:");

  await expect.poll(() => fontSizeOf(page)).toBe("20px");
  expect(await terminalColors(page)).toEqual(colors);
  // 設定の画面にも、保存した値が出ている
  const dialog = await openSettings(page);
  await expect(dialog.getByLabel("配色")).toHaveValue("light");
  await expect(dialog.getByLabel("フォントの大きさ")).toHaveValue("20");
});

test("保存した設定が読めないときは、既定の見え方で開く", async ({ browser }) => {
  accompany = await startAccompany(sizeReporter);
  const reference = await openAsParticipant(browser, accompany.url);
  const defaults = { colors: await terminalColors(reference), fontSize: await fontSizeOf(reference) };

  const context = await newContext(browser, { viewport });
  await context.addInitScript(() => localStorage.setItem("accompany.appearance", "{壊れた値"));
  const page = await context.newPage();
  await page.goto(accompany.url);
  await expect(terminalScreen(page)).toContainText("size:");

  expect(await terminalColors(page)).toEqual(defaults.colors);
  expect(await fontSizeOf(page)).toBe(defaults.fontSize);
});

test("フォントを大きくすると、自分の表示領域に収まる列数・行数が小さくなり、ほかの参加者の端末もその大きさになって、周りが余白になる", async ({
  browser,
}) => {
  accompany = await startAccompany(sizeReporter);
  const host = await openAsParticipant(browser, accompany.url);
  await expect.poll(async () => (await commandSize(host))?.cols).not.toBe(80);
  const before = (await commandSize(host))!;

  // 1 人のときは、大きくした人の表示領域に合わせて端末が小さくなる
  await setFontSize(host, 30);

  await expect.poll(async () => (await commandSize(host))?.cols).toBeLessThan(before.cols);
  const after = (await commandSize(host))!;
  expect(after.rows).toBeLessThan(before.rows);
  // 大きくした人の画面から、端末がはみ出していない
  const box = (await host.locator(".xterm-screen").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

  // フォントが既定の大きさの参加者が入っても、端末は一番小さい表示領域（大きくした人）に合わせたまま
  const guest = await openAsParticipant(browser, accompany.url);

  await expect.poll(() => commandSize(guest)).toEqual(after);
  await guest.waitForTimeout(500);
  expect(await commandSize(host)).toEqual(after);
  await expect(guest.locator(".xterm-rows > div")).toHaveCount(after.rows);
  // フォントの大きさはそれぞれのまま。どちらもはみ出さず、既定の大きさの人は端末の周りが余白になる
  expect(await fontSizeOf(host)).toBe("30px");
  expect(await fontSizeOf(guest)).not.toBe("30px");
  for (const page of [host, guest]) {
    expect(
      await page.locator(".pane-terminal").evaluate((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight),
    ).toBe(false);
  }
});
