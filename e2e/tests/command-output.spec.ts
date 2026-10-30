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
// テストの中で起動した別のブラウザ（テストのあとに閉じる）
const otherBrowsers: Browser[] = [];

test.afterEach(async () => {
  await closeContexts();
  await Promise.allSettled(otherBrowsers.splice(0).map((b) => b.close()));
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

// text のあとに、次のプロンプト（偽のシェルの「$」、本物のシェルの「bash$」「zsh%」）が出るまで待つ。
// シェルは出力とプロンプトを別々に書くので、text が見えた時点では、そのあとのシェルの統合の印（D と A）はまだ届いていないことがある。
// プロンプトは印のあとに書くので、プロンプトが見えれば印も届いている
async function expectPromptAfter(page: Page, text: string) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(pane(page, 1).locator(".xterm-rows")).toHaveText(new RegExp(`${escaped}\\s*\\S*[$%]\\s*$`));
}

// コマンドを実行し、次のプロンプトが出るまで待つ
async function run(page: Page, command: string, waitFor: string) {
  await typeInPane(page, 1, `${command}\n`);
  await expectPromptAfter(page, waitFor);
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
  // ターミナルの表示（右下の文字）には重ねない
  const area = (await pane(page, 1).locator(".pane-terminal").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(area.y + area.height - 1);

  // まだコマンドの出力がないときは押せず、理由をツールチップに出す
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("title", /まだコマンドを実行していません/);

  await run(page, "echo first output", "first output");
  await run(page, "lines 2 second", "second 2");
  await expect(button).toBeEnabled();
  // ツールチップにキー（Ctrl+T のあと y）を出す（docs/adr/177-prefix-keys.md）
  await expect(button).toHaveAttribute("title", `${menuLabel}（Ctrl+T → y）`);
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
  await expect(copyButton(page)).toHaveAttribute("title", /eval "\$\(accompany activate zsh\)"/);

  // 押せない見た目のボタンを押すと、コピーせずに理由を知らせる
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  await copyButton(page).click({ force: true });
  await expect(pane(page, 1).getByRole("alert")).toContainText("シェルの統合が要ります");
  expect(await readClipboard(page)).toBe("unchanged");
});

// キーでのコピー（Ctrl+T のあと y）は e2e/tests/prefix-keys.spec.ts で確かめる
test("コピーのキーを、ショートカットの一覧に載せる", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Prompt shell ready");
  await page.getByRole("button", { name: "キーボードショートカット" }).click();
  await expect(page.getByRole("dialog", { name: "キーボードショートカット" })).toContainText(menuLabel);
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

// Chromium のクリップボードはブラウザごとに 1 つ（同じブラウザのコンテキストどうしで共有する）なので、
// ほかの参加者は別のブラウザで開く
test("コピーしても、ほかの参加者のクリップボードは変わらない", async ({ browser, playwright }) => {
  accompany = await startAccompany(promptShell);
  const host = await open(browser, accompany.url);
  const otherBrowser = await playwright.chromium.launch();
  otherBrowsers.push(otherBrowser);
  const guest = await open(otherBrowser, accompany.url);
  await expectPaneToShow(host, 1, "Prompt shell ready");
  await expectPaneToShow(guest, 1, "Prompt shell ready");
  await guest.evaluate(() => navigator.clipboard.writeText("guest clipboard"));
  await run(host, "echo shared output", "shared output");
  await expectPaneToShow(guest, 1, "shared output");

  await openMenu(host);
  await menuItem(host).click();
  await expect.poll(() => readClipboard(host)).toBe("shared output");
  await expect(pane(host, 1).getByRole("alert")).toContainText("コピーしました");
  expect(await readClipboard(guest)).toBe("guest clipboard");
});

test("出力の始まりの行がスクロールバックから押し出されたときは、残っている行から、途中から参加した人も同じようにコピーできる", async ({
  browser,
}) => {
  accompany = await startAccompany(promptShell);
  const host = await open(browser, accompany.url);
  await expectPaneToShow(host, 1, "Prompt shell ready");
  // スクロールバック（1000 行）を超える出力
  await run(host, "lines 1500 big", "big 1500");
  const fromHost = await copyLastOutput(host);
  await fromHost.toMatch(/big 1500$/);
  const hostText = await readClipboard(host);
  expect(hostText).not.toContain("big 1\n");

  const guest = await open(browser, accompany.url);
  await expectPaneToShow(guest, 1, "big 1500");
  await (await copyLastOutput(guest)).toBe(hostText);
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
  // 案内は accompany activate の形で出す
  await expect(menuItem(page)).toHaveAttribute("title", /eval "\$\(accompany activate zsh\)"/);
  await page.keyboard.press("Escape");
});

test("まだコマンドを実行していないときと、全画面のアプリの中では、メニューを押せない", async ({ browser }) => {
  accompany = await startAccompany(promptShell);
  const page = await open(browser, accompany.url);
  // シェルの統合の印（A）を受け取るまでは、統合がないものとして扱う。メニューは開いたときの状態で作るので、印を受け取ってから開く
  await expectPromptAfter(page, "Prompt shell ready");

  await openMenu(page);
  await expect(menuItem(page)).toBeDisabled();
  await expect(menuItem(page)).toHaveAttribute("title", /まだコマンドを実行していません/);
  await page.keyboard.press("Escape");

  await run(page, "echo before", "before");
  // 全画面のアプリの中では、プロンプトは出ない
  await typeInPane(page, 1, "tui\n");
  await expectPaneToShow(page, 1, "Prompt TUI");
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

// accompany activate [シェル] を実行する（mise activate と同じ形。docs/adr/112-copy-last-output.md）
function activate(args: string, env: Record<string, string> = {}) {
  return spawnSync(`${accompanyCommand()} activate ${args}`, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

// 利用者の rc に書くのと同じく、accompany activate の出力を eval する。二重に読み込んでも 1 回分だけ効くことも確かめるため、2 回書く
function rcWithActivate(shell: string, prompt: string) {
  const line = `eval "$(${accompanyCommand()} activate ${shell})"`;
  return `${prompt}\n${line}\n${line}\n`;
}

async function copyLastOutput(page: Page) {
  await openMenu(page);
  await menuItem(page).click();
  return expect.poll(() => readClipboard(page));
}

async function expectCopiesLastOutput(page: Page, ready: string) {
  await expectPaneToShow(page, 1, ready);
  await run(page, "echo one", "one");
  await run(page, "printf 'two\\nthree\\n'", "three");
  await (await copyLastOutput(page)).toBe("two\nthree");
}

// シェルの統合を入れた本物のシェルで確かめる
test("accompany activate bash を入れた bash で、直前のコマンドの出力をコピーする。二重に読み込んでもフックは 1 つ", async ({
  browser,
}) => {
  tempDir = mkdtempSync(join(tmpdir(), "accompany-e2e-"));
  const rcfile = join(tempDir, "bashrc");
  writeFileSync(rcfile, rcWithActivate("bash", "PS1='bash$ '"));

  accompany = await startAccompany(["--", "bash", "--noprofile", "--rcfile", rcfile]);
  const page = await open(browser, accompany.url);
  await expectCopiesLastOutput(page, "bash$");
  await run(page, 'echo "[$PROMPT_COMMAND]"', "[_accompany_hook]");
  await (await copyLastOutput(page)).toBe("[_accompany_hook]");
});

test("bash で set -u にしていても、PS0 がなくても読み込め、似た名前のフックを壊さない", async ({ browser }) => {
  tempDir = mkdtempSync(join(tmpdir(), "accompany-e2e-"));
  const rcfile = join(tempDir, "bashrc");
  // 文字列の PROMPT_COMMAND に、名前が _accompany_hook で始まる別のフックがある
  const before = "set -u\nunset PS0\n_accompany_hook_x() { :; }\nPROMPT_COMMAND='_accompany_hook_x;true'";
  writeFileSync(rcfile, rcWithActivate("bash", `${before}\nPS1='bash$ '`));

  accompany = await startAccompany(["--", "bash", "--noprofile", "--rcfile", rcfile]);
  const page = await open(browser, accompany.url);
  await expectCopiesLastOutput(page, "bash$");
  await run(page, 'echo "[$PROMPT_COMMAND]"', "[_accompany_hook;_accompany_hook_x;true]");
  await (await copyLastOutput(page)).toBe("[_accompany_hook;_accompany_hook_x;true]");
});

// CI では zsh を入れて必ず確かめる（.github/workflows/e2e.yml）。手元では、zsh が入っているときだけ確かめる
const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
test("accompany activate zsh を入れた zsh で、直前のコマンドの出力をコピーする。二重に読み込んでもフックは 1 つ", async ({
  browser,
}) => {
  test.skip(!hasZsh && !process.env.CI, "zsh が入っていない");
  tempDir = mkdtempSync(join(tmpdir(), "accompany-e2e-"));
  writeFileSync(join(tempDir, ".zshrc"), rcWithActivate("zsh", "PS1='zsh%# '"));

  // 環境ごとの /etc/zsh/zshrc（Ubuntu は compinit を呼び、CI では確認を求めて止まる）を読まず、書いた .zshrc だけを読む
  accompany = await startAccompany(["--", "zsh", "--noglobalrcs"], { ZDOTDIR: tempDir });
  const page = await open(browser, accompany.url);
  await expectCopiesLastOutput(page, "zsh%");
  await run(page, 'echo "[${#${(@M)precmd_functions:#_accompany_hook}}]"', "[1]");
  await (await copyLastOutput(page)).toBe("[1]");
});

test("accompany activate は zsh・bash・fish のスクリプトを出し、シェルを省くと $SHELL から決める", () => {
  for (const shell of ["zsh", "bash", "fish"]) {
    const result = activate(shell);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("133;C");
    expect(result.stdout).toContain("133;D");
  }
  expect(activate("", { SHELL: "/usr/local/bin/fish" }).stdout).toBe(activate("fish").stdout);
  expect(activate("", { SHELL: "/bin/zsh" }).stdout).toBe(activate("zsh").stdout);
});

test("accompany activate は、知らないシェルではエラーにし、対応しているシェルを示す", () => {
  for (const result of [activate("tcsh"), activate("", { SHELL: "/bin/tcsh" })]) {
    expect(result.stderr).toContain("tcsh");
    expect(result.stderr).toContain("zsh・bash・fish");
    expect(result.status).toBe(1);
  }
});

test("accompany activate --help で、使い方と rc への書き方を出す", () => {
  const result = activate("--help");
  expect(result.status).toBe(0);
  for (const text of ['eval "$(accompany activate zsh)"', 'eval "$(accompany activate bash)"', "accompany activate fish | source"]) {
    expect(result.stdout).toContain(text);
  }
  // 全体の使い方にも載る
  const help = spawnSync(`${accompanyCommand()} --help`, { cwd: repoRoot, shell: true, encoding: "utf8", timeout: 30_000 });
  expect(help.stdout).toContain("accompany activate");
});

test("activate という名前のコマンドは、accompany -- activate で最初のターミナルで動かせる", async ({ browser }) => {
  const bin = join(repoRoot, "e2e/fixtures/bin");
  accompany = await startAccompany(["--", "activate"], { PATH: `${bin}:${process.env.PATH}` });
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "activate command ran");
});
