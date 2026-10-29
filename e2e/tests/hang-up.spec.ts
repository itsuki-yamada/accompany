import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, typeInPane } from "./panes";

// Accompany を止めたりターミナルを閉じたりすると、ふつうの端末のウィンドウを閉じたときと同じように、
// シェルと前面のコマンドに SIGHUP を送る。止めるときは、終わるのを少し待ってから Accompany が終わる。
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
  // nohup で残したものや、SIGHUP で終わらないようにしたシェルを片付ける
  for (const pid of leftovers.splice(0)) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
});

// CI では zsh と dash を入れて必ず確かめる（.github/workflows/e2e.yml。dash は Ubuntu に入っている）。
// 手元では、入っているときだけ確かめる
const has = (shell: string) => spawnSync(shell, ["-c", "true"]).status === 0;
const skipUnless = (shell: string) => test.skip(!has(shell) && !process.env.CI, `${shell} が入っていない`);

type Shell = { args: string[]; env: Record<string, string>; prompt: string };

// 本物のシェルを、プロンプトだけ決めて起動する引数と環境変数。bash の履歴は、開発者の ~/.bash_history ではなく一時的な場所に書く
function bash(rc = "") {
  const rcfile = join(dir, "bashrc");
  writeFileSync(rcfile, `PS1='bash$ '\n${rc}`);
  return { args: ["bash", "--noprofile", "--rcfile", rcfile], env: { HISTFILE: join(dir, "bash_history") }, prompt: "bash$" };
}

// 環境ごとの /etc/zsh/zshrc（Ubuntu は compinit を呼び、CI では確認を求めて止まる）を読まず、書いた .zshrc だけを読む
function zsh(rc = "") {
  writeFileSync(join(dir, ".zshrc"), `PS1='zsh%# '\n${rc}`);
  return { args: ["zsh", "--noglobalrcs"], env: { ZDOTDIR: dir }, prompt: "zsh%" };
}

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

const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined);
const readPid = (name: string) => Number(read(name)!.trim());

async function startShell(browser: Browser, shell: Shell, env: Record<string, string> = {}) {
  accompany = await startAccompany(["--", ...shell.args], { ...shell.env, E2E_DIR: dir, ...env });
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, shell.prompt);
  return page;
}

// プロセスが動かしているコマンドの名前。macOS の ps はパスで出すことがあるので、最後の部分だけにする
function commandOf(pid: number) {
  const comm = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return comm.split("/").pop();
}

// シェルのプロセス ID を書き、nohup で SIGHUP を無視するものを裏で動かしてから、前面で SIGHUP を待つコマンドを動かす
async function runInShell(page: Page, n: number) {
  await typeInPane(page, n, `echo $$ > "$E2E_DIR/shell.pid"; nohup sleep 300 > /dev/null 2>&1 & echo $! > "$E2E_DIR/nohup.pid"\n`);
  await expect.poll(() => read("nohup.pid")?.endsWith("\n")).toBe(true);
  const nohup = readPid("nohup.pid");
  leftovers.push(nohup);
  // $! はシェルが fork した直後に分かり、nohup が SIGHUP を無視するようにするのはそのあとになる。
  // 負荷で nohup の起動が遅れると、その前に届いた SIGHUP で終わってしまうので、nohup が SIGHUP を無視してから
  // sleep に置き換わる（コマンドの名前が sleep になる）のを待つ
  await expect.poll(() => commandOf(nohup)).toBe("sleep");
  await typeInPane(page, n, "bun e2e/fixtures/hup-reporter.ts\n");
  await expectPaneToShow(page, n, "Waiting for SIGHUP");
  const pids = { shell: readPid("shell.pid"), nohup, reporter: readPid("reporter.pid") };
  leftovers.push(pids.shell);
  return pids;
}

async function closeTerminal(page: Page, n: number) {
  await page
    .getByRole("complementary", { name: "サイドメニュー" })
    .getByRole("button", { name: `ターミナル ${n} を閉じる` })
    .click();
}

