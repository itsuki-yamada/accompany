import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { expect, test, type FrameLocator } from "@playwright/test";
import { startAccompany, testPort, type Accompany } from "../tests/accompany";
import { accompanyFrame, launchVSCode, panelTab, runCommand, type VSCode } from "./vscode";

// 参加者は Live Share を始めるだけで、VS Code の中（パネル）で Accompany を使える（docs/adr/183-liveshare-extension.md）
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let vscode: VSCode | undefined;
let accompany: Accompany | undefined;

test.afterEach(async ({}, testInfo) => {
  // 証跡として、終わったときの VS Code のウィンドウを残す
  const screenshot = await vscode?.page.screenshot().catch(() => undefined);
  if (screenshot) await testInfo.attach("vscode", { body: screenshot, contentType: "image/png" });
  if (vscode && testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach("vscode-output", { body: vscode.output(), contentType: "text/plain" });
  }
  await vscode?.close();
  vscode = undefined;
  await accompany?.stop();
  accompany = undefined;
});

function terminal(frame: FrameLocator) {
  return frame.locator(".xterm-rows");
}

async function nameInput(frame: FrameLocator) {
  await frame.getByRole("button", { name: "表示の設定" }).click();
  return frame.getByRole("dialog", { name: "表示の設定" }).getByRole("textbox", { name: "あなたの名前" });
}

function call(vscode: VSCode, name: string) {
  return vscode.calls().find((c) => c.call === name);
}

function isListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// ゲストとして参加し、ホストの Accompany（テストで起動したもの）をパネルで開く
async function joinAsGuest(env: Record<string, string> = {}) {
  vscode = await launchVSCode({ env: { FAKE_LIVESHARE_HOST_PORT: testPort(), ...env } });
  await runCommand(vscode.page, "Fake Live Share: ゲストとして参加する");
  return { page: vscode.page, frame: accompanyFrame(vscode.page) };
}

test("ホストが Live Share を始めると、Accompany を起動して共有し、パネルで開く。終えると共有をやめ、Accompany を止める", async () => {
  vscode = await launchVSCode({ env: { FAKE_LIVESHARE_NAME: "やまだ" } });
  const { page } = vscode;

  await runCommand(page, "Fake Live Share: ホストとして始める");

  const frame = accompanyFrame(page);
  await expect(terminal(frame)).toContainText("Fake Shell ready", { timeout: 30_000 });
  await expect.poll(() => call(vscode!, "shareServer")).toMatchObject({ server: { displayName: "Accompany" } });
  const { port } = (call(vscode, "shareServer") as { server: { port: number } }).server;
  expect(await isListening(port)).toBe(true);
  // 参加者の名前の既定は、Live Share の表示名
  await expect(await nameInput(frame)).toHaveValue("やまだ");
  // ゲストの拡張は、共有サービスに info を要求してポートを知る
  await runCommand(page, "Fake Live Share: ホストの共有サービスに info を要求する");
  await expect.poll(() => call(vscode!, "requestInfo")).toEqual({ call: "requestInfo", result: { port } });

  await runCommand(page, "Fake Live Share: 終える");

  await expect.poll(() => call(vscode!, "unshareServer")).toBeTruthy();
  await expect(panelTab(page)).toHaveCount(0);
  await expect.poll(() => isListening(port), { timeout: 10_000 }).toBe(false);
});

test("ゲストが Live Share に参加すると、ホストの共有サービスから受け取ったポートの Accompany を、Live Share の表示名でパネルで開く", async ({
  browser,
}) => {
  accompany = await startAccompany([], fakeShell);
  const { page, frame } = await joinAsGuest({ FAKE_LIVESHARE_NAME: "すずき" });

  await expect(terminal(frame)).toContainText("Fake Shell ready", { timeout: 30_000 });
  // ブラウザで開いたほかの参加者の画面に、Live Share の表示名で出る
  const other = await browser.newPage();
  await other.goto(accompany.url);
  await expect(
    other.getByRole("navigation", { name: "ツールバー" }).getByRole("button", { name: "すずき とペアプロ", exact: true }),
  ).toBeVisible();
  await other.close();

  await runCommand(page, "Fake Live Share: 終える");
  await expect(panelTab(page)).toHaveCount(0);
});

