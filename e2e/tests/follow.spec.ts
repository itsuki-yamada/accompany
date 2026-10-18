import { expect, test, type Browser, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, "Fake Shell ready");
  return page;
}

// host（参加者 1）が開いて、ターミナルを 3 つに分割する。guest（参加者 2）はそのあとで開く
async function startSession(browser: Browser) {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await pane(host, 2).getByRole("button", { name: "下に分割" }).click();
  await expectPaneToShow(host, 3, "Fake Shell ready");
  const guest = await openAsParticipant(browser, accompany.url);
  return { host, guest };
}

async function clickPane(page: Page, n: number) {
  await pane(page, n).locator(".xterm-screen").click();
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
}

// ターミナルのバーに出る、そのターミナルにフォーカスしている人の名前。ほかの参加者の名前は、押すとフォローするボタン
function followButton(page: Page, n: number, name: string) {
  return pane(page, n).getByRole("button", { name: `${name} をフォロー` });
}

// フォロー中であることと、誰をフォローしているか
function followIndicator(page: Page) {
  return page.getByRole("status", { name: "フォロー" });
}

async function expectFocusedOn(page: Page, n: number) {
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
  // キー入力の先も、そのターミナルに移っている
  await expect(pane(page, n).locator(".xterm-helper-textarea")).toBeFocused();
}

test("ほかの参加者の名前を押すとフォローし、その人がフォーカスしたターミナルに自分のフォーカスも移る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await clickPane(guest, 1);

  await followButton(guest, 2, "参加者 1").click();

  await expect(followIndicator(guest)).toContainText("参加者 1 をフォロー中");
  await expect(followButton(guest, 2, "参加者 1")).toHaveAttribute("aria-pressed", "true");
  await expectFocusedOn(guest, 2);

  await clickPane(host, 3);
  await expectFocusedOn(guest, 3);
  // フォローで移ったフォーカスも、ほかの参加者に伝わる
  await expect(pane(host, 3).getByRole("status").getByText("参加者 2", { exact: true })).toBeVisible();

  await clickPane(host, 1);
  await expectFocusedOn(guest, 1);
  await expect(followIndicator(guest)).toContainText("参加者 1 をフォロー中");

  // 相手と同じターミナルを操作しても、フォローは続く
  await clickPane(guest, 1);
  await clickPane(host, 2);
  await expectFocusedOn(guest, 2);
  await expect(followIndicator(guest)).toContainText("参加者 1 をフォロー中");
});

test("フォローをやめると、相手がフォーカスを移しても自分のフォーカスは動かない", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  await followIndicator(guest).getByRole("button", { name: "フォローをやめる" }).click();
  await expect(followIndicator(guest)).toHaveCount(0);
  await clickPane(host, 3);
  await expect(pane(guest, 3).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 2)).toHaveAttribute("data-focused", "true");

  // 名前のボタンをもう一度押しても、フォローをやめられる
  await followButton(guest, 3, "参加者 1").click();
  await expectFocusedOn(guest, 3);
  await followButton(guest, 3, "参加者 1").click();
  await expect(followIndicator(guest)).toHaveCount(0);
  await expect(followButton(guest, 3, "参加者 1")).toHaveAttribute("aria-pressed", "false");
  await clickPane(host, 1);
  await expect(pane(guest, 1).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 3)).toHaveAttribute("data-focused", "true");
});

test("自分で別のターミナルをクリックすると、フォローをやめる", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  await clickPane(guest, 1);

  await expect(followIndicator(guest)).toHaveCount(0);
  await clickPane(host, 3);
  await expect(pane(guest, 3).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 1)).toHaveAttribute("data-focused", "true");
});

test("自分でショートカットで隣のターミナルへ移ると、フォローをやめる", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  await guest.keyboard.press("Control+Shift+ArrowLeft");

  await expectFocusedOn(guest, 1);
  await expect(followIndicator(guest)).toHaveCount(0);
  await clickPane(host, 3);
  await expect(pane(guest, 3).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 1)).toHaveAttribute("data-focused", "true");
});

test("フォローしている相手が抜けると、フォローをやめる", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expect(followIndicator(guest)).toContainText("参加者 1 をフォロー中");

  await host.context().close();

  await expect(followIndicator(guest)).toHaveCount(0);
  await expect(pane(guest, 2)).toHaveAttribute("data-focused", "true");
});

