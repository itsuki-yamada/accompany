import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { accompanyCommand, closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

// 直前に実行したコマンドの出力を、ひと操作でコピーする。コマンドの区切りは、シェルの統合（OSC 133）で見分ける
// （docs/adr/112-copy-last-output.md）

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// OSC 133 の印を出す偽のシェル
const promptShell = ["--", "bun", "e2e/fixtures/prompt-shell.ts"];
// シェルの統合がない（印を出さない）偽のシェル
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };
const clipboard = ["clipboard-read", "clipboard-write"];
const menuLabel = "直前のコマンドの出力をコピー";

let accompany: Accompany | undefined;
let tempDir: string | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function open(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 }, permissions: clipboard });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

// コマンドを実行し、次のプロンプトが出るまで待つ
async function run(page: Page, command: string, waitFor: string) {
  await typeInPane(page, 1, `${command}\n`);
  await expectPaneToShow(page, 1, waitFor);
}

async function openMenu(page: Page) {
  const box = (await pane(page, 1).locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
}

function menuItem(page: Page) {
  return page.getByRole("menu").getByRole("menuitem", { name: menuLabel });
}

function readClipboard(page: Page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test("右クリックのメニューで、直前のコマンドの出力だけをコピーし、コピーした範囲を光らせる", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Prompt shell ready");
  await run(page, "echo first output", "first output");
  await run(page, "lines 3 second", "second 3");

  await openMenu(page);
  await menuItem(page).click();

  await expect.poll(() => readClipboard(page)).toBe("second 1\nsecond 2\nsecond 3");
  // コピーした範囲を一瞬光らせ、何をコピーしたかを知らせる
  await expect(pane(page, 1).locator(".copied-output").first()).toBeVisible();
  await expect(pane(page, 1).getByRole("alert")).toContainText("直前のコマンドの出力をコピーしました（3 行）");
  await expect(pane(page, 1).locator(".copied-output")).toHaveCount(0);
});

function copyButton(page: Page) {
  return pane(page, 1).getByRole("button", { name: menuLabel });
}

test("ペインの右下のコピーのボタンで、直前のコマンドの出力をコピーする", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Prompt shell ready");

  // ペインの右下に小さく置く
  const button = copyButton(page);
  await expect(button).toBeVisible();
  const paneBox = (await pane(page, 1).boundingBox())!;
  const box = (await button.boundingBox())!;
  expect(box.x + box.width).toBeGreaterThan(paneBox.x + paneBox.width - 60);
  expect(box.y + box.height).toBeGreaterThan(paneBox.y + paneBox.height - 40);
  expect(box.width).toBeLessThan(120);
  expect(box.height).toBeLessThan(40);

  // まだコマンドの出力がないときは押せず、理由をツールチップに出す
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("title", /まだコマンドを実行していません/);

  await run(page, "echo first output", "first output");
  await run(page, "lines 2 second", "second 2");
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("title", /直前のコマンドの出力をコピー（⌘⇧L \/ Ctrl\+Shift\+L）/);
  await button.click();

  await expect.poll(() => readClipboard(page)).toBe("second 1\nsecond 2");
  await expect(pane(page, 1).locator(".copied-output").first()).toBeVisible();
  // 押したあとも、キー入力の先はターミナルのまま
  await expect(pane(page, 1).locator(".xterm-helper-textarea")).toBeFocused();
});

test("シェルの統合がないときは、コピーのボタンを押せず、シェルの統合が要ることを説明する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await expect(copyButton(page)).toBeDisabled();
  await expect(copyButton(page)).toHaveAttribute("title", /シェルの統合が要ります/);
});

for (const modifier of ["Meta+Shift", "Control+Shift"] as const) {
  test(`${modifier}+L で、直前のコマンドの出力をコピーする`, async ({ browser }) => {
    accompany = await startAccompany(promptShell);
    const page = await open(browser, accompany.url);
    await expectPaneToShow(page, 1, "Prompt shell ready");
    await run(page, "lines 2 alpha", "alpha 2");
    await run(page, "echo beta", "beta");

    await pane(page, 1).locator(".xterm-helper-textarea").focus();
    await page.keyboard.press(`${modifier}+KeyL`);

    await expect.poll(() => readClipboard(page)).toBe("beta");
  });
}

test("ショートカットの一覧に、直前のコマンドの出力のコピーが載る", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await open(browser, accompany.url);
  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  const list = page.getByRole("dialog", { name: "キーボードショートカット" });
  await expect(list).toContainText(menuLabel);
  await expect(list).toContainText("⌘⇧L");
  await expect(list).toContainText("Ctrl+Shift+L");
});

