import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, typeInPane } from "./panes";

// Accompany を止めたりターミナルを閉じたりすると、ふつうの端末のウィンドウを閉じたときと同じように、
// シェルと前面のコマンドに SIGHUP を送り、端末が開いているうちに片付けて終われるようにする。
// nohup で SIGHUP を無視するものは残る（docs/adr/197-sighup-on-close.md）

let accompany: Accompany | undefined;
let dir: string;
const leftovers: number[] = [];

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "accompany-e2e-"));
});

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
  // nohup で残したものを片付ける
  for (const pid of leftovers.splice(0)) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
});

// CI では zsh を入れて必ず確かめる（.github/workflows/e2e.yml）。手元では、zsh が入っているときだけ確かめる
const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;

// 本物のシェルを、プロンプトだけ決めて起動する引数と環境変数
const shells = {
  bash: () => {
    const rcfile = join(dir, "bashrc");
    writeFileSync(rcfile, "PS1='bash$ '\n");
    return { args: ["bash", "--noprofile", "--rcfile", rcfile], env: {}, prompt: "bash$" };
  },
  // 環境ごとの /etc/zsh/zshrc（Ubuntu は compinit を呼び、CI では確認を求めて止まる）を読まず、書いた .zshrc だけを読む
  zsh: () => {
    writeFileSync(join(dir, ".zshrc"), "PS1='zsh%# '\n");
    return { args: ["zsh", "--noglobalrcs"], env: { ZDOTDIR: dir }, prompt: "zsh%" };
  },
};

async function open(browser: Browser, url: string) {
  const page = await (await newContext(browser)).newPage();
  await page.goto(url);
  return page;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const readPid = (name: string) => Number(readFileSync(join(dir, name), "utf8").trim());

// シェルのプロセス ID を書き、nohup で SIGHUP を無視するものを裏で動かしてから、前面で SIGHUP を待つコマンドを動かす
async function runInShell(page: Page, n: number) {
  await typeInPane(page, n, `echo $$ > "$E2E_DIR/shell.pid"; nohup sleep 300 > /dev/null 2>&1 & echo $! > "$E2E_DIR/nohup.pid"\n`);
  await expect.poll(() => existsSync(join(dir, "nohup.pid")) && readFileSync(join(dir, "nohup.pid"), "utf8").endsWith("\n")).toBe(true);
  await typeInPane(page, n, "bun e2e/fixtures/hup-reporter.ts\n");
  await expectPaneToShow(page, n, "Waiting for SIGHUP");
  const pids = { shell: readPid("shell.pid"), nohup: readPid("nohup.pid"), reporter: readPid("reporter.pid") };
  leftovers.push(pids.nohup);
  return pids;
}

for (const [name, shell] of Object.entries(shells)) {
  test(`Accompany を止めると、${name} と前面のコマンドが、端末が開いているうちに SIGHUP を受けて終わり、nohup のものは残る`, async ({
    browser,
  }) => {
    test.skip(name === "zsh" && !hasZsh && !process.env.CI, "zsh が入っていない");
    const { args, env, prompt } = shell();
    accompany = await startAccompany(["--", ...args], { ...env, E2E_DIR: dir });
    const page = await open(browser, accompany.url);
    await expectPaneToShow(page, 1, prompt);
    const pids = await runInShell(page, 1);

    await accompany.stop();
    accompany = undefined;

    // 前面のコマンドは、Accompany が終わる（PTY が閉じる）前に SIGHUP を受けた
    expect(readFileSync(join(dir, "hup"), "utf8")).toBe("open");
    // Accompany は、シェルと前面のコマンドが終わるのを待ってから終わる
    expect(isAlive(pids.shell)).toBe(false);
    expect(isAlive(pids.reporter)).toBe(false);
    expect(isAlive(pids.nohup)).toBe(true);
  });

  test(`ターミナルを閉じると、${name} と前面のコマンドが SIGHUP を受けて終わり、nohup のものは残る`, async ({ browser }) => {
    test.skip(name === "zsh" && !hasZsh && !process.env.CI, "zsh が入っていない");
    const { args, env, prompt } = shell();
    // 新しいタブは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
    accompany = await startAccompany(["--", ...args], { ...env, E2E_DIR: dir, SHELL: "e2e/fixtures/fake-shell" });
    const page = await open(browser, accompany.url);
    await expectPaneToShow(page, 1, prompt);
    const pids = await runInShell(page, 1);
    await page.getByRole("button", { name: "新しいタブ" }).click();
    await expectPaneToShow(page, 2, "Fake Shell ready");

    await page
      .getByRole("complementary", { name: "サイドメニュー" })
      .getByRole("button", { name: "ターミナル 1 を閉じる" })
      .click();

    await expect.poll(() => existsSync(join(dir, "hup")) && readFileSync(join(dir, "hup"), "utf8")).toBe("open");
    await expect.poll(() => isAlive(pids.shell)).toBe(false);
    await expect.poll(() => isAlive(pids.reporter)).toBe(false);
    expect(isAlive(pids.nohup)).toBe(true);
  });
}
