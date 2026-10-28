import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type FrameLocator, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

// VS Code の拡張（app/vscode）を、本物の VS Code に入れて確かめる（docs/adr/183-liveshare-extension.md）。
// VS Code は @vscode/test-electron で取得し、Chrome DevTools Protocol で Playwright からつなぐ。
// 本物の Live Share はサインインが要るため、同じ ID の偽物（e2e/fixtures/vscode/fake-liveshare）を入れる
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const extensionPath = join(repoRoot, "app/vscode");
const fakeLiveSharePath = join(repoRoot, "e2e/fixtures/vscode/fake-liveshare");

export type VSCode = {
  page: Page;
  // テストが使い捨てに作ったディレクトリ。閉じると消す
  dir: string;
  // 偽の Live Share が書いた、拡張の呼び出し
  calls: () => Record<string, unknown>[];
  // VS Code の標準出力・標準エラー出力
  output: () => string;
  close: () => Promise<void>;
};

// 拡張の設定 accompany.path に渡す起動役。リポジトリの Accompany を、テスト用のシェルと保存先で起動する
function accompanyLauncher(dir: string, env: Record<string, string>) {
  const path = join(dir, "accompany");
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}='${value}'\n`)
    .join("");
  writeFileSync(path, `#!/bin/sh\n${exports}exec bun '${join(repoRoot, "app/server/src/cli.ts")}' "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

// 確かめる VS Code の版。stable にすると、VS Code の新しい版が出ただけで CI が変わるので、固定する。
// 新しい版で確かめるときは VSCODE_VERSION で上書きする
export const vscodeVersion = process.env.VSCODE_VERSION ?? "1.143.1";

// workspaceSettings を渡すと、開いたフォルダーの .vscode/settings.json に書く
// accompanyPath を渡すと、ユーザーの設定の accompany.path をそれにする（既定はリポジトリの Accompany を起動する起動役）
export async function launchVSCode({
  env = {},
  workspaceSettings,
  accompanyPath,
}: { env?: Record<string, string>; workspaceSettings?: Record<string, unknown>; accompanyPath?: string } = {}): Promise<VSCode> {
  const executable = await downloadAndUnzipVSCode({
    version: vscodeVersion,
    cachePath: join(repoRoot, "e2e/.vscode-test"),
  });
  const dir = mkdtempSync(join(tmpdir(), "accompany-vscode-e2e-"));
  const userData = join(dir, "user-data");
  const workspace = join(dir, "workspace");
  mkdirSync(join(userData, "User"), { recursive: true });
  mkdirSync(workspace);
  if (workspaceSettings) {
    mkdirSync(join(workspace, ".vscode"));
    writeFileSync(join(workspace, ".vscode/settings.json"), JSON.stringify(workspaceSettings));
  }
  const log = join(dir, "liveshare.log");
  writeFileSync(log, "");
  const launcher = accompanyLauncher(dir, {
    SHELL: join(repoRoot, "e2e/fixtures/fake-shell"),
    ACCOMPANY_STATE_DIR: join(dir, "state"),
  });
  writeFileSync(
    join(userData, "User/settings.json"),
    JSON.stringify({
      "accompany.path": accompanyPath ?? launcher,
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "security.workspace.trust.enabled": false,
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "chat.disableAIFeatures": true,
      "window.restoreWindows": "none",
    }),
  );

  // VS Code の中のターミナルから流したときに、その VS Code の設定を引き継がないよう、VSCODE_ と ELECTRON_ の変数を除く
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VSCODE_") && !key.startsWith("ELECTRON_")),
  );
  const child: ChildProcess = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(dir, "extensions")}`,
      `--extensionDevelopmentPath=${extensionPath}`,
      `--extensionDevelopmentPath=${fakeLiveSharePath}`,
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      "--new-window",
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
      workspace,
    ],
    { env: { ...baseEnv, FAKE_LIVESHARE_LOG: log, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  // VS Code の出力（拡張のホストのエラーなど）。テストが落ちたときに証跡として残す
  const vscodeOutput: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => vscodeOutput.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => vscodeOutput.push(chunk.toString()));
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const url = output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
      if (url) resolve(url);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => reject(new Error(`VS Code が DevTools の URL を表示する前に終了した (code: ${code})\n${output}`)));
  });
  const browser: Browser = await chromium.connectOverCDP(endpoint);
  const page = await workbench(browser);
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const close = async () => {
    await browser.close().catch(() => {});
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  };
  // 拡張のホストが動き出し、Accompany の拡張が Live Share の API を得るまで待つ。
  // 待たずにコマンドパレットを開くと、拡張のコマンドがまだ登録されておらず、開いたままでは一覧が更新されない
  const waitFrom = Date.now();
  try {
    await expect.poll(() => calls().some((c) => c.call === "activate"), { timeout: 60_000 }).toBe(true);
    console.log(`拡張が動き出すまで、ウィンドウが開いてから ${Date.now() - waitFrom} ms 待った`);
  } catch (error) {
    const output = vscodeOutput.join("");
    await close();
    throw new Error(`拡張が動き出さなかった\n${output}`, { cause: error });
  }
  return { page, dir, calls, close, output: () => vscodeOutput.join("") };
}

// VS Code のウィンドウ（workbench）のページ。開いて、拡張が動き出すまで待つ
async function workbench(browser: Browser) {
  let page: Page | undefined;
  await expect
    .poll(
      () => {
        page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench"));
        return Boolean(page);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await page!.locator(".monaco-workbench").waitFor({ timeout: 60_000 });
  // ほかのウィンドウが前にあっても、キー入力がこのウィンドウに届くよう、フォーカスがあるものとして扱わせる
  const cdp = await page!.context().newCDPSession(page!);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page!.bringToFront();
  return page!;
}

// コマンドパレットからコマンドを実行する
export async function runCommand(page: Page, title: string) {
  const input = page.locator(".quick-input-widget input");
  // Accompany のパネルにフォーカスがあると、F1 も Accompany に届く（VS Code のキー割り当てが効かない）ので、
  // サイドバーをクリックしてフォーカスを VS Code に戻す
  await page.locator(".part.sidebar .composite.title").click();
  // 起動した直後は、キー割り当てが効くようになるまで F1 を受け付けないことがあるので、開くまで押し直す
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press("F1");
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await input.fill(`>${title}`);
  const row = page.locator(".quick-input-list .monaco-list-row", { hasText: title }).first();
  // コマンドの一覧は開いたときのものなので、まだ出ていなければ、開き直して探し直す
  await expect(async () => {
    if (!(await row.isVisible())) {
      await input.fill("");
      await input.fill(`>${title}`);
    }
    await expect(row).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await input.press("Enter");
  // 閉じきる前に次のコマンドを開こうとすると、閉じかけの入力欄に書き込もうとして止まるので、閉じるまで待つ
  await expect(input).toBeHidden();
}

// Accompany のパネル（webview）の中の Accompany のページ。
// webview は iframe（.webview）の中の iframe（#active-frame）で、拡張はその中の iframe で Accompany を開く
export function accompanyFrame(page: Page): FrameLocator {
  return page.frameLocator("iframe.webview").frameLocator("#active-frame").frameLocator("iframe");
}

// Accompany のパネルのタブ
export function panelTab(page: Page) {
  return page.locator(".tabs-container .tab", { hasText: "Accompany" });
}
