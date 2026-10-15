import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Locator } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

let accompany: Accompany | undefined;
// Accompany が一時ファイルを置く場所。テストごとに分け、保存された中身や後片付けを確かめる
let tmp: string;

test.beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "accompany-e2e-")));
});

test.afterEach(async () => {
  await accompany?.stop();
  accompany = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

// 入力をそのまま返す偽のシェルを起動し、一時ディレクトリをテストごとの場所にする
function start() {
  return startAccompany([], { SHELL: "e2e/fixtures/fake-shell", TMPDIR: tmp });
}

async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

type DroppedFile = { name: string; content: string };

// OS からのドラッグ＆ドロップは Playwright で直接は起こせないので、ファイルを入れた DataTransfer でドラッグのイベントを送る
async function dataTransferOf(target: Locator, files: DroppedFile[]) {
  return target.page().evaluateHandle((files) => {
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(new File([file.content], file.name));
    return dataTransfer;
  }, files);
}

async function dropFiles(target: Locator, files: DroppedFile[]) {
  const dataTransfer = await dataTransferOf(target, files);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

function screenOf(page: Parameters<typeof pane>[0], n: number) {
  return pane(page, n).locator(".xterm-rows");
}

// 一時ディレクトリの中から、保存されたファイルを名前で探す
function savedFiles(name: string) {
  return readdirSync(tmp, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => join(entry.parentPath, entry.name));
}

function savedFile(name: string) {
  const found = savedFiles(name);
  expect(found).toHaveLength(1);
  return found[0]!;
}

test("ファイルをターミナルの上にドラッグしている間、ドロップを受け付ける表示が出る", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  const target = pane(page, 1).locator(".xterm-screen");
  const dataTransfer = await dataTransferOf(target, [{ name: "screenshot.png", content: "png" }]);
  const indicator = pane(page, 1).getByText("ドロップしてパスを貼り付け");

  await expect(indicator).toBeHidden();
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await expect(indicator).toBeVisible();

  await target.dispatchEvent("dragleave", { dataTransfer });
  await expect(indicator).toBeHidden();
});

test("ファイルをドロップすると、サーバーに保存され、そのパスがターミナルの入力に貼り付けられる", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);

  await dropFiles(pane(page, 1).locator(".xterm-screen"), [{ name: "screenshot.png", content: "fake png bytes" }]);

  await expect.poll(() => savedFiles("screenshot.png")).toHaveLength(1);
  const path = savedFile("screenshot.png");
  expect(readFileSync(path, "utf8")).toBe("fake png bytes");
  await expectPaneToShow(page, 1, path);
  await expect(pane(page, 1).getByText("ドロップしてパスを貼り付け")).toBeHidden();

  // Enter は送らないので、偽のシェル（cat）はまだ受け取っておらず、パスは入力中の行に 1 回だけ出ている。
  // 続けて Enter を押すと、シェルが受け取って同じ行を返す
  await expect.poll(async () => (await screenOf(page, 1).textContent())!.split(path).length - 1).toBe(1);
  await typeInPane(page, 1, "\n");
  await expect.poll(async () => (await screenOf(page, 1).textContent())!.split(path).length - 1).toBe(2);
});

test("複数のファイルをドロップすると、すべてのパスが空白区切りで貼り付けられ、空白を含むパスはクォートされる", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);

  await dropFiles(pane(page, 1).locator(".xterm-screen"), [
    { name: "first.txt", content: "first" },
    { name: "my notes.txt", content: "second" },
  ]);

  await expect.poll(() => savedFiles("my notes.txt")).toHaveLength(1);
  const first = savedFile("first.txt");
  const second = savedFile("my notes.txt");
  expect(readFileSync(first, "utf8")).toBe("first");
  expect(readFileSync(second, "utf8")).toBe("second");
  await expectPaneToShow(page, 1, `${first} '${second}'`);
});

test("ドロップしたターミナルにだけ貼り付けられる", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await dropFiles(pane(page, 2).locator(".xterm-screen"), [{ name: "for-right.txt", content: "right" }]);

  await expect.poll(() => savedFiles("for-right.txt")).toHaveLength(1);
  const path = savedFile("for-right.txt");
  await expectPaneToShow(page, 2, path);
  await expect(screenOf(page, 1)).not.toContainText("for-right.txt");
});

test("ターミナルの外（分割の境目など）にドロップしても、ブラウザがファイルを開いて画面から離れない", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  // テストから送るイベントではブラウザの既定の動作（ファイルを開く）は起きないので、
  // 既定の動作が取り消されていること（defaultPrevented）で確かめる
  const prevented = await page.locator(".divider").first().evaluate((divider) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["outside"], "outside.txt"));
    return ["dragover", "drop"].map((type) => {
      const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
      divider.dispatchEvent(event);
      return event.defaultPrevented;
    });
  });

  expect(prevented).toEqual([true, true]);
  expect(savedFiles("outside.txt")).toEqual([]);
});

test("ファイル名にパスの区切りが含まれていても、保存先の外には書き込まれない", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);

  await dropFiles(pane(page, 1).locator(".xterm-screen"), [{ name: "../../escape.txt", content: "escape" }]);

  await expect.poll(() => savedFiles("escape.txt")).toHaveLength(1);
  const path = savedFile("escape.txt");
  await expectPaneToShow(page, 1, path);
  // 保存先は一時ディレクトリの中に Accompany が作るディレクトリで、その外（一時ディレクトリの直下）には何も置かれない
  expect(readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isFile())).toEqual([]);
  expect(existsSync(join(tmp, "escape.txt"))).toBe(false);
});

test("Accompany を止めると、保存したファイルが消える", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await dropFiles(pane(page, 1).locator(".xterm-screen"), [{ name: "temporary.txt", content: "temporary" }]);
  await expect.poll(() => savedFiles("temporary.txt")).toHaveLength(1);

  await accompany.stop();
  accompany = undefined;

  expect(readdirSync(tmp)).toEqual([]);
});
