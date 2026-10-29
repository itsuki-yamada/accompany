import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { terminalScreen } from "./terminal";

// 端末のサイズを左上に、目印の言葉と URL を右下の隅に表示し続ける偽のエージェント
const cornerReporter = ["--", "bun", "e2e/fixtures/corner-reporter.ts"];
const corner = "corner-word https://example.com/corner";
// 起動した時点の端末のサイズを一度だけ表示する偽のエージェント
const startSizeReporter = ["--", "bun", "e2e/fixtures/start-size-reporter.ts"];
const large = { width: 1280, height: 720 };
const small = { width: 640, height: 400 };
// フル HD より大きい画面
const huge = { width: 2560, height: 1440 };
const clipboard = ["clipboard-read", "clipboard-write"];

let accompany: Accompany | undefined;
let tmp: string | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

// 下限より画面の小さい人がはみ出した部分をどう見るかを確かめるときの、端末の大きさの下限（ウィンドウの大きさ）。
// 画面の大きい人（large）より小さく、小さい人（small）より縦横とも大きい
const minWindow = "1000x600";

// ページが見えているかどうか（document.hidden）を、テストから切り替えられるようにする
async function openAsParticipant(
  browser: Browser,
  url: string,
  viewport: typeof large,
  permissions: string[] = [],
) {
  const context = await newContext(browser, { viewport, permissions });
  await context.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
    (window as any).setHidden = (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
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

// 偽のエージェントが、条件に合うサイズを描き終えるのを待って、そのサイズを返す（既定は、起動時の 80x24 から変わったもの）。
// 端末の大きさが変わってから描き直すまでの間は、サイズが画面にないことがある。行が減ると、xterm は
// カーソルのある最後の行を残して上の行をスクロールバックに送るので、左上のサイズの行が見えなくなる
async function waitForSize(page: Page, accept: (size: string) => boolean = (size) => size !== "80x24") {
  // 落ちたときに、最後に読んだサイズがメッセージに出るようにする（待つ時間は expect.poll の既定と同じ 5 秒）
  let size = "";
  await expect(async () => {
    size = await commandSize(page);
    expect(size !== "" && accept(size), `最後に読んだサイズ: "${size}"`).toBe(true);
  }).toPass({ timeout: 5_000 });
  return size;
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

// 端末の周りの余白が、ターミナルの背景色で塗られているか（表示領域の右下の隅の色が、端末の背景色と同じか）
async function marginColor(page: Page) {
  return page.locator(".pane-terminal").evaluate((e) => getComputedStyle(e).backgroundColor);
}

async function terminalBackground(page: Page) {
  return page.locator(".xterm-viewport").evaluate((e) => getComputedStyle(e).backgroundColor);
}

// 画面の大きい人（host）と、下限より画面の小さい人（guest）が参加している状態にする。
// 端末の大きさは下限（minWindow）のウィンドウに収まる大きさになり、host の画面には収まり、guest の画面からははみ出す
async function openLargeAndSmall(browser: Browser, permissions: string[] = []) {
  accompany = await startAccompany(cornerReporter, {}, { minWindow });
  const { page: host, size: hostAlone } = await sizeAlone(browser, accompany.url, large, permissions);
  const guest = await openAsParticipant(browser, accompany.url, small, permissions);
  const size = await waitForSize(host, (size) => size !== hostAlone);
  await waitForSize(guest, (s) => s === size);
  await expect.poll(() => scrollable(guest)).toBe(true);
  expect(await scrollable(host, "any")).toBe(false);
  return { host, guest, size };
}

// 1 人で開いたときの端末の大きさ（自分の画面に合わせた大きさ）
async function sizeAlone(browser: Browser, url: string, viewport: typeof large, permissions: string[] = []) {
  const page = await openAsParticipant(browser, url, viewport, permissions);
  return { page, size: await waitForSize(page) };
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
  await menu.getByRole("menuitem", { name: "コピー", exact: true }).click();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("1 人で開くと、端末がブラウザの画面いっぱいの大きさになる", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);

  const host = await openAsParticipant(browser, accompany.url, large);

  await waitForSize(host);
  await expectTerminalToFitIn(host);
  // 画面いっぱい = サイドメニューとツールバーを除いた、ターミナルを並べる領域いっぱい
  const area = (await host.getByRole("main").boundingBox())!;
  const box = (await host.locator(".xterm-screen").boundingBox())!;
  expect(box.width).toBeGreaterThan(area.width * 0.9);
  expect(box.height).toBeGreaterThan(area.height * 0.9);
  expect(await scrollable(host)).toBe(false);
});

test("最初に参加した人の画面の大きさで、コマンドを起動する", async ({ browser }) => {
  accompany = await startAccompany(startSizeReporter);
  const context = await newContext(browser, { viewport: large });
  // ブラウザがターミナルの WebSocket で最初に伝えた大きさを覚えておく。ネットワークやブラウザが遅いときのように、
  // 大きさは少し遅らせて（順番は変えずに）届ける。コマンドの起動が速くても、起動した時点の大きさを確かめられるようにする
  await context.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
      const message = typeof data === "string" ? JSON.parse(data) : undefined;
      if (!this.url.includes("/ws/terminals/") || message?.type !== "resize") return send.call(this, data);
      const w = window as any;
      w.firstSize ??= `${message.cols}x${message.rows}`;
      setTimeout(() => send.call(this, data), 500);
    };
  });
  const host = await context.newPage();
  await host.goto(accompany.url);

  await expect(terminalScreen(host)).toContainText("start size:");
  const started = /start size: (\d+x\d+)/.exec((await terminalScreen(host).textContent()) ?? "")?.[1];
  const firstSize = await host.evaluate(() => (window as any).firstSize);
  expect(firstSize).not.toBe("80x24");
  // 起動したあとの大きさの変更（SIGWINCH）に頼らず、起動した時点で参加者の画面の大きさになっている
  expect(started).toBe(firstSize);
});

