import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

// URL の文字列を OSC 8 のハイパーリンクにした行と、ただの文字列の URL の行を出す
const linkOutput = ["--", "bun", "e2e/fixtures/link-output.ts"];

// 開く先は外部に出さず、Playwright がその場で返すページにする（.test は実在しないドメイン）
async function serveLinks(context: BrowserContext) {
  await context.route("http://link.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>link target</title>opened" }),
  );
}

async function open(page: Page, args: string[] = []) {
  await serveLinks(page.context());
  accompany = await startAccompany([...linkOutput, ...args]);
  await page.goto(accompany.url);
  await expectPaneToShow(page, 1, "Link output ready");
}

// 出力の行のうち、URL の文字の上をクリックする
async function clickUrl(page: Page, line: RegExp, url: string) {
  const row = pane(page, 1).locator(".xterm-rows > div").filter({ hasText: line }).last();
  // URL の中ほどの 1 文字の位置を、描画された文字から測る
  const at = await row.evaluate((element, url) => {
    const middle = (element.textContent ?? "").indexOf(url) + Math.floor(url.length / 2);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (middle < offset + length) {
        const range = document.createRange();
        range.setStart(node, middle - offset);
        range.setEnd(node, middle - offset + 1);
        const { x, y, width, height } = range.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      }
      offset += length;
    }
    throw new Error(`${url} が見つからない`);
  }, url);
  // リンクはマウスを乗せてから認識されるので、先に動かしてリンクの上になる（カーソルが指になる）のを待つ
  await page.mouse.move(at.x, at.y);
  await expect(pane(page, 1).locator(".xterm-cursor-pointer")).toBeAttached();
  await page.mouse.click(at.x, at.y);
}

// クリックで開いたページを集める。開いたページは、URL に移ったことを確かめてから返す
async function openedPages(page: Page, click: () => Promise<void>, url: string) {
  const opened: Page[] = [];
  const onPage = (p: Page) => opened.push(p);
  page.context().on("page", onPage);
  await click();
  await expect.poll(() => opened.length).toBeGreaterThanOrEqual(1);
  // 2 つ目が遅れて開くことがあるので、少し待ってから数える
  await page.waitForTimeout(1000);
  page.context().off("page", onPage);
  for (const p of opened) await expect(p).toHaveURL(url);
  return opened;
}

test("OSC 8 のハイパーリンクの URL をクリックすると、確認なしでページが 1 つだけ開く", async ({ page }) => {
  // 確認ダイアログが出たら受け入れて、開くページを数えられるようにする（出ないことは最後に確かめる）
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await open(page);

  const url = "http://link.test/osc8";
  const opened = await openedPages(page, () => clickUrl(page, /OSC 8:/, url), url);

  expect(opened).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test("ただの文字列の URL をクリックしても、ページが 1 つだけ開く", async ({ page }) => {
  await open(page);

  const url = "http://link.test/plain";
  const opened = await openedPages(page, () => clickUrl(page, /Plain:/, url), url);

  expect(opened).toHaveLength(1);
});

test("開いたページからは、元のページを操作できない（opener を切っている）", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await open(page);

  for (const [line, url] of [
    [/OSC 8:/, "http://link.test/osc8"],
    [/Plain:/, "http://link.test/plain"],
  ] as const) {
    const opened = await openedPages(page, () => clickUrl(page, line, url), url);
    for (const p of opened) {
      expect(await p.evaluate(() => window.opener)).toBeNull();
      await p.close();
    }
  }
});

// Claude Code（全画面の表示）はマウスの報告モードを有効にし、クリックを受け取るとその位置のリンクを自分でも開く。
// クリックがアプリにも届くと、ブラウザとアプリの両方で開いて二重になる（#59）
test("マウスの報告モードを有効にしたアプリでも、リンクのクリックはアプリに渡さず、ページを 1 つだけ開く", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await open(page, ["--mouse"]);

  for (const [line, url] of [
    [/OSC 8:/, "http://link.test/osc8"],
    [/Plain:/, "http://link.test/plain"],
  ] as const) {
    const opened = await openedPages(page, () => clickUrl(page, line, url), url);
    expect(opened).toHaveLength(1);
    for (const p of opened) await p.close();
  }

  // リンクのないところのクリックは、これまでどおりアプリに届く（SGR 形式の ESC [ < 0 ; ... の押す・離す）。
  // アプリは受け取った順に表示するので、これが出た時点で、リンクのクリックが届いていれば先に出ている
  // 10 行目をクリックし、その行の離す報告（; 1 0 m）が届くのを待つ。押す報告（; 1 0 M）とは別々に届くことがあるので、
  // 押す報告だけを待つと、離す報告が届く前に数えてしまう
  const box = (await pane(page, 1).locator(".xterm-rows > div").nth(9).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expectPaneToShow(page, 1, "3b 31 30 6d");
  // 届いたマウスの報告（ESC [ <）は、この 1 回のクリックの押す・離すの 2 つだけ
  const shown = (await pane(page, 1).locator(".xterm-rows").textContent()) ?? "";
  expect(shown.match(/1b 5b 3c/g)).toHaveLength(2);
});

test("マウスの報告モードを有効にしたアプリで、リンクをクリックして開いたタブを閉じたあとも、キー入力がアプリに届く", async ({ page }) => {
  await open(page, ["--mouse"]);

  const url = "http://link.test/plain";
  const opened = await openedPages(page, () => clickUrl(page, /Plain:/, url), url);
  for (const p of opened) await p.close();
  await page.bringToFront();

  await expect(pane(page, 1).locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("a");
  await expectPaneToShow(page, 1, "keys: 61");
});

// http・https 以外のリンクは xterm.js が先に捨てるので、いまは openLink に届かない（allowNonHttpProtocols を使っていない）。
// 設定の変更や xterm.js の更新で届くようになっても開かないことを確かめるため、ページの読み込み前に、
// xterm.js から linkHandler.allowNonHttpProtocols が有効に見えるようにする（本番の設定は変えない。docs/adr/61-link-scheme-check.md）
test("http・https 以外の URL や、URL として解釈できない文字列のリンクをクリックしても、何も開かず、スクリプトも動かない", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Object.prototype, "allowNonHttpProtocols", { get: () => true, configurable: true });
  });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await open(page, ["--unsafe"]);

  for (const [line, text] of [
    [/JS:/, "javascript-link"],
    [/Data:/, "data-link"],
    [/File:/, "file-link"],
    [/NoScheme:/, "no-scheme-link"],
  ] as const) {
    const opened: Page[] = [];
    const onPage = (p: Page) => opened.push(p);
    page.context().on("page", onPage);
    // xterm.js がリンクとして扱っている（カーソルが指になる）ことは、clickUrl の中で確かめる
    await clickUrl(page, line, text);
    await page.waitForTimeout(1000);
    page.context().off("page", onPage);
    expect.soft(opened.map((p) => p.url()), text).toEqual([]);
  }

  expect.soft(await page.evaluate(() => localStorage.getItem("pwned"))).toBeNull();
  expect(dialogs).toEqual([]);

  // http・https のリンクは、同じ状態でもこれまでどおり開く
  const url = "http://link.test/osc8";
  const opened = await openedPages(page, () => clickUrl(page, /OSC 8:/, url), url);
  expect(opened).toHaveLength(1);
});
