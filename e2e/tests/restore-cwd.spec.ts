import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, tab, typeInPane } from "./panes";

// 開き直したときは、各タブのシェルを、止める前に作業していたディレクトリで始める。
// なくなっていたら Accompany を起動したディレクトリ（E2E ではリポジトリのルート）で始める（docs/adr/151-restore-cwd.md）

// pwd の結果が 1 行で読めるよう、どの環境にもある /bin/sh を、プロンプトの短いシェルとして使う
const shell = { SHELL: "/bin/sh" };
const launchDir = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));

let accompany: Accompany | undefined;
let stateDir: string;
const dirs: string[] = [];

test.beforeEach(() => {
  stateDir = newStateDir();
});

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
  rmSync(join(stateDir, ".."), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 再起動をまたいで同じ保存先を使う
function start(args: string[] = []) {
  return startAccompany(args, { ...shell, ACCOMPANY_STATE_DIR: stateDir });
}

// テストごとに一意のディレクトリを作る。macOS の一時ディレクトリはシンボリックリンクを通るので、pwd と比べられるよう正規化する
function newDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "accompany-restore-cwd-")));
  dirs.push(dir);
  return dir;
}

async function open(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "$");
  return page;
}

async function cd(page: Page, n: number, dir: string) {
  await typeInPane(page, n, `cd '${dir}' && echo moved\n`);
  await expectPaneToShow(page, n, "moved");
}

// ターミナル n のシェルで pwd を動かし、その結果の行が dir と一致することを確かめる
async function expectPwd(page: Page, n: number, dir: string) {
  await expectPaneToShow(page, n, "$");
  await typeInPane(page, n, "pwd\n");
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(
    pane(page, n)
      .locator(".xterm-rows > div")
      .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
  ).toHaveCount(1);
}

function savedFile() {
  const key = createHash("sha256").update(launchDir).digest("hex").slice(0, 16);
  return join(stateDir, "sessions", `${key}.json`);
}

function savedContent() {
  try {
    return readdirSync(join(stateDir, "sessions"))
      .map((f) => readFileSync(join(stateDir, "sessions", f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

test("シェルで cd してから止めて開き直すと、各タブの新しいシェルは止める前のディレクトリで始まる", async ({ browser }) => {
  accompany = await start();
  let page = await open(browser, accompany.url);
  const first = newDir();
  const second = newDir();
  await cd(page, 1, first);
  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 2, "$");
  await cd(page, 2, second);
  await accompany.stop();

  accompany = await start();
  page = await open(browser, accompany.url);

  await expectPwd(page, 1, first);
  await tab(page, 2).click();
  await expectPwd(page, 2, second);
});

test("止める操作を経ずに落ちても、少し前に保存したディレクトリでシェルが始まる", async ({ browser }) => {
  accompany = await start();
  let page = await open(browser, accompany.url);
  const dir = newDir();
  await cd(page, 1, dir);
  // 変化のたびに少し間を置いて保存されるので、ディレクトリが保存されるのを待ってから強制終了する
  await expect.poll(savedContent, { timeout: 10_000 }).toContain(JSON.stringify(dir));
  await accompany.stop("SIGKILL");

  accompany = await start();
  page = await open(browser, accompany.url);

  await expectPwd(page, 1, dir);
});

test("保存したディレクトリがなくなっていたら、Accompany を起動したディレクトリで始まる", async ({ browser }) => {
  accompany = await start();
  let page = await open(browser, accompany.url);
  const dir = newDir();
  await cd(page, 1, dir);
  await accompany.stop();
  rmSync(dir, { recursive: true, force: true });

  accompany = await start();
  page = await open(browser, accompany.url);

  await expectPwd(page, 1, launchDir);
});

test("起動時のコマンドを動かしていたタブでは、起動したディレクトリで起動時のコマンドが動き、ほかのタブは保存したディレクトリで始まる", async ({
  browser,
}) => {
  const initial = ["--", "/bin/sh"];
  accompany = await start(initial);
  let page = await open(browser, accompany.url);
  const dir = newDir();
  await cd(page, 1, dir);
  // 分割したシェルは dir で始まる（docs/adr/109-inherit-cwd.md）
  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 2, "$");
  await accompany.stop();

  accompany = await start(initial);
  page = await open(browser, accompany.url);

  await expectPwd(page, 1, launchDir);
  await tab(page, 2).click();
  await expectPwd(page, 2, dir);
});

test("ディレクトリを保存する前の版の保存ファイルからも戻り、シェルは Accompany を起動したディレクトリで始まる", async ({
  browser,
}) => {
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  writeFileSync(
    savedFile(),
    JSON.stringify({
      version: 2,
      cwd: launchDir,
      tabs: ["1", "2"],
      terminals: {
        "1": { cols: 80, rows: 24, scrollback: "old one\r\n", initial: true },
        "2": { cols: 80, rows: 24, scrollback: "old two\r\n", initial: false },
      },
      commands: [],
    }),
  );

  accompany = await start();
  const page = await open(browser, accompany.url);

  await expectPaneToShow(page, 1, "old one");
  await expectPwd(page, 1, launchDir);
  await tab(page, 2).click();
  await expectPaneToShow(page, 2, "old two");
  await expectPwd(page, 2, launchDir);
});
