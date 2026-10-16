import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { terminalScreen } from "./terminal";

// 端末のサイズを左上に、目印の言葉と URL を右下の隅に表示し続ける偽のエージェント
const cornerReporter = ["--", "bun", "e2e/fixtures/corner-reporter.ts"];
const corner = "corner-word https://example.com/corner";
const large = { width: 1280, height: 720 };
const small = { width: 640, height: 400 };
// フル HD より大きい画面
const huge = { width: 2560, height: 1440 };
const clipboard = ["clipboard-read", "clipboard-write"];

let accompany: Accompany | undefined;
let tmp: string | undefined;

test.afterEach(async () => {
  await accompany?.stop();
  accompany = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function openAsParticipant(
  browser: Browser,
  url: string,
  viewport: typeof large,
  permissions: string[] = [],
) {
  const context = await browser.newContext({ viewport, permissions });
  const page = await context.newPage();
  await page.goto(url);
  await expect(terminalScreen(page)).toContainText("size:");
  await expect(terminalScreen(page)).toContainText("corner-word");
  return page;
}

// コマンドから見えている端末のサイズ（偽のエージェントが最後に表示したもの）
async function commandSize(page: Page) {
  const sizes = [...((await terminalScreen(page).textContent()) ?? "").matchAll(/size: (\d+)x(\d+)/g)];
  const last = sizes.at(-1);
  return last ? `${last[1]}x${last[2]}` : "";
}

function parse(size: string) {
  const [cols, rows] = size.split("x").map(Number);
  return { cols: cols!, rows: rows! };
}

// ターミナルの表示領域が、はみ出した端末をスクロールして見せているか（both: 縦横の両方。any: どちらか）
function scrollable(page: Page, how: "both" | "any" = "both") {
  return page.locator(".pane-terminal").evaluate((e, how) => {
    const [x, y] = [e.scrollWidth > e.clientWidth, e.scrollHeight > e.clientHeight];
    return how === "both" ? x && y : x || y;
  }, how);
}

async function scrollTo(page: Page, where: "start" | "end") {
  await page.locator(".pane-terminal").evaluate((e, where) => {
    e.scrollTo(where === "end" ? { left: e.scrollWidth, top: e.scrollHeight } : { left: 0, top: 0 });
  }, where);
}

async function fontSizeOf(page: Page) {
  return page.locator(".xterm-rows").evaluate((element) => getComputedStyle(element).fontSize);
}

// 右下の隅に出ている目印の、index 文字目の中央の位置。端末の画面の大きさと列数・行数から 1 文字の大きさを求める
async function cornerPoint(page: Page, index: number) {
  const { cols, rows } = parse(await commandSize(page));
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  const cell = { width: box.width / cols, height: box.height / rows };
  const col = cols - corner.length - 1 + index;
  return { x: box.x + (col + 0.5) * cell.width, y: box.y + (rows - 0.5) * cell.height };
}

// その位置が、ターミナルの表示領域の中で見えているか（スクロールで隠れていないか）
async function isVisible(page: Page, point: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const area = document.querySelector(".pane-terminal")!.getBoundingClientRect();
    const inArea = x >= area.left && x < area.right && y >= area.top && y < area.bottom;
    return inArea && !!document.elementFromPoint(x, y)?.closest(".xterm-screen");
  }, point);
}

// 端末がブラウザの画面からはみ出していないか
async function expectTerminalToFitIn(page: Page) {
  const viewport = page.viewportSize()!;
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

// 表示の設定で、端末が画面より大きいときの見せ方を選ぶ
async function chooseOverflow(page: Page, label: string) {
  const dialog = page.getByRole("dialog", { name: "表示の設定" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "表示の設定" }).click();
  await dialog.getByLabel("端末が画面より大きいとき").selectOption({ label });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

// 画面の大きい人（host）と小さい人（guest）が参加している状態にする
async function openLargeAndSmall(browser: Browser, permissions: string[] = []) {
  accompany = await startAccompany(cornerReporter);
  const host = await openAsParticipant(browser, accompany.url, large, permissions);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const size = await commandSize(host);
  const guest = await openAsParticipant(browser, accompany.url, small, permissions);
  await expect.poll(() => scrollable(guest)).toBe(true);
  return { host, guest, size };
}

// 出力の URL は、マウスが乗ってリンクと判定されてからクリックする
async function clickLink(page: Page, point: { x: number; y: number }) {
  await page.context().route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>example</title>" }),
  );
  await expect(async () => {
    await page.mouse.move(point.x - 1, point.y);
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".xterm-screen.xterm-cursor-pointer")).toBeVisible({ timeout: 500 });
  }).toPass();
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.mouse.click(point.x, point.y)]);
  await expect(popup).toHaveURL("https://example.com/corner");
}

