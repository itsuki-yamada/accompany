import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { accompanyCommand, closeContexts, newContext, newStateDir, startAccompany, testPort, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

// 起動のしかた（実行ファイル、npm の起動役などを挟んだもの）によらず、終了コードと止める合図が同じように効く（docs/adr/132-npm.md）

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;
let stateDir: string;

test.beforeEach(() => {
  stateDir = newStateDir();
});

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
  await rm(join(stateDir, ".."), { recursive: true, force: true });
});

test("起動の引数が誤っていると、エラーを表示して終了コード 1 で終わる", () => {
  const result = spawnSync(`${accompanyCommand()} --port ${testPort()} --min-window abc`, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ACCOMPANY_STATE_DIR: stateDir },
    timeout: 30_000,
  });

  expect(result.stdout + result.stderr).toContain("--min-window は「幅x高さ」");
  expect(result.status).toBe(1);
});

// 起動せずに終わる引数（版・使い方・誤った引数）を付けて実行する
function runWithArgs(args: string) {
  return spawnSync(`${accompanyCommand()} ${args}`, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ACCOMPANY_STATE_DIR: stateDir },
    timeout: 30_000,
  });
}

const { version } = JSON.parse(readFileSync(join(repoRoot, "app/server/package.json"), "utf8"));

for (const flag of ["--version", "-v"]) {
  test(`${flag} を付けると、版を表示して終了コード 0 で終わる`, () => {
    const result = runWithArgs(flag);

    expect(result.stdout.trim()).toBe(`accompany ${version}`);
    expect(result.status).toBe(0);
  });
}

for (const flag of ["--help", "-h"]) {
  test(`${flag} を付けると、使い方を表示して終了コード 0 で終わる`, () => {
    const result = runWithArgs(flag);

    expect(result.stdout).toContain("使い方: accompany [オプション] [-- <コマンド...>]");
    for (const option of ["--port", "--fresh", "--min-window", "--allow-vscode-webview", "--version", "--help"]) {
      expect(result.stdout).toContain(option);
    }
    // ポートが使われていたら上げることも、使い方で分かる（docs/adr/152-free-port.md）
    expect(result.stdout).toMatch(/--port .*使われていたら/);
    expect(result.status).toBe(0);
  });
}

test("知らないオプションを付けると、例外のスタックではなく短いエラーと使い方を表示して終了コード 1 で終わる", () => {
  const result = runWithArgs("--no-such-option");

  expect(result.stderr).toContain("Accompany: 知らないオプションです: --no-such-option");
  expect(result.stderr).toContain("使い方: accompany [オプション] [-- <コマンド...>]");
  // スタック（「at …」の行）や例外の名前を出さない
  expect(result.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS|^\s+at /m);
  expect(result.status).toBe(1);
});

test("値の要るオプションに値がないと、短いエラーと使い方を表示して終了コード 1 で終わる", () => {
  const result = runWithArgs("--port");

  expect(result.stderr).toContain("Accompany: --port には値が要ります");
  expect(result.stderr).toContain("使い方: accompany [オプション] [-- <コマンド...>]");
  expect(result.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS|^\s+at /m);
  expect(result.status).toBe(1);
});

// parseArgs の英語の説明をそのまま出さず、日本語の短いエラーにそろえる
for (const [args, message] of [
  ["--port --fresh", "Accompany: --port には値が要ります"],
  ["--fresh=x", "Accompany: --fresh は値を取りません"],
]) {
  test(`${args} を付けると、短いエラーと使い方を表示して終了コード 1 で終わる`, () => {
    const result = runWithArgs(args);

    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("使い方: accompany [オプション] [-- <コマンド...>]");
    expect(result.stderr).not.toMatch(/TypeError|ERR_PARSE_ARGS|ambiguous|does not take/);
    expect(result.status).toBe(1);
  });
}

// ポートは 0〜65535 の整数。外れた値で「ポート NaN〜NaN はすべて使われています」のような誤ったエラーにしない
for (const port of ["abc", "70000", "1.5", "-1"]) {
  test(`--port ${port} を付けると、値の誤りとして短いエラーと使い方を表示して終了コード 1 で終わる`, () => {
    const result = runWithArgs(`--port=${port}`);

    expect(result.stderr).toContain(`Accompany: --port は 0〜65535 の整数で指定してください: ${port}`);
    expect(result.stderr).toContain("使い方: accompany [オプション] [-- <コマンド...>]");
    expect(result.stderr).not.toContain("使われています");
    expect(result.status).toBe(1);
  });
}

// -- のあとの引数は Accompany のオプションとして読まず、そのままコマンドに渡す（docs/adr/147-cli-options.md）
test("-- のあとの --help や --version は、最初のターミナルで動かすコマンドに渡す", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/args-printer.ts", "--help", "--version"]);
  const page = await (await newContext(browser)).newPage();
  await page.goto(accompany.url);

  await expectPaneToShow(page, 1, "Args: --help --version");
});

// 端末の Ctrl+C はプロセスグループ全体に届くが、kill などで起動したプロセスだけに送られることもある。
// 起動役を挟んでいても、Accompany まで届き、画面を保存してから止まる
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`起動したプロセスだけに ${signal} を送っても、画面を保存してから止まり、起動し直すと戻る`, async ({ browser }) => {
    const env = { ...fakeShell, ACCOMPANY_STATE_DIR: stateDir };
    accompany = await startAccompany([], env);
    const context = await newContext(browser);
    let page = await context.newPage();
    await page.goto(accompany.url);
    await expectPaneToShow(page, 1, "Fake Shell ready");
    await typeInPane(page, 1, `before ${signal}\n`);
    await expectPaneToShow(page, 1, `before ${signal}`);

    await accompany.stop(signal, { onlyCommand: true });

    accompany = await startAccompany([], env);
    page = await context.newPage();
    await page.goto(accompany.url);
    await expect(pane(page, 1).locator(".xterm-rows")).toHaveText(
      new RegExp(`before ${signal}.*── Accompany を再起動しました ──.*Fake Shell ready`),
    );
  });
}
