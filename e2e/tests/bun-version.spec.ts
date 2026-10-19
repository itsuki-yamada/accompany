import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { newStateDir, testPort } from "./accompany";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Bun 1.3 では、tarball から bunx で起動すると画面の JS と CSS が 404 になり、何も出ない（docs/adr/78-binaries.md）。
// 古い Bun で起動したら、何が足りないかを表示して終了する。
// 実行ファイルは Bun を中に持っているので、起動のしかたを差し替えたとき（ACCOMPANY_CMD）は流さない
test("Bun が古いと、必要な Bun の版と実行ファイルの案内を表示して終了する", async () => {
  test.skip(!!process.env.ACCOMPANY_CMD, "リポジトリから起動するときだけ確かめる");
  // 古い Bun のダウンロードを待つ
  test.setTimeout(60_000);

  const result = spawnSync("bunx", ["bun@1.3.14", "app/server/src/cli.ts", "--port", testPort()], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ACCOMPANY_STATE_DIR: newStateDir() },
    timeout: 50_000,
  });
  const output = result.stdout + result.stderr;

  expect(output).not.toContain("Accompany: http");
  expect(output).toContain("Bun 1.4.0 以上が必要です（いまの Bun: 1.3.14）");
  expect(output).toContain("https://github.com/itsuki-yamada/accompany/releases");
  expect(result.status).toBe(1);
});
