import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";
import { terminalScreen } from "./terminal";

const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];
// ブラケットペーストを有効にしたまま、受け取った入力を JSON の文字列で表示する
const pasteReporter = ["--", "bun", "e2e/fixtures/paste-reporter.ts"];

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function open(browser: Browser, url: string, ready: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expect(terminalScreen(page)).toContainText(ready);
  return page;
}

type Command = { name: string; content: string; run?: boolean };

function commandMenu(page: Page) {
  return page.getByRole("menu", { name: "ターミナル 1 のコマンド" });
}

// ターミナルのバーの「コマンド」ボタンで、登録したコマンドの一覧を開く
async function openCommandMenu(page: Page) {
  await pane(page, 1).getByRole("button", { name: "コマンド", exact: true }).click();
  await expect(commandMenu(page)).toBeVisible();
}

function editor(page: Page) {
  return page.getByRole("dialog", { name: "よく使うコマンド" });
}

async function openEditor(page: Page) {
  await openCommandMenu(page);
  await commandMenu(page).getByRole("menuitem", { name: "コマンドを管理…" }).click();
  await expect(editor(page)).toBeVisible();
}

async function fillForm(page: Page, { name, content, run = false }: Command) {
  await editor(page).getByRole("textbox", { name: "名前" }).fill(name);
  await editor(page).getByRole("textbox", { name: "内容" }).fill(content);
  await editor(page).getByRole("checkbox", { name: "Enter まで送る（すぐ実行）" }).setChecked(run);
}

async function register(page: Page, command: Command) {
  await openEditor(page);
  await fillForm(page, command);
  await editor(page).getByRole("button", { name: "登録" }).click();
  await expect(registered(page, command.name)).toBeVisible();
  await editor(page).getByRole("button", { name: "閉じる" }).click();
  await expect(editor(page)).toBeHidden();
}

function registered(page: Page, name: string) {
  return editor(page).getByRole("listitem").filter({ hasText: name });
}

async function choose(page: Page, name: string) {
  await openCommandMenu(page);
  await commandMenu(page).getByRole("menuitem", { name }).click();
  await expect(commandMenu(page)).toBeHidden();
}

test("コマンドを登録していないときは、一覧に登録がないことと管理の項目が出る", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const page = await open(browser, accompany.url, "Fake Agent ready");

  await openCommandMenu(page);

  await expect(commandMenu(page).getByRole("menuitem", { name: "登録したコマンドはありません" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(commandMenu(page).getByRole("menuitem", { name: "コマンドを管理…" })).toBeVisible();
});

test("登録したコマンドを選ぶと、ターミナルに入力される。既定では Enter は送らない", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const page = await open(browser, accompany.url, "Fake Agent ready");
  await register(page, { name: "テスト", content: "npm test" });

  await choose(page, "テスト");

  await expectPaneToShow(page, 1, "npm test");
  // Enter を送っていないので、まだコマンドには届かない
  await page.waitForTimeout(500);
  await expect(terminalScreen(page)).not.toContainText("Agent received");
  // 選んだあとは、キー入力の先がそのターミナルに戻っている。続けて入力して Enter で送れる
  await page.keyboard.type(" --watch");
  await page.keyboard.press("Enter");
  await expectPaneToShow(page, 1, "Agent received: npm test --watch");
});

test("「Enter まで送る」にしたコマンドは、選ぶとすぐに実行される", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const page = await open(browser, accompany.url, "Fake Agent ready");
  await register(page, { name: "レビュー", content: "/review", run: true });

  await choose(page, "レビュー");

  await expectPaneToShow(page, 1, "Agent received: /review");
});

