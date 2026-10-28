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
  // 偽の Live Share が書いた、拡張の呼び出し
  calls: () => Record<string, unknown>[];
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

export async function launchVSCode({ env = {} }: { env?: Record<string, string> } = {}): Promise<VSCode> {
  const executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_VERSION ?? "stable",
    cachePath: join(repoRoot, "e2e/.vscode-test"),
  });
  const dir = mkdtempSync(join(tmpdir(), "accompany-vscode-e2e-"));
  const userData = join(dir, "user-data");
  const workspace = join(dir, "workspace");
  mkdirSync(join(userData, "User"), { recursive: true });
  mkdirSync(workspace);
  const log = join(dir, "liveshare.log");
  writeFileSync(log, "");
  const launcher = accompanyLauncher(dir, {
    SHELL: join(repoRoot, "e2e/fixtures/fake-shell"),
    ACCOMPANY_STATE_DIR: join(dir, "state"),
  });
  writeFileSync(
    join(userData, "User/settings.json"),
    JSON.stringify({
      "accompany.path": launcher,
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
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { page, calls, close };
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
  return page!;
}

// コマンドパレットからコマンドを実行する
export async function runCommand(page: Page, title: string) {
  await page.keyboard.press("F1");
  const input = page.locator(".quick-input-widget input");
  await input.waitFor();
  await input.fill(`>${title}`);
  await page.locator(".quick-input-list .monaco-list-row", { hasText: title }).first().waitFor();
  await input.press("Enter");
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