for (const [name, shell] of Object.entries({ bash, zsh })) {
  test(`Accompany を止めると、${name} と前面のコマンドが SIGHUP を受けて、Accompany より先に終わり、nohup のものは残る`, async ({
    browser,
  }) => {
    skipUnless(name);
    const page = await startShell(browser, shell());
    const pids = await runInShell(page, 1);

    await accompany!.stop();
    accompany = undefined;

    expect(read("hup")).toBeDefined();
    expect(isAlive(pids.shell)).toBe(false);
    expect(isAlive(pids.reporter)).toBe(false);
    expect(isAlive(pids.nohup)).toBe(true);
  });

  test(`ターミナルを閉じると、${name} と前面のコマンドが SIGHUP を受けて終わり、nohup のものは残る`, async ({ browser }) => {
    skipUnless(name);
    // 新しいタブは $SHELL を起動するので、入力をそのまま返す偽のシェルにする
    const page = await startShell(browser, shell(), { SHELL: "e2e/fixtures/fake-shell" });
    const pids = await runInShell(page, 1);
    await page.getByRole("button", { name: "新しいタブ" }).click();
    await expectPaneToShow(page, 2, "Fake Shell ready");

    await closeTerminal(page, 1);

    await expect.poll(() => read("hup")).toBeDefined();
    await expect.poll(() => isAlive(pids.shell)).toBe(false);
    await expect.poll(() => isAlive(pids.reporter)).toBe(false);
    expect(isAlive(pids.nohup)).toBe(true);
  });
}

// シェルが SIGHUP を受け止めて終わらない（trap ':' HUP）と、シェルは前面のコマンドに SIGHUP を送らない。
// それでも Accompany が前面のプロセスグループに直接送るので、前面のコマンドに届く。シェルが終わらないので、
// 前面のコマンドは端末が開いているうちに受けて書ける（シェルが終わると、macOS ではその端末に書けなくなる）。
// trap のない dash や NO_HUP の zsh は、終わったときにカーネルが前面のプロセスグループに SIGHUP を送るので、
// Accompany が前面に直接送らなくても届き、確かめたいことと区別できない
const trapping: Record<string, () => Shell> = {
  bash: () => bash("trap ':' HUP\n"),
  zsh: () => zsh("setopt NO_HUP\ntrap ':' HUP\n"),
  dash: () => {
    // 対話の dash は、起動するときに $ENV のファイルを読む
    writeFileSync(join(dir, "dashrc"), "PS1='dash$ '\ntrap ':' HUP\n");
    return { args: ["dash", "-i"], env: { ENV: join(dir, "dashrc") }, prompt: "dash$" };
  },
};

for (const [name, shell] of Object.entries(trapping)) {
  test(`${name} が SIGHUP を受け止めて終わらなくても、ターミナルを閉じると、前面のコマンドが SIGHUP を受けて終わる`, async ({
    browser,
  }) => {
    skipUnless(name);
    const page = await startShell(browser, shell(), { SHELL: "e2e/fixtures/fake-shell" });
    const pids = await runInShell(page, 1);
    await page.getByRole("button", { name: "新しいタブ" }).click();
    await expectPaneToShow(page, 2, "Fake Shell ready");

    await closeTerminal(page, 1);

    await expect.poll(() => read("hup")).toBe("open");
    await expect.poll(() => isAlive(pids.reporter)).toBe(false);
    expect(isAlive(pids.nohup)).toBe(true);
  });
}

test("起動時のコマンドがシェルでなく、前面に別のプロセスグループを出していても、ターミナルを閉じると前面のコマンドが SIGHUP を受ける", async ({
  browser,
}) => {
  // set -m: 前面のコマンドを別のプロセスグループで動かす。bash -c は SIGHUP を trap で受け止め、前面のコマンドには送らない
  const script = `'echo $$ > "$E2E_DIR/shell.pid"; trap : HUP; set -m; bun e2e/fixtures/hup-reporter.ts; sleep 300'`;
  accompany = await startAccompany(["--", "bash", "-c", script], { E2E_DIR: dir, SHELL: "e2e/fixtures/fake-shell" });
  const page = await open(browser, accompany.url);
  await expectPaneToShow(page, 1, "Waiting for SIGHUP");
  const reporter = readPid("reporter.pid");
  leftovers.push(readPid("shell.pid"));
  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await closeTerminal(page, 1);

  await expect.poll(() => read("hup")).toBe("open");
  await expect.poll(() => isAlive(reporter)).toBe(false);
});

// シェルが SIGHUP で終わらないとき、前面のコマンドが片付けに時間をかけても、Accompany は待ってから終わる（PTY を閉じる）ので、
// 前面のコマンドは片付けの終わりに端末に書ける
test("シェルが SIGHUP で終わらなくても、Accompany を止めると、前面のコマンドが片付け終わるのを待ってから終わる", async ({ browser }) => {
  const page = await startShell(browser, bash("trap ':' HUP\n"), { E2E_HUP_DELAY_MS: "300" });
  const pids = await runInShell(page, 1);

  await accompany!.stop();
  accompany = undefined;

  expect(read("hup")).toBe("open");
  expect(isAlive(pids.reporter)).toBe(false);
  expect(isAlive(pids.nohup)).toBe(true);
});
