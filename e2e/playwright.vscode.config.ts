import { defineConfig } from "@playwright/test";

// VS Code の拡張（app/vscode）を、本物の VS Code に入れて確かめる E2E（docs/adr/183-liveshare-extension.md）。
// VS Code の取得と起動に時間がかかるので、ブラウザの E2E（playwright.config.ts）とは分けて流す。
// VS Code はシステムのクリップボードを使うので、手元で流すとクリップボードが書き換わる
export default defineConfig({
  testDir: "./vscode",
  workers: 1,
  timeout: 120_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-vscode" }]],
});
