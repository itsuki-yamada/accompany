import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

// 分割や新しい Workspace で増やしたターミナルは、作業していたディレクトリでシェルを始める。
// 分からないときは Accompany を起動したディレクトリ（E2E ではリポジトリのルート）で始める（docs/adr/109-inherit-cwd.md）

// pwd の結果が 1 行で読めるよう、どの環境にもある /bin/sh を、プロンプトの短いシェルとして使う
const shell = { SHELL: "/bin/sh" };
const launchDir = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));

let accompany: Accompany | undefined;
const dirs: string[] = [];

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  accompany = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// テストごとに一意のディレクトリを作る。macOS の一時ディレクトリはシンボリックリンクを通るので、pwd と比べられるよう正規化する
function newDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "accompany-cwd-")));
  dirs.push(dir);
  return dir;
}

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "$");
  return page;
}

async function cd(page: Page, n: number, dir: string) {
  await typeInPane(page, n, `cd '${dir}' && echo moved\n`);
  await expectPaneToShow(page, n, "moved");
}

async function focus(page: Page, n: number) {
  await pane(page, n).locator(".xterm-screen").click();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

// ターミナル n のシェルで pwd を動かし、その結果の行が dir と一致することを確かめる
async function expectPwd(page: Page, n: number, dir: string) {
  await expectPaneToShow(page, n, "$");
  await typeInPane(page, n, "pwd\n");
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(
    pane(page, n)
      .locator(".xterm-rows > div")
      .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
  ).toHaveCount(1);
}

// ターミナルのバーに出る、そのターミナルにフォーカスしている人の表示
function focusBadge(page: Page, n: number, name: string) {
  return pane(page, n).getByRole("status").getByText(name, { exact: true });
}

test("シェルで cd してから分割すると、新しいシェルは同じディレクトリで始まる", async ({ browser }) => {
  accompany = await startAccompany([], shell);
  const page = await openAsParticipant(browser, accompany.url);
  const dir = newDir();

  await cd(page, 1, dir);
  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();

  await expectPwd(page, 2, dir);
});

test("シェルの前面で別のディレクトリのプロセスが動いているときに分割すると、そのプロセスのディレクトリで始まる", async ({
  browser,
}) => {
  accompany = await startAccompany([], shell);
  const page = await openAsParticipant(browser, accompany.url);
  const shellDir = newDir();
  const foregroundDir = newDir();

  await cd(page, 1, shellDir);
  // シェルは shellDir のまま、前面のプロセス（cat）だけが foregroundDir で動く
  await typeInPane(page, 1, `/bin/sh -c 'cd "$1" && echo started && exec cat' - '${foregroundDir}'\n`);
  await expectPaneToShow(page, 1, "started");
  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();

  await expectPwd(page, 2, foregroundDir);
});

test("新しい Workspace は、ほかの参加者ではなく自分がフォーカスしているターミナルのディレクトリで始まる", async ({
  browser,
}) => {
  accompany = await startAccompany([], shell);
  const host = await openAsParticipant(browser, accompany.url);
  const first = newDir();
  const second = newDir();
  await pane(host, 1).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(host, 2, "$");
  await cd(host, 1, first);
  await cd(host, 2, second);

  // 自分（host）はターミナル 2 に、あとから開いたもう 1 人の参加者（guest）はターミナル 1 にフォーカスする
  const guest = await openAsParticipant(browser, accompany.url);
  await focus(host, 2);
  await focus(guest, 1);
  await expect(focusBadge(host, 1, "参加者 2")).toBeVisible();
  await expect(focusBadge(host, 2, "あなた")).toBeVisible();

  await host.getByRole("button", { name: "新しい Workspace" }).click();

  await expect(host.getByRole("tab")).toHaveText(["Workspace 1", "Workspace 2"]);
  await expectPwd(host, 3, second);
});

test("キーボードショートカットで新しい Workspace を開いても、自分がフォーカスしているターミナルのディレクトリで始まる", async ({
  browser,
}) => {
  accompany = await startAccompany([], shell);
  const page = await openAsParticipant(browser, accompany.url);
  const first = newDir();
  const second = newDir();
  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(page, 2, "$");
  await cd(page, 1, first);
  await cd(page, 2, second);
  await focus(page, 2);

  await page.keyboard.press("Control+Shift+O");

  await expect(page.getByRole("tab")).toHaveText(["Workspace 1", "Workspace 2"]);
  await expectPwd(page, 3, second);
});

test("フォーカスしているターミナルがない参加者が新しい Workspace を開くと、Accompany を起動したディレクトリで始まる", async ({
  browser,
}) => {
  accompany = await startAccompany([], shell);
  const page = await openAsParticipant(browser, accompany.url);
  await cd(page, 1, newDir());

  // ターミナルを 1 つも表示していない参加者として、Workspace の接続だけを開いて新しい Workspace を頼む
  await page.evaluate(
    (url) =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket(url);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "new-tab" }));
          resolve();
        };
      }),
    `${accompany.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws/workspace`,
  );

  await expect(page.getByRole("tab")).toHaveText(["Workspace 1", "Workspace 2"]);
  await expectPwd(page, 2, launchDir);
});

test("作業していたディレクトリが消えていたら、分割したシェルは Accompany を起動したディレクトリで始まる", async ({
  browser,
}) => {
  accompany = await startAccompany([], shell);
  const page = await openAsParticipant(browser, accompany.url);
  const dir = newDir();
  await cd(page, 1, dir);
  rmSync(dir, { recursive: true, force: true });

  await pane(page, 1).getByRole("button", { name: "下に分割" }).click();

  await expectPwd(page, 2, launchDir);
});