test("大きさを伝えない参加者しかいなくても、コマンドを起動する", async ({ browser }) => {
  accompany = await startAccompany(startSizeReporter);
  // ターミナルを開かない、同じオリジンのページから接続し、大きさを伝えずに出力を待つ
  const page = await (await newContext(browser)).newPage();
  await page.goto(`${accompany.url}/not-found`);

  const output = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        let text = "";
        const decoder = new TextDecoder();
        const socket = new WebSocket(`ws://${location.host}/ws/terminals/1`);
        socket.binaryType = "arraybuffer";
        socket.onmessage = (event) => {
          if (typeof event.data === "string") return;
          text += decoder.decode(event.data, { stream: true });
          if (text.includes("start size:")) resolve(text);
        };
      }),
  );
  // 大きさが分からないので、これまでどおりの大きさで起動する
  expect(output).toContain("start size: 80x24");
});

test("画面の小さい人が参加すると、全員の端末がその人の画面に合わせて小さくなり、画面の大きい人は端末の周りが余白になる", async ({
  browser,
}) => {
  accompany = await startAccompany(cornerReporter);
  const { page: host, size: hostAlone } = await sizeAlone(browser, accompany.url, large);

  const guest = await openAsParticipant(browser, accompany.url, small);

  // 端末の大きさは、画面の小さい人に合わせる
  const shared = await waitForSize(host, (size) => parse(size).cols < parse(hostAlone).cols);
  expect(parse(shared).rows).toBeLessThan(parse(hostAlone).rows);
  await waitForSize(guest, (size) => size === shared);
  // 画面の小さい人は、スクロールも縮小もせずに全体を見られる
  await expectTerminalToFitIn(guest);
  await expect.poll(() => scrollable(guest, "any")).toBe(false);
  expect(await isVisible(guest, await cornerPoint(guest, corner.length - 1))).toBe(true);
  // 画面の大きい人は、端末の周りが余白になるだけで、スクロールせずに全体を見られる。余白は端末の背景色で塗る
  await expect(host.locator(".xterm-rows > div")).toHaveCount(parse(shared).rows);
  expect(await scrollable(host, "any")).toBe(false);
  const area = (await host.locator(".pane-terminal").boundingBox())!;
  const box = (await host.locator(".xterm-screen").boundingBox())!;
  expect(box.width).toBeLessThan(area.width * 0.8);
  expect(box.height).toBeLessThan(area.height * 0.8);
  expect(Math.abs(box.x - area.x)).toBeLessThan(2);
  expect(Math.abs(box.y - area.y)).toBeLessThan(2);
  expect(await marginColor(host)).toBe(await terminalBackground(host));
  expect(await isVisible(host, await cornerPoint(host, corner.length - 1))).toBe(true);
  // 文字の大きさは同じ
  expect(await fontSizeOf(guest)).toBe(await fontSizeOf(host));
});

