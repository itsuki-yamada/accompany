import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: "list",
  // プルリクに貼る証跡として、全テストのスクリーンショットと動画を残す
  use: { screenshot: "on", video: "on" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