// VS Code のキー割り当て（Ctrl+P はクイックオープン、Ctrl+T はシンボルへ移動、Ctrl+Shift+O はシンボルへ移動など）に
// 先に取られずに、パネルの中の Accompany に届く
test("パネルの中で、Ctrl キーが VS Code に取られずにコマンドに届く", async () => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  const { page, frame } = await joinAsGuest();
  await expect(terminal(frame)).toContainText("Key reporter ready", { timeout: 30_000 });
  await frame.locator(".xterm-screen").click();

  for (const { key, byte } of [
    { key: "Control+P", byte: "10" },
    { key: "Control+W", byte: "17" },
    { key: "Control+F", byte: "06" },
    { key: "Control+B", byte: "02" },
    { key: "Control+J", byte: "0a" },
    { key: "Control+R", byte: "12" },
  ]) {
    await page.keyboard.press(key);
    await expect(terminal(frame)).toContainText(`keys: ${byte}`);
  }
  // VS Code のクイックオープンなどが開いていない
  await expect(page.locator(".quick-input-widget")).toBeHidden();
});

test("パネルの中で、Ctrl+T のプレフィックスと ⌘⇧ / Ctrl+Shift のショートカットが VS Code に取られずに届く", async () => {
  accompany = await startAccompany([], fakeShell);
  const { page, frame } = await joinAsGuest();
  await expect(terminal(frame)).toContainText("Fake Shell ready", { timeout: 30_000 });
  await frame.locator(".xterm-screen").click();
  // パネルの幅ではサイドメニューを隠すので、タブはツールバーにある
  const tabs = frame.getByRole("tab");
  await expect(tabs).toHaveCount(1);

  // Ctrl+T c: 新しいタブ
  await page.keyboard.press("Control+KeyT");
  await expect(frame.getByRole("status", { name: "プレフィックスキー" })).toBeVisible();
  await page.keyboard.press("c");
  await expect(tabs).toHaveCount(2);

  // ⌘⇧O / Ctrl+Shift+O: 新しいタブ
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+KeyO" : "Control+Shift+KeyO");
  await expect(tabs).toHaveCount(3);
  await expect(page.locator(".quick-input-widget")).toBeHidden();
});

// VS Code は localhost のページにクリップボードの許可を与えないので、コピーは webview を経由して書き込む。
// 読み取りは許可がないので、メニューの「ペースト」は使えず、キーボードでペーストする
test("パネルの中で、選択した文字をコピーでき、クリップボードの文字をキーボードでペーストできる", async () => {
  accompany = await startAccompany([], fakeShell);
  const { page, frame } = await joinAsGuest();
  await expect(terminal(frame)).toContainText("Fake Shell ready", { timeout: 30_000 });
  await frame.locator(".xterm-screen").click();
  await page.keyboard.type("copy me please\n");
  await expect(terminal(frame)).toContainText("copy me please");

  const menu = frame.getByRole("menu");
  await frame.locator(".xterm-screen").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "すべて選択", exact: true }).click();
  await frame.locator(".xterm-screen").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "コピー", exact: true }).click();

  // VS Code の拡張から読む、システムのクリップボードに入る
  await runCommand(page, "E2E: クリップボードを読む");
  await expect.poll(() => vscode!.calls().findLast((c) => c.call === "readClipboard")?.text).toContain("copy me please");

  // VS Code の拡張が書いたクリップボードの文字を、パネルの中の Accompany にキーボードで貼り付ける
  await runCommand(page, "E2E: クリップボードに書く");
  await frame.locator(".xterm-screen").click();
  // Windows・Linux の Ctrl+V は、ターミナル（xterm.js）が ^V としてコマンドに送るので、Ctrl+Shift+V でペーストする
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyV" : "Control+Shift+KeyV");
  await expect(terminal(frame)).toContainText("pasted from vscode");
});

