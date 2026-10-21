import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, panes, typeInPane } from "./panes";

// 新しい Workspace は $SHELL を起動するので、入力をそのまま返す偽のシェルにする
const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string, viewport = { width: 1280, height: 720 }) {
  const context = await newContext(browser, { viewport });
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

function tab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

function tabs(page: Page) {
  return page.getByRole("tab");
}

async function openNewTab(page: Page) {
  await page.getByRole("button", { name: "新しい Workspace" }).click();
}

async function exitShell(page: Page, n: number) {
  // 偽のシェル（cat）は、行頭の Ctrl+D で入力が終わると終了する
  await pane(page, n).locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Control+D");
}

test("新しい Workspace を開くと、Workspace 2 が追加されて表示され、新しいシェルを操作できる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(tabs(page)).toHaveText(["Workspace 1"]);

  await openNewTab(page);

  await expect(tabs(page)).toHaveText(["Workspace 1", "Workspace 2"]);
  await expect(tab(page, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await expect(pane(page, 1)).toHaveCount(0);
  await typeInPane(page, 2, "typed in tab 2\n");
  await expectPaneToShow(page, 2, "typed in tab 2");
});

test("Workspace を切り替えると、切り替える前の画面がそのまま戻る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await typeInPane(page, 1, "typed in tab 1\n");
  await expectPaneToShow(page, 1, "typed in tab 1");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await tab(page, "Workspace 1").click();

  await expect(tab(page, "Workspace 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 1, "typed in tab 1");
  await expect(pane(page, 2)).toHaveCount(0);
});

test("各 Workspace は、それぞれ独立した分割の配置を持つ", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await pane(page, 2).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");

  await tab(page, "Workspace 1").click();
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await expect(panes(page)).toHaveCount(1);

  await tab(page, "Workspace 2").click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  await expect(panes(page)).toHaveCount(2);
});

test("Workspace を閉じると、その Workspace がなくなり、残りの Workspace が表示される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await page.getByRole("button", { name: "Workspace 2 を閉じる" }).click();

  await expect(tabs(page)).toHaveText(["Workspace 1"]);
  await expect(tab(page, "Workspace 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(page, 1, "Fake Shell ready");
});

test("Workspace を閉じると、その Workspace のターミナルがすべて終了する", async ({ browser }, testInfo) => {
  // 偽のシェルが、起動するたびにプロセス ID を書き足す
  const pidFile = testInfo.outputPath("pids");
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/pid-shell", E2E_PID_FILE: pidFile });
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");
  await pane(page, 2).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(page, 3, "Fake Shell ready");
  const pids = async () => (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  await expect.poll(async () => (await pids()).length).toBe(3);
  const [tab1Shell, ...tab2Shells] = await pids();
  expect(tab2Shells.every(isAlive)).toBe(true);

  await page.getByRole("button", { name: "Workspace 2 を閉じる" }).click();

  await expect(tabs(page)).toHaveText(["Workspace 1"]);
  await expect.poll(() => tab2Shells.some(isAlive)).toBe(false);
  expect(isAlive(tab1Shell!)).toBe(true);
  // 閉じた Workspace のターミナルにはつなげない
  expect(await connectTo(page, 2)).toBe("error");
  expect(await connectTo(page, 3)).toBe("error");
  expect(await connectTo(page, 1)).toBe("open");
});

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ブラウザからターミナルの入出力の WebSocket につないでみる
function connectTo(page: Page, terminal: number) {
  return page.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/terminals/${id}`);
        socket.onopen = () => {
          socket.close();
          resolve("open");
        };
        socket.onerror = () => resolve("error");
      }),
    terminal,
  );
}

test("最後の Workspace は閉じられない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await expect(page.getByRole("button", { name: "Workspace 1 を閉じる" })).toBeDisabled();
});

test("Workspace の最後のターミナルのシェルを終了すると、その Workspace が閉じる", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  await openNewTab(page);
  await expectPaneToShow(page, 2, "Fake Shell ready");

  await exitShell(page, 2);

  await expect(tabs(page)).toHaveText(["Workspace 1"]);
  await expectPaneToShow(page, 1, "Fake Shell ready");
});

test("最後の Workspace の最後のターミナルのシェルを終了しても、Workspace とターミナルは残る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const page = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(page, 1, "Fake Shell ready");

  await exitShell(page, 1);

  // シェルが終了したことを画面から知る手がかりがないので、少し待ってから残っていることを確かめる
  await page.waitForTimeout(500);
  await expect(tabs(page)).toHaveText(["Workspace 1"]);
  await expect(panes(page)).toHaveCount(1);
});

test("Workspace の追加・切り替え・閉じる操作が、参加者全員の画面に反映される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expectPaneToShow(guest, 1, "Fake Shell ready");

  await openNewTab(host);
  await expect(tabs(guest)).toHaveText(["Workspace 1", "Workspace 2"]);
  await expect(tab(guest, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(guest, 2, "Fake Shell ready");

  await tab(guest, "Workspace 1").click();
  await expect(tab(host, "Workspace 1")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(host, 1, "Fake Shell ready");

  await host.getByRole("button", { name: "Workspace 2 を閉じる" }).click();
  await expect(tabs(guest)).toHaveText(["Workspace 1"]);
});

test("途中から参加した人に、Workspace の並びと表示中の Workspace、その画面が復元される", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await openNewTab(host);
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await typeInPane(host, 2, "before guest joins\n");
  await expectPaneToShow(host, 2, "before guest joins");

  const guest = await openAsParticipant(browser, accompany.url);

  await expect(tabs(guest)).toHaveText(["Workspace 1", "Workspace 2"]);
  await expect(tab(guest, "Workspace 2")).toHaveAttribute("aria-selected", "true");
  await expectPaneToShow(guest, 2, "before guest joins");
});

test("Workspace を切り替えても、切り替えた先の Workspace でターミナルにフォーカスしている人の表示が出る", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expectPaneToShow(guest, 1, "Fake Shell ready");

  await openNewTab(host);
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await pane(host, 2).locator(".xterm-screen").click();
  await pane(guest, 2).locator(".xterm-screen").click();

  // 先に開いた host が参加者 1、あとから開いた guest が参加者 2
  const badge = (page: Page, n: number, name: string) =>
    pane(page, n).getByRole("status").getByText(name, { exact: true });
  await expect(badge(host, 2, "あなた")).toBeVisible();
  await expect(badge(host, 2, "参加者 2")).toBeVisible();
  await expect(badge(guest, 2, "参加者 1")).toBeVisible();
  await expect(pane(host, 2)).toHaveAttribute("data-focused", "true");

  // Workspace 1 に戻っても、フォーカスしている人の表示が出る
  await tab(guest, "Workspace 1").click();
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await pane(host, 1).locator(".xterm-screen").click();
  await pane(guest, 1).locator(".xterm-screen").click();

  await expect(badge(host, 1, "あなた")).toBeVisible();
  await expect(badge(host, 1, "参加者 2")).toBeVisible();
  await expect(badge(guest, 1, "あなた")).toBeVisible();
  await expect(badge(guest, 1, "参加者 1")).toBeVisible();
  await expect(pane(host, 1)).toHaveAttribute("data-focused", "true");
});

test("新しい Workspace のターミナルも、参加者のうち一番小さい画面に合わせた大きさになり、画面の大きい人は周りが余白になる", async ({
  browser,
}) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/size-shell" });
  const large = { width: 1280, height: 720 };
  const host = await openAsParticipant(browser, accompany.url, large);
  const small = { width: 640, height: 400 };
  const guest = await openAsParticipant(browser, accompany.url, small);
  await expectPaneToShow(host, 1, "size:");

  await openNewTab(host);

  // コマンドから見えている端末のサイズ（最後に表示したもの）が 2 人で同じになり、小さい画面に収まる
  const size = async (page: Page) => {
    const text = (await pane(page, 2).locator(".xterm-rows").textContent()) ?? "";
    return [...text.matchAll(/size: (\d+)x(\d+)/g)].at(-1)?.slice(1).join("x") ?? "";
  };
  await expect.poll(() => size(guest)).not.toMatch(/^(80x24)?$/);
  await expect.poll(async () => (await size(host)) === (await size(guest))).toBe(true);
  const guestBox = (await pane(guest, 2).locator(".xterm-screen").boundingBox())!;
  expect(guestBox.x + guestBox.width).toBeLessThanOrEqual(small.width);
  expect(guestBox.y + guestBox.height).toBeLessThanOrEqual(small.height);
  const overflows = (page: Page) =>
    pane(page, 2)
      .locator(".pane-terminal")
      .evaluate((e) => e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight);
  expect(await overflows(guest)).toBe(false);
  // 画面の大きい人は、端末の周りが余白になる
  const hostBox = (await pane(host, 2).locator(".xterm-screen").boundingBox())!;
  expect(hostBox.width).toBeLessThan(small.width);
  expect(await overflows(host)).toBe(false);
});

test("cd でディレクトリを移動して新しい Workspace を開くと、新しいシェルがそのディレクトリで始まる", async ({ browser }) => {
  accompany = await startAccompany([], { SHELL: "/bin/sh" });
  const page = await openAsParticipant(browser, accompany.url);

  await typeInPane(page, 1, "cd /tmp\n");
  await openNewTab(page);

  await expect(tabs(page)).toHaveText(["Workspace 1", "Workspace 2"]);
  await typeInPane(page, 2, "pwd\n");
  await expectPaneToShow(page, 2, "/tmp");
});