test("フォローは自分の画面だけに効き、フォローされている側やほかの参加者の画面は変わらない", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  const third = await openAsParticipant(browser, accompany!.url);
  await clickPane(host, 2);
  await clickPane(third, 3);

  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  // フォローされている側とほかの参加者には、フォロー中の表示が出ず、フォーカスも動かない
  await expect(followIndicator(host)).toHaveCount(0);
  await expect(followIndicator(third)).toHaveCount(0);
  await expectFocusedOn(host, 2);
  await expectFocusedOn(third, 3);

  // フォローしていない参加者がフォーカスを移しても、追従しない
  await clickPane(third, 1);
  await expect(pane(guest, 1).getByRole("status").getByText("参加者 3", { exact: true })).toBeVisible();
  await expect(pane(guest, 2)).toHaveAttribute("data-focused", "true");
  await expect(followIndicator(guest)).toContainText("参加者 1 をフォロー中");

  // フォローされている側は、これまでどおり自由に操作できる
  await clickPane(host, 3);
  await expectFocusedOn(host, 3);
  await expectFocusedOn(guest, 3);
  await expectFocusedOn(third, 1);
});

test("相手と別のターミナルのバーで検索を開くと、フォローをやめ、相手が動いても入力中の検索欄から動かない", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  await pane(guest, 1).getByRole("button", { name: "検索" }).click();
  const searchInput = pane(guest, 1).getByRole("textbox", { name: "検索する文字" });
  await expect(searchInput).toBeFocused();
  await expect(followIndicator(guest)).toHaveCount(0);

  await clickPane(host, 3);
  await expect(pane(guest, 3).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(searchInput).toBeFocused();
});

test("相手と別のターミナルで右クリックメニューを開くと、フォローをやめる", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  await pane(guest, 1).locator(".xterm-screen").click({ button: "right" });
  await expect(guest.getByRole("menu")).toBeVisible();
  await expect(followIndicator(guest)).toHaveCount(0);
  await guest.keyboard.press("Escape");

  await clickPane(host, 3);
  await expect(pane(guest, 3).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 3)).not.toHaveAttribute("data-focused", "true");
});

test("タブの切り替えより先に相手のフォーカス先が届いても、切り替えたあとにそのターミナルへ移る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  // タブ 2 にターミナル 4・5 を並べ、host はターミナル 5 にいる
  await host.getByRole("button", { name: "新しいタブ" }).click();
  await expectPaneToShow(host, 4, "Fake Shell ready");
  await pane(host, 4).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 5, "Fake Shell ready");
  await clickPane(host, 5);

  // 配置用の WebSocket を中継するページで開き直し、host がタブ 1 のターミナル 3 にフォーカスしたことが届くまで、
  // タブの切り替えを止めておく（行き違いを起こす）。切り替えを届けたあとは参加者のフォーカス先を届けず、
  // 配置を組み立てたときにフォーカスを移すことを確かめる
  const page = await guest.context().newPage();
  let holding = false;
  let released = false;
  let held: (string | Buffer)[] = [];
  await page.routeWebSocket(/\/ws\/workspace$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const event = JSON.parse(message.toString());
      if (holding && event.type === "tabs") return void held.push(message);
      if (released && event.type === "presence") return;
      ws.send(message);
      const hostOn =
        event.type === "presence" ? event.members.find((m: { id: number }) => m.id === 1)?.terminal : undefined;
      if (holding && hostOn === "3") {
        holding = false;
        released = true;
        held.forEach((m) => ws.send(m));
        held = [];
      }
    });
  });
  await guest.close();
  await page.goto(accompany!.url);
  await expectPaneToShow(page, 4, "Fake Shell ready");
  await followButton(page, 5, "参加者 1").click();
  await expectFocusedOn(page, 5);

  holding = true;
  await host.getByRole("tab", { name: "タブ 1", exact: true }).click();
  await clickPane(host, 3);

  // 枠の色は自分のフォーカス先が presence で戻ってきてから付くので、ここではキー入力の先だけを確かめる
  await expect(pane(page, 3).locator(".xterm-helper-textarea")).toBeFocused();
  await expect(followIndicator(page)).toContainText("参加者 1 をフォロー中");
});
