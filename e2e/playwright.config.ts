import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // ファイルごとにワーカーへ振り分けて並行に流す（同じファイルのテストは、これまでどおり 1 つのワーカーで順に流す）。
  // ポートはワーカーごとにずらしている（e2e/tests/accompany.ts の testPort、docs/adr/205-parallel-e2e.md）。
  // CI（ubuntu-latest。公開リポジトリでは 4 コア）は、コアの数だけ流す。テストは Accompany・シェル・Chromium・
  // 動画の書き出しを同時に動かすので、コアの数より増やしても速くならず、待ち時間の短い確認が落ちやすくなる。
  // 手元では、ほかの作業や別の作業ディレクトリの E2E と並ぶことが多いので、コアの半分にとどめる
  workers: process.env.CI ? "100%" : "50%",
  // bunx で tarball から起動するとき、最初の起動（インストール）をワーカーどうしで並行に走らせないよう、先に 1 回起動しておく
  globalSetup: "./global-setup.ts",
  // HTML レポートは CI で成果物としてアップロードする
  reporter: [["list"], ["html", { open: "never" }]],
  // プルリクに貼る証跡として、全テストのスクリーンショットと動画を残す
  use: { screenshot: "on", video: "on" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
