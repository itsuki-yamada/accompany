import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, newStateDir, startAccompany, type Accompany } from "./accompany";
import { addToView, expectPaneToShow, pane, tab } from "./panes";

// タブ（ターミナル）に付ける名前。全員で共有し、サーバーが持つ（docs/adr/110-tab-name.md）。
// 新しいタブは、入力した行（「2;タイトル」）をタイトルに設定する偽のシェルにする
const titleShell = { SHELL: "e2e/fixtures/title-shell" };
// 出力を出してから止まる偽のエージェント（「work」で 3 秒作業する）
const busyAgent = ["--", "e2e/fixtures/agents/claude"];

let accompany: Accompany | undefined;
let stateDir: string;

test.beforeEach(() => {
  stateDir = newStateDir();
});

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
  await rm(join(stateDir, ".."), { recursive: true, force: true });
});

// 再起動をまたいで同じ保存先を使う
function start(args: string[] = []) {
  return startAccompany(args, { ...titleShell, ACCOMPANY_STATE_DIR: stateDir });
}

// ブラウザの通知（Notification API）を差し替えて、出した通知を記録し、ページが見えているかをテストから切り替えられるようにする
async function openAsParticipant(browser: Browser, url: string, ready = "Title setter ready") {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    const w = window as any;
    w.notifications = [];
    w.FakeNotification = class {
      static permission = "granted";
      static async requestPermission() {
        return "granted";
      }
      onclick: (() => void) | null = null;
      constructor(readonly title: string) {
        w.notifications.push(this);
      }
      close() {}
    };
    Object.defineProperty(window, "Notification", { value: w.FakeNotification });
    let hidden = false;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible") });
    w.setHidden = (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, ready);
  return page;
}

function sidebar(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" });
}

function toolbar(page: Page) {
  return page.getByRole("navigation", { name: "ツールバー" });
}

function sidebarToggle(page: Page) {
  return page.getByRole("button", { name: "サイドメニュー", exact: true });
}

// ターミナルのバーに出る名前
function barName(page: Page, n: number) {
  return pane(page, n).locator(".pane-title");
}

// 名前を付けるときの入力欄
function nameEditor(page: Page) {
  return page.getByRole("textbox", { name: "ターミナルの名前" });
}

function namedTab(page: Page, name: string) {
  return page.getByRole("tab", { name, exact: true });
}

async function rename(page: Page, name: string) {
  await expect(nameEditor(page)).toBeFocused();
  await nameEditor(page).fill(name);
  await nameEditor(page).press("Enter");
  await expect(nameEditor(page)).toHaveCount(0);
}

async function openNewTab(page: Page, n: number) {
  await page.getByRole("button", { name: "新しいタブ" }).first().click();
  await expectPaneToShow(page, n, "Title setter ready");
}

async function setTitle(page: Page, n: number, line: string) {
  await pane(page, n).locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(line);
  await page.keyboard.press("Enter");
}