test("途中から参加した人や、ページを読み込み直した人も、直前のコマンドの出力をコピーできる", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const host = await open(browser, accompany.url);
  await expectPaneToShow(host, 1, "Prompt shell ready");
  await run(host, "echo old", "old");
  await run(host, "lines 2 latest", "latest 2");

  const guest = await open(browser, accompany.url);
  await expectPaneToShow(guest, 1, "latest 2");
  await openMenu(guest);
  await menuItem(guest).click();
  await expect.poll(() => readClipboard(guest)).toBe("latest 1\nlatest 2");

  await host.reload();
  await expectPaneToShow(host, 1, "latest 2");
  await host.evaluate(() => navigator.clipboard.writeText(""));
  await openMenu(host);
  await menuItem(host).click();
  await expect.poll(() => readClipboard(host)).toBe("latest 1\nlatest 2");
});

test("シェルの統合がないときは、メニューを押せず、シェルの統合が要ることを説明する", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await typeInPane(page, 1, "hello\n");
  await expectPaneToShow(page, 1, "hello");

  await openMenu(page);
  await expect(menuItem(page)).toBeDisabled();
  await expect(menuItem(page)).toHaveAttribute("title", /シェルの統合が要ります/);
  await page.keyboard.press("Escape");

  // ショートカットでも、コピーせずに理由を出す
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  await pane(page, 1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+Shift+KeyL");
  await expect(pane(page, 1).getByRole("alert")).toContainText("シェルの統合が要ります");
  expect(await readClipboard(page)).toBe("unchanged");
});

test("まだコマンドを実行していないときと、全画面のアプリの中では、メニューを押せない", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Prompt shell ready");

  await openMenu(page);
  await expect(menuItem(page)).toBeDisabled();
  await expect(menuItem(page)).toHaveAttribute("title", /まだコマンドを実行していません/);
  await page.keyboard.press("Escape");

  await run(page, "echo before", "before");
  await run(page, "tui", "Prompt TUI");
  await openMenu(page);
  await expect(menuItem(page)).toBeDisabled();
  await expect(menuItem(page)).toHaveAttribute("title", /全画面のアプリの中では使えません/);
  await page.keyboard.press("Escape");

  // 全画面のアプリを終えると、そのコマンド（tui）の出力（通常の画面には何も出していない）が直前のものになる
  await typeInPane(page, 1, "\n");
  await expectPaneToShow(page, 1, "before");
  await run(page, "echo after", "after");
  await openMenu(page);
  await menuItem(page).click();
  await expect.poll(() => readClipboard(page)).toBe("after");
});

function shellIntegration(shell: string) {
  return spawnSync(`${accompanyCommand()} --shell-integration ${shell}`, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    timeout: 30_000,
  });
}

// 利用者の rc に書くのと同じく、--shell-integration の出力を eval する
function rcWithIntegration(shell: string, prompt: string) {
  return `${prompt}\neval "$(${accompanyCommand()} --shell-integration ${shell})"\n`;
}

async function expectCopiesLastOutput(page: Page, ready: string) {
  await expectPaneToShow(page, 1, ready);
  await run(page, "echo one", "one");
  await run(page, "printf 'two\\nthree\\n'", "three");
  await openMenu(page);
  await menuItem(page).click();
  await expect.poll(() => readClipboard(page)).toBe("two\nthree");
}

// シェルの統合のスクリプトを入れた本物のシェルで確かめる
test("--shell-integration bash のスクリプトを入れた bash で、直前のコマンドの出力をコピーする", async ({ browser }) => {
  tempDir = mkdtempSync(join(tmpdir(), "accompany-e2e-"));
  const rcfile = join(tempDir, "bashrc");
  writeFileSync(rcfile, rcWithIntegration("bash", "PS1='bash$ '"));

  accompany = await startAccompany(["--", "bash", "--noprofile", "--rcfile", rcfile]);
  await expectCopiesLastOutput(await open(browser, accompany.url), "bash$");
});

// CI の Linux には zsh が入っていないことがあるので、入っているときだけ確かめる
const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
test("--shell-integration zsh のスクリプトを入れた zsh で、直前のコマンドの出力をコピーする", async ({ browser }) => {
  test.skip(!hasZsh, "zsh が入っていない");
  tempDir = mkdtempSync(join(tmpdir(), "accompany-e2e-"));
  writeFileSync(join(tempDir, ".zshrc"), rcWithIntegration("zsh", "PS1='zsh%# '"));

  accompany = await startAccompany(["--", "zsh"], { ZDOTDIR: tempDir });
  await expectCopiesLastOutput(await open(browser, accompany.url), "zsh%");
});

test("--shell-integration は zsh・bash・fish のスクリプトを出し、知らないシェルではエラーで終わる", () => {
  for (const shell of ["zsh", "bash", "fish"]) {
    const result = shellIntegration(shell);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("133;C");
    expect(result.stdout).toContain("133;D");
  }
  const unknown = shellIntegration("tcsh");
  expect(unknown.stdout + unknown.stderr).toContain("--shell-integration は zsh・bash・fish のどれか");
  expect(unknown.status).toBe(1);
});