async function readClipboard(vscode: VSCode) {
  const before = vscode.calls().filter((c) => c.call === "readClipboard").length;
  await runCommand(vscode.page, "E2E: クリップボードを読む");
  await expect.poll(() => vscode.calls().filter((c) => c.call === "readClipboard").length).toBe(before + 1);
  return vscode.calls().findLast((c) => c.call === "readClipboard")?.text;
}

// Accompany のページ（ゲストではホストが配るもの）が、利用者の操作なしに、ゲストのクリップボードを書き換えられない。
// webview は、利用者の操作の直後（一時的なユーザーアクティベーション）の、長すぎない書き込みだけを受け付ける
test("パネルの中のページが、利用者の操作なしにクリップボードを書き換えられない", async () => {
  accompany = await startAccompany([], fakeShell);
  const { page, frame } = await joinAsGuest();
  await expect(terminal(frame)).toContainText("Fake Shell ready", { timeout: 30_000 });
  await runCommand(page, "E2E: クリップボードに書く");

  // ユーザーアクティベーションが切れる（約 5 秒）のを待ってから、webview に書き込みを頼む
  const accompanyPage = page.frames().find((f) => f.url().startsWith(`http://localhost:${testPort()}/`))!;
  await accompanyPage.evaluate(() => {
    setTimeout(() => {
      window.parent.postMessage(
        { type: "accompany.clipboard.write", text: "without user activation" },
        location.ancestorOrigins[0],
      );
    }, 7000);
  });
  await new Promise((resolve) => setTimeout(resolve, 9000));

  expect(await readClipboard(vscode!)).toBe("pasted from vscode\n");
});

// 利用者の操作の直後でも、長すぎる文字（1000 万文字を超えるもの）は書き込まない
test("パネルの中のページが、長すぎる文字をクリップボードに書き込めない", async () => {
  accompany = await startAccompany([], fakeShell);
  const { page, frame } = await joinAsGuest();
  await expect(terminal(frame)).toContainText("Fake Shell ready", { timeout: 30_000 });
  await runCommand(page, "E2E: クリップボードに書く");

  // クリックしたときに、webview に書き込みを頼むボタンを、Accompany のページに置く
  const accompanyPage = page.frames().find((f) => f.url().startsWith(`http://localhost:${testPort()}/`))!;
  await accompanyPage.evaluate(() => {
    const button = document.createElement("button");
    button.id = "e2e-write";
    button.textContent = "write";
    button.style.cssText = "position:fixed;left:200px;top:200px;z-index:100000";
    button.addEventListener("click", () => {
      const text = (window as unknown as { e2eText: string }).e2eText;
      window.parent.postMessage({ type: "accompany.clipboard.write", text }, location.ancestorOrigins[0]);
    });
    document.body.append(button);
  });
  const write = async (text: string) => {
    await accompanyPage.evaluate((t) => ((window as unknown as { e2eText: string }).e2eText = t), text);
    await frame.locator("#e2e-write").click();
  };

  // 上限ちょうどまでは書き込める
  await write("a".repeat(10_000_000));
  await expect.poll(async () => (await readClipboard(vscode!))?.length, { timeout: 30_000 }).toBe(10_000_000);
  await runCommand(page, "E2E: クリップボードに書く");

  await write("a".repeat(10_000_001));
  await new Promise((resolve) => setTimeout(resolve, 2000));

  expect(await readClipboard(vscode!)).toBe("pasted from vscode\n");
});

// accompany.path は、開いたフォルダーの設定（.vscode/settings.json）では変えられない。
// Live Share のホストが開いたリポジトリの設定で、任意のコマンドを起動させないため
test("ワークスペースの設定で accompany.path を変えても使わず、ユーザーの設定の Accompany を起動する", async () => {
  mkdirSync(test.info().outputDir, { recursive: true });
  const marker = test.info().outputPath("workspace-command-ran");
  const script = test.info().outputPath("workspace-command.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(script, 0o755);
  vscode = await launchVSCode({ workspaceSettings: { "accompany.path": script } });
  const { page } = vscode;

  await runCommand(page, "Fake Live Share: ホストとして始める");

  await expect(terminal(accompanyFrame(page))).toContainText("Fake Shell ready", { timeout: 30_000 });
  expect(existsSync(marker)).toBe(false);
});
