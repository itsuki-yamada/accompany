import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes, typeInPane } from "./panes";

// 分割や新しい Workspace、戻したターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const restartedMark = "── Accompany を再起動しました ──";

let accompany: Accompany | undefined;
let stateDir: string;

test.beforeEach(() => {
  stateDir = newStateDir();
});

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  await rm(join(stateDir, ".."), { recursive: true, force: true });
});

// 再起動をまたいで同じ保存先を使う
function start(args: string[] = []) {
  return startAccompany(args, { ...fakeShell, ACCOMPANY_STATE_DIR: stateDir });
}

async function open(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

function tabs(page: Page) {
  return page.getByRole("tab");
}

function tab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function screenText(page: Page, n: number) {
  return pane(page, n).locator(".xterm-rows");
}

// 保存先の中のファイル（ディレクトリを除く）を、保存先からの相対パスで返す
async function savedFiles() {
  const entries = await readdir(stateDir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

async function savedContent() {
  const files = await savedFiles();
  return (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
}

// Workspace 1 を左右に分割し、Workspace 2 を開いて、それぞれに出力を残す。表示中の Workspace は Workspace 2、境界は左寄せにする
async function arrange(page: Page) {
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await typeInPane(page, 1, "left before restart\n");
  await expectPaneToShow(page, 1, "left before restart");
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await typeInPane(page, 2, "right before restart\n");
  await expectPaneToShow(page, 2, "right before restart");

  const divider = (await page.getByRole("separator").boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(1280 * 0.3, divider.y + divider.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await boxOf(page, 1)).width / 1280).toBeLessThan(0.35);

  await page.getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await typeInPane(page, 3, "tab 2 before restart\n");
  await expectPaneToShow(page, 3, "tab 2 before restart");
}

test("起動し直すと、Workspace・分割の配置と、各ターミナルのスクロールバックが戻る", async ({ browser }) => {
  accompany = await start();
  await arrange(await open(browser, accompany.url));
  await accompany.stop();

  accompany = await start();
  const page = await open(browser, accompany.url);

  await expect(tabs(page)).toHaveText(["Workspace 1", "Workspace 2"]);
  await expect(tab(page, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  // 戻したスクロールバックの下に区切りが出て、その下で新しく起動したシェルが動く
  await expect(screenText(page, 3)).toHaveText(
    /tab 2 before restart.*── Accompany を再起動しました ──.*Fake Shell ready/,
  );

  await tab(page, "Workspace 1").click();
  await expect(panes(page)).toHaveCount(2);
  await expect(screenText(page, 1)).toHaveText(/left before restart.*── Accompany を再起動しました ──.*Fake Shell ready/);
  await expect(screenText(page, 2)).toHaveText(/right before restart.*── Accompany を再起動しました ──.*Fake Shell ready/);
  const [left, right] = [await boxOf(page, 1), await boxOf(page, 2)];
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(left.width / 1280).toBeLessThan(0.35);

  await typeInPane(page, 1, "typed after restart\n");
  await expectPaneToShow(page, 1, "typed after restart");
  // 戻したターミナルでも、分割すると番号が続く
  await pane(page, 2).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 4, "Fake Shell ready");
});

test("起動時のコマンドを動かしていたターミナルでは、起動し直したときのコマンドが動く", async ({ browser }) => {
  const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];
  accompany = await start(fakeAgent);
  let page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Agent ready");
  await typeInPane(page, 1, "hello agent\n");
  await expectPaneToShow(page, 1, "Agent received: hello agent");
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await accompany.stop();

  accompany = await start(fakeAgent);
  page = await open(browser, accompany.url);

  await expect(screenText(page, 1)).toHaveText(
    /Agent received: hello agent.*── Accompany を再起動しました ──.*Fake Agent ready/,
  );
  await expect(screenText(page, 2)).toHaveText(/── Accompany を再起動しました ──.*Fake Shell ready/);
  await expect(screenText(page, 2)).not.toContainText("Fake Agent ready");
});

test("起動時のコマンドを動かしていたターミナルを閉じていたときは、起動し直すと新しい Workspace で起動時のコマンドが動く", async ({
  browser,
}) => {
  const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];
  accompany = await start(fakeAgent);
  let page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Agent ready");
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await pane(page, 1).getByRole("button", { name: "閉じる" }).click();
  await expect(panes(page)).toHaveCount(1);
  await accompany.stop();

  accompany = await start(fakeAgent);
  page = await open(browser, accompany.url);

  await expect(tabs(page)).toHaveText(["Workspace 1", "Workspace 2"]);
  await expect(tab(page, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 3, "Fake Agent ready");
  await expect(screenText(page, 3)).not.toContainText(restartedMark);
  await tab(page, "Workspace 1").click();
  await expect(screenText(page, 2)).toHaveText(/── Accompany を再起動しました ──.*Fake Shell ready/);
});

test("起動時のコマンドを省略したときは、そのターミナルを閉じていても新しい Workspace は増えない", async ({ browser }) => {
  accompany = await start();
  let page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await pane(page, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await pane(page, 1).getByRole("button", { name: "閉じる" }).click();
  await expect(panes(page)).toHaveCount(1);
  await accompany.stop();

  accompany = await start();
  page = await open(browser, accompany.url);

  await expect(screenText(page, 2)).toHaveText(/── Accompany を再起動しました ──.*Fake Shell ready/);
  await expect(tabs(page)).toHaveText(["Workspace 1"]);
});

test("止める操作を経ずに落ちても、少し前までの配置とスクロールバックが戻る", async ({ browser }) => {
  accompany = await start();
  let page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await typeInPane(page, 2, "saved while running\n");
  await expectPaneToShow(page, 2, "saved while running");
  // 変化のたびに少し間を置いて保存されるので、保存されるのを待ってから強制終了する
  await expect.poll(savedContent, { timeout: 10_000 }).toContain("saved while running");
  await accompany.stop("SIGKILL");

  accompany = await start();
  page = await open(browser, accompany.url);

  await expect(panes(page)).toHaveCount(2);
  await expect(screenText(page, 2)).toHaveText(/saved while running.*── Accompany を再起動しました ──.*Fake Shell ready/);
});

test("よく使うコマンドも、起動し直すと戻る", async ({ browser }) => {
  accompany = await start();
  let page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await pane(page, 1).getByRole("button", { name: "コマンド", exact: true }).click();
  await page.getByRole("menuitem", { name: "コマンドを管理…" }).click();
  const editor = page.getByRole("dialog", { name: "よく使うコマンド" });
  await editor.getByRole("textbox", { name: "名前" }).fill("挨拶");
  await editor.getByRole("textbox", { name: "内容" }).fill("echo restored command");
  await editor.getByRole("button", { name: "登録" }).click();
  await expect(editor.getByRole("listitem").filter({ hasText: "挨拶" })).toBeVisible();
  await accompany.stop();

  accompany = await start();
  page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, restartedMark);
  await pane(page, 1).getByRole("button", { name: "コマンド", exact: true }).click();

  await expect(page.getByRole("menuitem", { name: /挨拶/ })).toBeVisible();
});

test("--fresh を付けて起動すると、復元せずに新しく始まる", async ({ browser }) => {
  accompany = await start();
  await arrange(await open(browser, accompany.url));
  await accompany.stop();

  accompany = await start(["--fresh"]);
  const page = await open(browser, accompany.url);

  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(tabs(page)).toHaveText(["Workspace 1"]);
  await expect(panes(page)).toHaveCount(1);
  await expect(screenText(page, 1)).not.toContainText("left before restart");
  await expect(screenText(page, 1)).not.toContainText(restartedMark);
});

test("保存先のディレクトリは本人だけが読み書きでき（0700）、保存ファイルは本人だけが読み書きできる（0600）", async ({
  browser,
}) => {
  accompany = await start();
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await typeInPane(page, 1, "secret token\n");
  await expectPaneToShow(page, 1, "secret token");
  await accompany.stop();

  const files = await savedFiles();
  expect(files.length).toBeGreaterThan(0);
  // 書きかけの一時ファイルは残らない
  expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  for (const file of files) {
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
  }
  const dirs = new Set([stateDir, ...files.map((f) => join(f, ".."))]);
  for (const dir of dirs) {
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe("700");
  }
});
