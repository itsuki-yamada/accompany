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
  // 行の要素は端末の画面の層の下にあるので、位置を測ってダブルクリックし、先頭の語（Fake）を選択する
  const line = pane(host, 1).locator(".xterm-rows > div").filter({ hasText: "Fake Shell ready" }).first();
  const row = (await line.boundingBox())!;
  await host.mouse.dblclick(row.x + 10, row.y + row.height / 2);
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

// ページが横にはみ出していない（横スクロールが出ない）
async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
}

test("長い名前でも、ペアプロモードの表示やツールバーが崩れず、ページが横にはみ出さない", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  // 幅の広い文字（U+FDFD）で上限まで付けた名前
  const wide = "﷽".repeat(32);
  const host = await openAsParticipant(browser, accompany.url, wide);
  const guest1 = await openAsParticipant(browser, accompany.url, "あ".repeat(32));
  const guest2 = await openAsParticipant(browser, accompany.url, "い".repeat(32));
  await clickPane(host, 1);

  await toolbarMember(guest1, wide).click();
  await toolbarMember(guest2, wide).click();
  await expect(guest1.getByRole("status", { name: "ペアプロモード" })).toContainText(`${wide} の画面に追従中`);
  await expect(host.getByRole("status", { name: "あなたに追従している参加者" })).toHaveText(
    `${"あ".repeat(32)}、${"い".repeat(32)} があなたの画面に追従中`,
  );

  await expectNoHorizontalOverflow(host);
  await expectNoHorizontalOverflow(guest1);
  // ツールバーのボタン（表示の設定）も画面の中に残る
  for (const page of [host, guest1]) {
    const box = (await page.getByRole("button", { name: "表示の設定" }).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
  }
});

test("見えない文字だけの名前は、名前を設定していないものとする", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  // ゼロ幅スペース・ZWNJ・BOM・タグ文字・ソフトハイフン・ハングルのフィラー・点字の空白・CGJ・VS16
  const host = await openAsParticipant(
    browser,
    accompany.url,
    "​‌﻿\u{e0041}­ㅤ⠀͏️",
  );
  const guest = await openAsParticipant(browser, accompany.url);

  await expect(toolbarMember(guest, "参加者 1")).toBeVisible();
});

test("対になっていないサロゲートは取り除き、絵文字は見た目の 1 文字ずつ数えて切り詰める", async ({ browser }) => {
  accompany = await startAccompany([], fakeShell);
  const family = "\u{1f468}‍\u{1f469}‍\u{1f467}";
  const host = await openAsParticipant(browser, accompany.url, "やま\ud800だ");
  const guest = await openAsParticipant(browser, accompany.url, family.repeat(40));

  await expect(toolbarMember(guest, "やまだ")).toBeVisible();
  await expect(toolbarMember(host, family.repeat(32))).toBeVisible();
});

test("見た目の区別しにくい名前（全角と半角、見えない文字や結合文字を足したもの）も、同じ名前として番号を添える", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await setName(host, "ＡＢＣ");
  await setName(guest, "ABC");
  await expect(toolbarMember(guest, "ＡＢＣ（参加者 1）")).toBeVisible();
  await expect(toolbarMember(host, "ABC（参加者 2）")).toBeVisible();

  await setName(host, "やまだ͏");
  await setName(guest, "やまだ️");
  await expect(toolbarMember(guest, "やまだ͏（参加者 1）")).toBeVisible();
  await expect(toolbarMember(host, "やまだ️（参加者 2）")).toBeVisible();
});

test("自分で付けた名前が、ほかの参加者の既定の名前（参加者 N）と同じときも、番号を添えて見分ける", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await setName(host, "参加者 2");

  await expect(toolbarMember(guest, "参加者 2（参加者 1）")).toBeVisible();
  await expect(toolbarMember(host, "参加者 2（参加者 2）")).toBeVisible();
});
