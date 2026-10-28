import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow } from "./panes";

// Homebrew と npm で入れた Accompany は、署名のない実行ファイルではなく、Bun が tarball の JS（dist/cli.js）を動かす。
// npm の起動役は、Bun がなければ（または ACCOMPANY_USE_BINARY=1 を付けると）OS と CPU のパッケージの実行ファイルを起動する
// （docs/adr/191-run-on-bun.md）。どちらで動くはずかは、起動のしかたを用意する CI（e2e.yml）が ACCOMPANY_EXPECT_RUNTIME
// （bun / binary）で渡す。渡されないとき（リポジトリから起動するときなど）は流さない

const expected = process.env.ACCOMPANY_EXPECT_RUNTIME;

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
});

// pid とその子孫のプロセスの、コマンドライン（ps の args）
function processTree(pid: number) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }));
  const tree = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.ppid) && !tree.has(row.pid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => tree.has(row.pid)).map((row) => row.args);
}

test("入れ方に合わせて、Bun が tarball の JS を動かすか、実行ファイルが動き、画面とターミナルが使える", async ({ browser }) => {
  test.skip(!expected, "起動のしかたを用意した CI（ACCOMPANY_EXPECT_RUNTIME）でだけ確かめる");

  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });
  const page = await (await newContext(browser)).newPage();
  await page.goto(accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  const tree = processTree(accompany.pid);
  const bunRunsJs = tree.some((args) => /(^|\/)bun\s+\S*\/dist\/cli\.js(\s|$)/.test(args));
  const binary = tree.some((args) => /(^|\/)(bin\/accompany|accompany-[^/\s]*-(darwin|linux)-(arm64|x64))(\s|$)/.test(args));
  const summary = tree.join("\n");
  if (expected === "bun") {
    expect(bunRunsJs, summary).toBe(true);
    expect(binary, summary).toBe(false);
  } else {
    expect(binary, summary).toBe(true);
    expect(bunRunsJs, summary).toBe(false);
  }
});