test("登録したコマンドを編集できる", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const page = await open(browser, accompany.url, "Fake Agent ready");
  await register(page, { name: "テスト", content: "npm test" });

  await openEditor(page);
  await registered(page, "テスト").getByRole("button", { name: "テスト を編集" }).click();
  await expect(editor(page).getByRole("textbox", { name: "内容" })).toHaveValue("npm test");
  await fillForm(page, { name: "全部のテスト", content: "npm run test:all", run: true });
  await editor(page).getByRole("button", { name: "保存" }).click();
  await expect(registered(page, "全部のテスト")).toBeVisible();
  await expect(editor(page).getByRole("listitem")).toHaveCount(1);
  await editor(page).getByRole("button", { name: "閉じる" }).click();

  await choose(page, "全部のテスト");

  await expectPaneToShow(page, 1, "Agent received: npm run test:all");
});

test("登録したコマンドを削除すると、一覧から消える", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const page = await open(browser, accompany.url, "Fake Agent ready");
  await register(page, { name: "テスト", content: "npm test" });

  await openEditor(page);
  await registered(page, "テスト").getByRole("button", { name: "テスト を削除" }).click();
  await expect(editor(page).getByRole("listitem")).toHaveCount(0);
  await editor(page).getByRole("button", { name: "閉じる" }).click();

  await openCommandMenu(page);
  await expect(commandMenu(page).getByRole("menuitem", { name: "テスト" })).toHaveCount(0);
});

test("登録したコマンドは参加者全員で共有し、登録・編集・削除がほかの参加者にも反映される", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const host = await open(browser, accompany.url, "Fake Agent ready");
  const guest = await open(browser, accompany.url, "Fake Agent ready");

  await register(host, { name: "テスト", content: "npm test", run: true });

  // ほかの参加者も、登録されたコマンドを選んで実行できる
  await choose(guest, "テスト");
  await expectPaneToShow(host, 1, "Agent received: npm test");

  // 編集はほかの参加者の一覧にも反映される
  await openEditor(host);
  await registered(host, "テスト").getByRole("button", { name: "テスト を編集" }).click();
  await editor(host).getByRole("textbox", { name: "名前" }).fill("ビルド");
  await editor(host).getByRole("button", { name: "保存" }).click();
  await openCommandMenu(guest);
  await expect(commandMenu(guest).getByRole("menuitem", { name: "ビルド" })).toBeVisible();
  await guest.keyboard.press("Escape");

  // 削除もほかの参加者の一覧に反映される
  await registered(host, "ビルド").getByRole("button", { name: "ビルド を削除" }).click();
  await openCommandMenu(guest);
  await expect(commandMenu(guest).getByRole("menuitem", { name: "ビルド" })).toHaveCount(0);
  await expect(commandMenu(guest).getByRole("menuitem", { name: "登録したコマンドはありません" })).toBeVisible();
});

test("途中から参加した人にも、登録済みのコマンドが出る", async ({ browser }) => {
  accompany = await startAccompany(fakeAgent);
  const host = await open(browser, accompany.url, "Fake Agent ready");
  await register(host, { name: "テスト", content: "npm test" });

  const guest = await open(browser, accompany.url, "Fake Agent ready");

  await openCommandMenu(guest);
  await expect(commandMenu(guest).getByRole("menuitem", { name: "テスト" })).toBeVisible();
});

test("複数行のコマンドは貼り付けと同じく、ブラケットペーストで入力する", async ({ browser }) => {
  accompany = await startAccompany(pasteReporter);
  const page = await open(browser, accompany.url, "Paste reporter ready");
  await register(page, { name: "2 行", content: "line1\nline2" });

  await choose(page, "2 行");

  // 改行は端末の Enter と同じ CR にし、全体をブラケットペーストで囲む
  await expectPaneToShow(page, 1, 'received: "\\u001b[200~line1\\rline2\\u001b[201~"');
});

test("改行とタブ以外の制御文字は、登録するときに取り除く", async ({ browser }) => {
  accompany = await startAccompany(pasteReporter);
  const page = await open(browser, accompany.url, "Paste reporter ready");
  await register(page, { name: "制御文字", content: "a\u001b[31mb\u0007\tc" });

  await choose(page, "制御文字");

  await expectPaneToShow(page, 1, 'received: "\\u001b[200~a[31mb\\tc\\u001b[201~"');
});
