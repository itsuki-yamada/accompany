import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

// savedName を渡すと、そのブラウザに名前が保存されている状態で開く
async function openAsParticipant(browser: Browser, url: string, savedName?: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  if (savedName !== undefined) {
    await context.addInitScript((name) => {
      // 開き直したときに上書きしないよう、まだ保存していないときだけ入れる
      if (sessionStorage.getItem("e2e-name-set")) return;
      sessionStorage.setItem("e2e-name-set", "1");
      localStorage.setItem("accompany.name", name);
    }, savedName);
  }
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

async function startSession(browser: Browser) {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  return { host, guest };
}

// 自分の名前の入力欄。表示の設定の画面にある
async function nameInput(page: Page) {
  const dialog = page.getByRole("dialog", { name: "表示の設定" });
  if (!(await dialog.isVisible())) await page.getByRole("button", { name: "表示の設定" }).click();
  return dialog.getByRole("textbox", { name: "あなたの名前" });
}

// 名前を入力して確定する（Enter）
async function setName(page: Page, name: string) {
  const input = await nameInput(page);
  await input.fill(name);
  await input.press("Enter");
}

async function clickPane(page: Page, n: number) {
  await pane(page, n).locator(".xterm-screen").click();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

// ターミナルのバーに出る、そのターミナルにフォーカスしている人の名前
function barViewer(page: Page, n: number, name: string) {
  return pane(page, n).getByRole("status").getByText(name, { exact: true });
}

// ツールバーの参加者の一覧
function toolbarMember(page: Page, name: string) {
  return page.getByRole("navigation", { name: "ツールバー" }).getByRole("group", { name: "参加者" }).getByRole("button", {
    name: `${name} とペアプロ`,
    exact: true,
  });
}

function sidebarViewers(page: Page) {
  return page.getByRole("complementary", { name: "サイドメニュー" }).locator(".session-viewers .viewer");
}

test("名前を設定すると、ほかの参加者のターミナルのバー・ツールバー・サイドメニュー・ペアプロモードの表示・選択範囲に、その名前で出る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 1);
  await expect(barViewer(guest, 1, "参加者 1")).toBeVisible();

  await setName(host, "やまだ");
  await setName(guest, "すずき");
  await host.keyboard.press("Escape");
  await guest.keyboard.press("Escape");

  await expect(barViewer(guest, 1, "やまだ")).toBeVisible();
  await expect(barViewer(guest, 1, "参加者 1")).toHaveCount(0);
  await expect(toolbarMember(guest, "やまだ")).toBeVisible();
  await expect(toolbarMember(host, "すずき")).toBeVisible();
  await expect(sidebarViewers(guest).getByText("やまだ", { exact: true })).toBeVisible();

  // ペアプロモードの表示（追従している側と、追従されている側）
  await toolbarMember(guest, "やまだ").click();
  await expect(guest.getByRole("status", { name: "ペアプロモード" })).toContainText("やまだ の画面に追従中");
  await expect(host.getByRole("status", { name: "あなたに追従している参加者" })).toHaveText(
    "すずき があなたの画面に追従中",
  );

  // 選択範囲にも、選択している人の名前が付く
  await pane(host, 1).locator(".xterm-rows > div").filter({ hasText: "Fake Shell ready" }).first().dblclick();
  await expect(pane(guest, 1).locator(".remote-selection").first()).toHaveAttribute("data-member", "やまだ");
});

test("設定した名前はブラウザに覚えておき、開き直しても使われる", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await setName(host, "やまだ");
  await expect(toolbarMember(guest, "やまだ")).toBeVisible();

  await host.reload();
  await expectPaneToShow(host, 1, "Fake Shell ready");
  // 開き直すと参加者の番号は変わるが、名前はそのまま
  await expect(toolbarMember(guest, "やまだ")).toBeVisible();
  await expect(await nameInput(host)).toHaveValue("やまだ");
});

test("名前を設定していない参加者は「参加者 N」と出る。名前を空にすると「参加者 N」に戻る", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await expect(toolbarMember(guest, "参加者 1")).toBeVisible();
  await expect(await nameInput(host)).toHaveValue("");
  await expect(await nameInput(host)).toHaveAttribute("placeholder", "参加者 1");

  await setName(host, "やまだ");
  await expect(toolbarMember(guest, "やまだ")).toBeVisible();

  await setName(host, "   ");
  await expect(toolbarMember(guest, "参加者 1")).toBeVisible();
  await expect(toolbarMember(guest, "やまだ")).toHaveCount(0);

  // 空にしたことも覚えておく
  await host.reload();
  await expectPaneToShow(host, 1, "Fake Shell ready");
  await expect(toolbarMember(guest, "参加者 3")).toBeVisible();
});

test("名前の制御文字・双方向テキストの制御文字・改行を取り除き、長すぎる名前は切り詰める", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  // 入力欄を通さずに保存された名前も、サーバーが整える
  const host = await openAsParticipant(browser, accompany.url, "‮やま\u0007だ\nさん⁦");
  const guest = await openAsParticipant(browser, accompany.url, "あ".repeat(100));

  await expect(toolbarMember(guest, "やまだ さん")).toBeVisible();
  await expect(toolbarMember(host, "あ".repeat(32))).toBeVisible();
});

test("同じ名前の参加者がいるときは、参加者の番号を添えて見分ける", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await setName(host, "やまだ");
  await setName(guest, "やまだ");

  await expect(toolbarMember(guest, "やまだ（参加者 1）")).toBeVisible();
  await expect(toolbarMember(host, "やまだ（参加者 2）")).toBeVisible();

  // 片方が名前を変えると、番号は付かなくなる
  await setName(guest, "すずき");
  await expect(toolbarMember(guest, "やまだ")).toBeVisible();
  await expect(toolbarMember(host, "すずき")).toBeVisible();
});