// 単語をダブルクリックで選び、右クリックのメニューからコピーして、コピーした文字を返す
async function copyWordAt(page: Page, point: { x: number; y: number }) {
  const scroll = () => page.locator(".pane-terminal").evaluate((e) => [e.scrollLeft, e.scrollTop]);
  const before = await scroll();
  await page.mouse.dblclick(point.x, point.y);
  // 選んでも、見ている位置は動かない
  expect(await scroll()).toEqual(before);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "コピー" }).click();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("1 人で開くと、端末がブラウザの画面いっぱいの大きさになる", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);

  const host = await openAsParticipant(browser, accompany.url, large);

  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  await expectTerminalToFitIn(host);
  const box = (await host.locator(".xterm-screen").boundingBox())!;
  expect(box.width).toBeGreaterThan(large.width * 0.9);
  expect(box.height).toBeGreaterThan(large.height * 0.9);
  expect(await scrollable(host)).toBe(false);
});

test("画面の小さい人が参加しても端末の大きさは変わらず、その人は文字の大きさはそのままでスクロールして全体を見られる", async ({
  browser,
}) => {
  const { host, guest, size } = await openLargeAndSmall(browser);

  // 端末の大きさは、画面の大きい人に合わせたまま
  expect(await commandSize(guest)).toBe(size);
  expect(await commandSize(host)).toBe(size);
  await expect(guest.locator(".xterm-rows > div")).toHaveCount(parse(size).rows);
  // 文字の大きさは同じ
  expect(await fontSizeOf(guest)).toBe(await fontSizeOf(host));
  // 右下の隅は、スクロールすると見える
  expect(await isVisible(guest, await cornerPoint(guest, 0))).toBe(false);
  await scrollTo(guest, "end");
  expect(await isVisible(guest, await cornerPoint(guest, 0))).toBe(true);
  expect(await isVisible(guest, await cornerPoint(guest, corner.length - 1))).toBe(true);
});

test("画面の大きい人が参加すると、全員の端末がその人の画面に合わせて大きくなる", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const host = await openAsParticipant(browser, accompany.url, small);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const hostAlone = parse(await commandSize(host));
  expect(await scrollable(host)).toBe(false);

  const guest = await openAsParticipant(browser, accompany.url, large);

  await expect.poll(async () => parse(await commandSize(guest)).cols).toBeGreaterThan(hostAlone.cols);
  const shared = await commandSize(guest);
  expect(parse(shared).rows).toBeGreaterThan(hostAlone.rows);
  await expect.poll(() => commandSize(host)).toBe(shared);
  await expectTerminalToFitIn(guest);
  // 2 人とも同じ行数の端末を描き、画面の小さい人はスクロールして見る
  await expect(host.locator(".xterm-rows > div")).toHaveCount(parse(shared).rows);
  await expect(guest.locator(".xterm-rows > div")).toHaveCount(parse(shared).rows);
  await expect.poll(() => scrollable(host)).toBe(true);
});

test("画面の大きい人が抜けると、残った人の画面に合わせた大きさに戻る", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const host = await openAsParticipant(browser, accompany.url, small);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const hostAlone = await commandSize(host);
  const guest = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(host)).not.toBe(hostAlone);

  await guest.context().close();

  await expect.poll(() => commandSize(host)).toBe(hostAlone);
  await expect.poll(() => scrollable(host)).toBe(false);
});

test("ブラウザのウィンドウの大きさを変えると、端末の大きさも合わせて変わる", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const host = await openAsParticipant(browser, accompany.url, large);
  await expect.poll(() => commandSize(host)).not.toBe("80x24");
  const before = await commandSize(host);

  await host.setViewportSize(small);

  await expect.poll(() => commandSize(host)).not.toBe(before);
  await expectTerminalToFitIn(host);
});

test("フル HD より大きい画面では、端末はフル HD の大きさまでにして、残りは余白にする", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);

  const page = await openAsParticipant(browser, accompany.url, huge);

  await expect.poll(() => commandSize(page)).not.toBe("80x24");
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(1920);
  expect(box.height).toBeLessThanOrEqual(1080);
  // フル HD 近くまでは使う
  expect(box.width).toBeGreaterThan(1920 * 0.9);
  expect(box.height).toBeGreaterThan(1080 * 0.9);
  expect(await scrollable(page)).toBe(false);
});

