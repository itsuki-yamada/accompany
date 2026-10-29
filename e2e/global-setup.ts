import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accompanyCommand } from "./tests/accompany";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// 起動コマンドを 1 回だけ先に動かす。bunx で tarball から起動するときは、最初の起動でパッケージを入れるので、
// ワーカーが並行に最初の起動をして、同じ入れ先に同時に書き込まないようにする（docs/adr/205-parallel-e2e.md）
export default function globalSetup() {
  execSync(`${accompanyCommand()} --version`, { cwd: repoRoot, stdio: "inherit", timeout: 120_000 });
}