test("画面の大きい人が参加しても、端末の大きさは変わらない", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const { page: host, size: hostAlone } = await sizeAlone(browser, accompany.url, small);

  const guest = await openAsParticipant(browser, accompany.url, large);

  await waitForSize(guest, (size) => size === hostAlone);
  // 大きさが変わると、偽のエージェントが新しい大きさを表示する
  await guest.waitForTimeout(500);
  expect(await commandSize(host)).toBe(hostAlone);
  expect(await scrollable(host, "any")).toBe(false);
  expect(await scrollable(guest, "any")).toBe(false);
});

test("画面の小さい人が抜けると、残った人の画面に合わせた大きさに戻る", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const { page: host, size: hostAlone } = await sizeAlone(browser, accompany.url, large);
  const guest = await openAsParticipant(browser, accompany.url, small);
  await waitForSize(host, (size) => size !== hostAlone);

  await guest.context().close();

  await waitForSize(host, (size) => size === hostAlone);
});

test("ページを見ていない参加者の画面も含めて、一番小さい画面に合わせる", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const { page: guest, size: smallSize } = await sizeAlone(browser, accompany.url, small);
  // 画面の小さい人は、別のタブやウィンドウを見ていて、Accompany のページは見えていない
  await guest.evaluate(() => (window as any).setHidden(true));

  const host = await openAsParticipant(browser, accompany.url, large);

  await waitForSize(host, (size) => size === smallSize);
  await host.waitForTimeout(500);
  expect(await commandSize(host)).toBe(smallSize);
});

test("ブラウザのウィンドウの大きさを変えると、端末の大きさも合わせて変わる", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  const host = await openAsParticipant(browser, accompany.url, large);
  const before = await waitForSize(host);

  await host.setViewportSize(small);

  await waitForSize(host, (size) => size !== before);
  await expectTerminalToFitIn(host);
});

test("フル HD より大きい画面では、端末はフル HD の大きさまでにして、残りは余白にする", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);

  const page = await openAsParticipant(browser, accompany.url, huge);

  await waitForSize(page);
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(1920);
  expect(box.height).toBeLessThanOrEqual(1080);
  // フル HD 近くまでは使う
  expect(box.width).toBeGreaterThan(1920 * 0.9);
  expect(box.height).toBeGreaterThan(1080 * 0.9);
  expect(await scrollable(page)).toBe(false);
});

test("参加者が大きすぎる大きさを伝えても、端末は 512 列・256 行までにする", async ({ browser }) => {
  accompany = await startAccompany(cornerReporter);
  // 端末の大きさは一番小さい参加者に合わせるので、大きすぎる値を伝える参加者だけがつながっている状態にする。
  // ターミナルを開かない、同じオリジンのページから接続する
  const page = await (await newContext(browser)).newPage();
  await page.goto(`${accompany.url}/not-found`);

  // 改造したブラウザや、1 文字の大きさを小さく測る不具合などで、大きすぎる値が届いたとき
  await page.evaluate(() => {
    const w = window as any;
    w.sizes = [];
    const socket = new WebSocket(`ws://${location.host}/ws/terminals/1`);
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      if (message.type === "resize") w.sizes.push(`${message.cols}x${message.rows}`);
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: "resize", cols: 600, rows: 300 }));
  });

  await expect.poll(() => page.evaluate(() => (window as any).sizes.at(-1))).toBe("512x256");
});

test("下限より画面の小さい人は、文字の大きさはそのままで、はみ出した部分をスクロールして見る", async ({ browser }) => {
  const { host, guest, size } = await openLargeAndSmall(browser);

  await expect(guest.locator(".xterm-rows > div")).toHaveCount(parse(size).rows);
  expect(await scrollable(host, "any")).toBe(false);
  // 文字の大きさは同じ
  expect(await fontSizeOf(guest)).toBe(await fontSizeOf(host));
  // 右下の隅は、左上までスクロールしていると見えず、スクロールすると見える。開いたときは一番下にスクロールしているので
  // （docs/adr/116-overflow-scroll-bottom.md）、先に左上までスクロールする
  await scrollTo(guest, "start");
  expect(await isVisible(guest, await cornerPoint(guest, 0))).toBe(false);
  await scrollTo(guest, "end");
  expect(await isVisible(guest, await cornerPoint(guest, 0))).toBe(true);
  expect(await isVisible(guest, await cornerPoint(guest, corner.length - 1))).toBe(true);
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
    // メニューが画面の下にはみ出して上にずらされない高さで右クリックする
    const point = { x: area.x + area.width / 3, y: area.y + area.height / 5 };

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
    accompany = await startAccompany(cornerReporter, { TMPDIR: tmp }, { minWindow });
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
