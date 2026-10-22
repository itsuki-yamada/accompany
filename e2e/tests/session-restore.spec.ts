import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { boxOf, expectPaneToShow, pane, panes, tab, typeInPane } from "./panes";

// 分割や新しいタブ、戻したターミナルは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
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

function sidebarTabs(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" }).getByRole("tab");
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

// ターミナル 1 の右にターミナル 2 を並べ、新しいタブでターミナル 3 を開いて、それぞれに出力を残す。境界は左寄せにする
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

  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await typeInPane(page, 3, "tab 3 before restart\n");
  await expectPaneToShow(page, 3, "tab 3 before restart");
}

test("起動し直すと、タブの並びと各ターミナルのスクロールバックが戻る。並べ方は戻さず、最初のタブだけを表示する", async ({
  browser,
}) => {
  accompany = await start();
  await arrange(await open(browser, accompany.url));
  await accompany.stop();

  accompany = await start();
  const page = await open(browser, accompany.url);

  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 2/, /ターミナル 3/]);
  await expect(tab(page, 1)).toHaveAttribute("aria-selected", "true");
  await expect(panes(page)).toHaveCount(1);
  // 戻したスクロールバックの下に区切りが出て、その下で新しく起動したシェルが動く
  await expect(screenText(page, 1)).toHaveText(/left before restart.*── Accompany を再起動しました ──.*Fake Shell ready/);

  await tab(page, 2).click();
  await expect(screenText(page, 2)).toHaveText(/right before restart.*── Accompany を再起動しました ──.*Fake Shell ready/);
  await tab(page, 3).click();
  await expect(screenText(page, 3)).toHaveText(/tab 3 before restart.*── Accompany を再起動しました ──.*Fake Shell ready/);

  await typeInPane(page, 3, "typed after restart\n");
  await expectPaneToShow(page, 3, "typed after restart");
  // 戻したターミナルでも、分割すると番号が続く
  await pane(page, 3).getByRole("button", { name: "下に分割" }).click();
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
  await tab(page, 2).click();
  await expect(screenText(page, 2)).toHaveText(/── Accompany を再起動しました ──.*Fake Shell ready/);
  await expect(screenText(page, 2)).not.toContainText("Fake Agent ready");
});

test("起動時のコマンドを動かしていたターミナルを閉じていたときは、起動し直すと新しいタブで起動時のコマンドが動き、そのタブが出る", async ({
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

  await expect(sidebarTabs(page)).toHaveText([/ターミナル 2/, /ターミナル 3/]);
  await expect(tab(page, 3)).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 3, "Fake Agent ready");
  await expect(screenText(page, 3)).not.toContainText(restartedMark);
  await tab(page, 2).click();
  await expect(screenText(page, 2)).toHaveText(/── Accompany を再起動しました ──.*Fake Shell ready/);
});

test("起動時のコマンドを省略したときは、そのターミナルを閉じていても新しいタブは増えない", async ({ browser }) => {
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
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 2/]);
});

test("止める操作を経ずに落ちても、少し前までのタブとスクロールバックが戻る", async ({ browser }) => {
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

  await expect(sidebarTabs(page)).toHaveCount(2);
  await tab(page, 2).click();
  await expect(screenText(page, 2)).toHaveText(/saved while running.*── Accompany を再起動しました ──.*Fake Shell ready/);
});

test("前の形式（Workspace と分割の配置）で保存したものからは、ターミナルをタブとして並べて戻し、配置は戻さない", async ({
  browser,
}) => {
  // Accompany を起動するディレクトリ（リポジトリの直下）ごとの保存ファイルに、前の形式（version 1）で書いておく
  const cwd = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  await mkdir(join(stateDir, "sessions"), { recursive: true });
  const terminal = (text: string, initial = false) => ({ cols: 80, rows: 24, scrollback: `${text}\r\n`, initial });
  const leaf = (id: string) => ({ type: "terminal", id });
  await writeFile(
    join(stateDir, "sessions", `${key}.json`),
    JSON.stringify({
      version: 1,
      cwd,
      tabs: [
        { id: "1", layout: { type: "split", id: "split-1", direction: "row", ratio: 0.3, children: [leaf("1"), leaf("4")] } },
        { id: "2", layout: leaf("2") },
      ],
      active: "2",
      terminals: { "1": terminal("old one", true), "4": terminal("old four"), "2": terminal("old two") },
      commands: [{ id: "1", name: "挨拶", content: "echo restored command", run: false }],
    }),
  );

  accompany = await start();
  const page = await open(browser, accompany.url);

  // Workspace の順・配置の順に並ぶ
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/, /ターミナル 4/, /ターミナル 2/]);
  await expect(panes(page)).toHaveCount(1);
  await expect(screenText(page, 1)).toHaveText(/old one.*── Accompany を再起動しました ──.*Fake Shell ready/);
  await tab(page, 4).click();
  await expect(screenText(page, 4)).toHaveText(/old four.*── Accompany を再起動しました ──/);
  await pane(page, 4).getByRole("button", { name: "コマンド", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: /挨拶/ })).toBeVisible();
  await page.keyboard.press("Escape");
  // 新しいタブの番号は、戻したターミナルの続きになる
  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 5, "Fake Shell ready");
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
  await expect(sidebarTabs(page)).toHaveText([/ターミナル 1/]);
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