// 改造したブラウザなどから、配置の WebSocket に直接送る
function sendRaw(page: Page, messages: object[]) {
  return page.evaluate(
    (messages) =>
      new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/ws/workspace`);
        socket.onopen = () => {
          for (const message of messages) socket.send(JSON.stringify(message));
          setTimeout(() => {
            socket.close();
            resolve();
          }, 200);
        };
      }),
    messages,
  );
}

test("バーの名前をダブルクリックして名前を付けると、全員のバー・サイドメニュー・ツールバーに出る", async ({ browser }) => {
  accompany = await start();
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  await barName(host, 1).dblclick();
  await expect(nameEditor(host)).toHaveAttribute("placeholder", "ターミナル 1");
  await rename(host, "app");

  // 付け終えると、ターミナルに戻る
  await expect(pane(host, 1).locator(".xterm-helper-textarea")).toBeFocused();
  for (const page of [host, guest]) {
    await expect(barName(page, 1)).toHaveText("app");
    await expect(sidebar(page).getByRole("tab")).toHaveText([/app/]);
  }
  await expect(namedTab(guest, "app")).toHaveAttribute("aria-selected", "true");
  await expect(sidebar(guest).getByRole("button", { name: "app を閉じる" })).toBeVisible();
  await sidebarToggle(guest).click();
  await expect(toolbar(guest).getByRole("tab")).toHaveText(["app"]);
});

test("サイドメニュー・ツールバーのタブのダブルクリックと、右クリックのメニューからも名前を付けられ、Esc でやめられる", async ({
  browser,
}) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openNewTab(page, 2);
  await tab(page, 1).click();
  await expect(pane(page, 1)).toBeVisible();

  // 表示していないタブをダブルクリックしても、そのタブに切り替わったあとで入力欄からキー入力の先を奪わない
  await tab(page, 2).dblclick();
  await page.waitForTimeout(500);
  await rename(page, "e2e");
  await expect(namedTab(page, "e2e")).toBeVisible();

  // Esc でやめると、名前は変わらない
  await namedTab(page, "e2e").dblclick();
  await expect(nameEditor(page)).toHaveValue("e2e");
  await nameEditor(page).fill("zzz");
  await nameEditor(page).press("Escape");
  await expect(nameEditor(page)).toHaveCount(0);
  await expect(namedTab(page, "e2e")).toBeVisible();

  // サイドメニューのタブの右クリックのメニュー
  await tab(page, 1).click({ button: "right" });
  await page.getByRole("menu", { name: "ターミナル 1 のタブのメニュー" }).getByRole("menuitem", { name: "名前を変更…" }).click();
  await rename(page, "app");
  await expect(sidebar(page).getByRole("tab")).toHaveText([/app/, /e2e/]);

  // ツールバーのタブのダブルクリックと右クリックのメニュー
  await sidebarToggle(page).click();
  await namedTab(page, "e2e").dblclick();
  await rename(page, "env");
  await namedTab(page, "env").click({ button: "right" });
  await page.getByRole("menu", { name: "env のタブのメニュー" }).getByRole("menuitem", { name: "名前を変更…" }).click();
  await rename(page, "env2");
  await expect(toolbar(page).getByRole("tab")).toHaveText(["app", "env2"]);

  // ターミナルの右クリックのメニュー
  await pane(page, 2).locator(".xterm-screen").click({ button: "right" });
  await page.getByRole("menu", { name: "ターミナル 2 のメニュー" }).getByRole("menuitem", { name: "名前を変更…" }).click();
  await rename(page, "logs");
  await expect(barName(page, 2)).toHaveText("logs");
});

test("入力欄を離れたときにも名前が決まる", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);

  // バーの入力欄から、ターミナルを押して離れる
  await barName(page, 1).dblclick();
  await expect(nameEditor(page)).toBeFocused();
  await nameEditor(page).fill("app");
  await pane(page, 1).locator(".xterm-screen").click();
  await expect(nameEditor(page)).toHaveCount(0);
  await expect(barName(page, 1)).toHaveText("app");
  await expect(barName(guest, 1)).toHaveText("app");

  // サイドメニューの入力欄から、サイドメニューの見出しを押して離れる
  await namedTab(page, "app").dblclick();
  await expect(nameEditor(page)).toBeFocused();
  await nameEditor(page).fill("app2");
  await sidebar(page).getByRole("heading", { name: "タブ" }).click();
  await expect(nameEditor(page)).toHaveCount(0);
  await expect(namedTab(page, "app2")).toBeVisible();
  await expect(barName(guest, 1)).toHaveText("app2");
});

test("名前を空にすると、これまでどおりの表示（「ターミナル N」と、コマンドが設定したタイトル）に戻る", async ({
  browser,
}) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await setTitle(page, 1, "2;vim notes.md");
  await expect(pane(page, 1).locator(".pane-program")).toHaveText("vim notes.md");

  // 名前を付けても、コマンドが設定したタイトルは並んで出る
  await barName(page, 1).dblclick();
  await rename(page, "notes");
  await expect(barName(page, 1)).toHaveText("notes");
  await expect(pane(page, 1).locator(".pane-program")).toHaveText("vim notes.md");
  await expect(namedTab(page, "notes")).toContainText("vim notes.md");

  await barName(page, 1).dblclick();
  await expect(nameEditor(page)).toHaveValue("notes");
  await rename(page, "   ");
  await expect(barName(page, 1)).toHaveText("ターミナル 1");
  await expect(pane(page, 1).locator(".pane-program")).toHaveText("vim notes.md");
  await expect(tab(page, 1)).toContainText("vim notes.md");
  await sidebarToggle(page).click();
  await expect(toolbar(page).getByRole("tab")).toHaveText(["ターミナル 1"]);
});

test("付けた名前は保存され、起動し直しても残る", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openNewTab(page, 2);
  await barName(page, 2).dblclick();
  await rename(page, "e2e");
  await accompany.stop();

  accompany = await start();
  const restarted = await openAsParticipant(browser, accompany.url);
  await expect(sidebar(restarted).getByRole("tab")).toHaveText([/ターミナル 1/, /e2e/]);
  await namedTab(restarted, "e2e").click();
  await expect(barName(restarted, 2)).toHaveText("e2e");
});

test("作業が終わったときの通知と未確認の表示にも、付けた名前が出る", async ({ browser }) => {
  accompany = await start(busyAgent);
  const page = await openAsParticipant(browser, accompany.url, "Busy Agent ready");
  await barName(page, 1).dblclick();
  await rename(page, "agent");

  await pane(page, 1).locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("work\n");
  await expect(pane(page, 1).getByRole("status", { name: "エージェントの状態" })).toHaveText("作業中", { timeout: 5_000 });
  await page.evaluate(() => (window as any).setHidden(true));

  await expect
    .poll(() => page.evaluate(() => (window as any).notifications.map((n: { title: string }) => n.title)), {
      timeout: 10_000,
    })
    .toEqual(["agent: 指示待ち"]);
  await expect(namedTab(page, "agent")).toContainText("未確認");
});

test("名前の制御文字・双方向テキストの制御文字・改行を取り除き、長すぎる名前は切り詰め、見えない文字だけなら付けていないものとする", async ({
  browser,
}) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openNewTab(page, 2);
  await addToView(page, 1);

  await sendRaw(page, [{ type: "rename-tab", tab: "1", name: "‮ap\u0007p\nサーバー⁦" }]);
  await expect(barName(page, 1)).toHaveText("app サーバー");

  await sendRaw(page, [{ type: "rename-tab", tab: "2", name: "あ".repeat(100) }]);
  await expect(barName(page, 2)).toHaveText("あ".repeat(32));

  await sendRaw(page, [{ type: "rename-tab", tab: "2", name: "​‌﻿⠀" }]);
  await expect(barName(page, 2)).toHaveText("ターミナル 2");

  // 形の正しくないもの、ないタブへのものは無視する
  await sendRaw(page, [
    { type: "rename-tab", tab: "1", name: 123 },
    { type: "rename-tab", tab: "1" },
    { type: "rename-tab", tab: 1, name: "x" },
    { type: "rename-tab", tab: "9", name: "x" },
  ]);
  await page.waitForTimeout(300);
  await expect(barName(page, 1)).toHaveText("app サーバー");
  await expect(sidebar(page).getByRole("tab")).toHaveText([/app サーバー/, /ターミナル 2/]);
});

test("ほかのタブと見分けにくい名前（ほかのタブの「ターミナル N」など）には、番号を添えて見分ける", async ({ browser }) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  await openNewTab(page, 2);
  await openNewTab(page, 3);

  await sendRaw(page, [{ type: "rename-tab", tab: "1", name: "ターミナル 2" }]);
  await expect(sidebar(page).getByRole("tab")).toHaveText([
    /ターミナル 2（ターミナル 1）/,
    /^ターミナル 2$/,
    /ターミナル 3/,
  ]);

  await sendRaw(page, [
    { type: "rename-tab", tab: "1", name: "ＡＰＰ" },
    { type: "rename-tab", tab: "3", name: "APP" },
  ]);
  await expect(sidebar(page).getByRole("tab")).toHaveText([
    /ＡＰＰ（ターミナル 1）/,
    /^ターミナル 2$/,
    /APP（ターミナル 3）/,
  ]);

  // 空白を詰めたり全角にしたりした「ターミナル N」、番号を添えた形（「名前（ターミナル N）」）をまねた名前にも添える
  for (const [name, shown] of [
    ["ターミナル2", /ターミナル2（ターミナル 1）/],
    // 全角の空白は、整えるときに半角の空白になる
    ["ターミナル　２", /ターミナル ２（ターミナル 1）/],
    ["app（ターミナル 2）", /app（ターミナル 2）（ターミナル 1）/],
    ["app(ターミナル3)", /app\(ターミナル3\)（ターミナル 1）/],
  ] as const) {
    await sendRaw(page, [
      { type: "rename-tab", tab: "3", name: "" },
      { type: "rename-tab", tab: "1", name },
    ]);
    await expect(sidebar(page).getByRole("tab"), name).toHaveText([shown, /^ターミナル 2$/, /^ターミナル 3(あなた)?$/]);
  }
});

test("長い名前でも、バー・サイドメニュー・ツールバーが崩れず、ページが横にはみ出さない。全文はツールチップで見られる", async ({
  browser,
}) => {
  accompany = await start();
  const page = await openAsParticipant(browser, accompany.url);
  const wide = "﷽".repeat(32);
  await sendRaw(page, [{ type: "rename-tab", tab: "1", name: wide }]);
  await expect(barName(page, 1)).toHaveText(wide);
  await expect(barName(page, 1)).toHaveAttribute("title", wide);

  const noOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await expect.poll(noOverflow).toBeLessThanOrEqual(0);
  // バーのボタン（閉じる）と、サイドメニューのボタン（閉じる）が画面の中に残る
  const close = (await pane(page, 1).getByRole("button", { name: "閉じる" }).boundingBox())!;
  expect(close.x + close.width).toBeLessThanOrEqual(1280);
  const sidebarBox = (await sidebar(page).boundingBox())!;
  const sidebarClose = (await sidebar(page).getByRole("button", { name: `${wide} を閉じる` }).boundingBox())!;
  expect(sidebarClose.x + sidebarClose.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width);

  await sidebarToggle(page).click();
  await expect.poll(noOverflow).toBeLessThanOrEqual(0);
  const settings = (await page.getByRole("button", { name: "表示の設定" }).boundingBox())!;
  expect(settings.x + settings.width).toBeLessThanOrEqual(1280);
});
