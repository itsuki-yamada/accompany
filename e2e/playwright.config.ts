import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // テストは既定のポートで Accompany を起動するため、並行に実行しない
  workers: 1,
  // HTML レポートは CI で成果物としてアップロードする
  reporter: [["list"], ["html", { open: "never" }]],
  // プルリクに貼る証跡として、全テストのスクリーンショットと動画を残す
  use: { screenshot: "on", video: "on" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