test("「画面に収める（縮小）」にすると、端末の大きさは変えずに、自分の画面だけ縮小して全体を表示する", async ({
  browser,
}) => {
  const { host, guest, size } = await openLargeAndSmall(browser);
  const fontSize = await fontSizeOf(guest);
  await scrollTo(guest, "end");

  await chooseOverflow(guest, "画面に収める（縮小）");

  await expect.poll(() => scrollable(guest, "any")).toBe(false);
  await expectTerminalToFitIn(guest);
  expect(Number.parseFloat(await fontSizeOf(guest))).toBeLessThan(Number.parseFloat(fontSize));
  expect(await isVisible(guest, await cornerPoint(guest, corner.length - 1))).toBe(true);
  // 端末の大きさも、ほかの参加者の見え方も変わらない
  expect(await commandSize(guest)).toBe(size);
  expect(await commandSize(host)).toBe(size);
  expect(await fontSizeOf(host)).toBe(fontSize);

  // 設定はこのブラウザに保存され、次に開いたときも使われる
  await guest.reload();
  await expect(terminalScreen(guest)).toContainText("corner-word");
  await expect.poll(() => fontSizeOf(guest)).not.toBe(fontSize);
  expect(await scrollable(guest)).toBe(false);

  // スクロールに戻すと、元の文字の大きさで描く
  await chooseOverflow(guest, "スクロールして見る");

  await expect.poll(() => fontSizeOf(guest)).toBe(fontSize);
  await expect.poll(() => scrollable(guest)).toBe(true);
  expect(await commandSize(host)).toBe(size);
});

test.describe("スクロールした位置でも、マウスの位置どおりに操作できる", () => {
  test("単語の選択と、右クリックのメニューからのコピー", async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser, clipboard);
    await scrollTo(guest, "end");

    expect(await copyWordAt(guest, await cornerPoint(guest, 2))).toBe("corner-word");
  });

  test("右クリックのメニューは、右クリックした位置に出る", async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser);
    await scrollTo(guest, "end");
    const area = (await guest.locator(".pane-terminal").boundingBox())!;
    const point = { x: area.x + area.width / 3, y: area.y + area.height / 3 };

    await guest.mouse.click(point.x, point.y, { button: "right" });

    const box = (await guest.getByRole("menu").boundingBox())!;
    expect(Math.abs(box.x - point.x)).toBeLessThan(2);
    expect(Math.abs(box.y - point.y)).toBeLessThan(2);
  });

  test("URL のクリック", async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser);
    await scrollTo(guest, "end");

    await clickLink(guest, await cornerPoint(guest, corner.indexOf("https://") + 5));
  });

  test("入力", async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser);
    await scrollTo(guest, "end");
    const point = await cornerPoint(guest, 0);
    await guest.mouse.click(point.x, point.y);

    await guest.keyboard.type("typed-while-scrolled");

    await expect(terminalScreen(guest)).toContainText("typed-while-scrolled");
  });

  test("ファイルのドロップ", async ({ browser }) => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "accompany-e2e-")));
    accompany = await startAccompany(cornerReporter, { TMPDIR: tmp });
    await openAsParticipant(browser, accompany.url, large);
    const guest = await openAsParticipant(browser, accompany.url, small);
    await expect.poll(() => scrollable(guest)).toBe(true);
    await scrollTo(guest, "end");

    const target = guest.locator(".xterm-screen");
    const dataTransfer = await guest.evaluateHandle(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["png"], "dropped.png"));
      return dataTransfer;
    });
    await target.dispatchEvent("dragenter", { dataTransfer });
    await target.dispatchEvent("dragover", { dataTransfer });
    await target.dispatchEvent("drop", { dataTransfer });

    await expect(terminalScreen(guest)).toContainText("dropped.png");
  });

  test("検索で見つけた文字が、スクロールして見える位置に出る", async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser);
    await scrollTo(guest, "start");
    expect(await isVisible(guest, await cornerPoint(guest, 0))).toBe(false);

    await guest.getByRole("button", { name: "検索" }).click();
    await guest.getByRole("textbox", { name: "検索する文字" }).fill("corner-word");

    await expect.poll(async () => isVisible(guest, await cornerPoint(guest, 0))).toBe(true);
    expect(await isVisible(guest, await cornerPoint(guest, "corner-word".length - 1))).toBe(true);
  });

  test("縮小して表示しているときの、単語の選択と URL のクリック", async ({ browser }) => {
    const { guest } = await openLargeAndSmall(browser, clipboard);
    await chooseOverflow(guest, "画面に収める（縮小）");
    await expect.poll(() => scrollable(guest)).toBe(false);

    expect(await copyWordAt(guest, await cornerPoint(guest, 2))).toBe("corner-word");
    await guest.keyboard.press("Escape");
    await clickLink(guest, await cornerPoint(guest, corner.indexOf("https://") + 5));
  });
});
