import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane } from "./panes";

const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
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

// ターミナルのバーに出る、そのターミナルにフォーカスしている人の名前。ほかの参加者の名前は、押すとその人とペアプロするボタン
function followButton(page: Page, n: number, name: string) {
  return pane(page, n).getByRole("button", { name: `${name} とペアプロ` });
}

// ツールバーの参加者の一覧。ほかの参加者の名前は、押すとその人とペアプロするボタン
function toolbarPairButton(page: Page, name: string) {
  return page.getByRole("navigation", { name: "ツールバー" }).getByRole("group", { name: "参加者" }).getByRole("button", {
    name: `${name} とペアプロ`,
  });
}

// ペアプロモード（相手の画面に追従している）であることと、誰に追従しているか
function followIndicator(page: Page) {
  return page.getByRole("status", { name: "ペアプロモード" });
}

// 自分の画面に追従している参加者
function followedIndicator(page: Page) {
  return page.getByRole("status", { name: "あなたに追従している参加者" });
}

function stopButton(page: Page) {
  return followIndicator(page).getByRole("button", { name: "ペアプロをやめる" });
}

// 参加者 1・2 の色（サーバーが接続順に割り当てる）
const colorOf = { "参加者 1": "rgb(79, 195, 247)", "参加者 2": "rgb(255, 183, 77)" };

function workspace(page: Page) {
  return page.locator("#workspace");
}

function background(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((e) => getComputedStyle(e).backgroundColor);
}

async function expectFocusedOn(page: Page, n: number) {
  await expect(pane(page, n)).toHaveAttribute("data-focused", "true");
  // キー入力の先も、そのターミナルに移っている
  await expect(pane(page, n).locator(".xterm-helper-textarea")).toBeFocused();
}

test("ターミナルのバーのほかの参加者の名前を押すとペアプロモードになり、その人がフォーカスしたターミナルに自分のフォーカスも移る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await clickPane(guest, 1);

  await followButton(guest, 2, "参加者 1").click();

  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");
  await expect(followButton(guest, 2, "参加者 1")).toHaveAttribute("aria-pressed", "true");
  await expectFocusedOn(guest, 2);

  await clickPane(host, 3);
  await expectFocusedOn(guest, 3);
  // ペアプロモードで移ったフォーカスも、ほかの参加者に伝わる
  await expect(pane(host, 3).getByRole("status").getByText("参加者 2", { exact: true })).toBeVisible();

  await clickPane(host, 1);
  await expectFocusedOn(guest, 1);
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");

  // 相手と同じターミナルを操作しても、ペアプロモードは続く
  await clickPane(guest, 1);
  await clickPane(host, 2);
  await expectFocusedOn(guest, 2);
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");
});

test("ペアプロモードをやめると、相手がフォーカスを移しても自分のフォーカスは動かない", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  await stopButton(guest).click();
  await expect(followIndicator(guest)).toHaveCount(0);
  await clickPane(host, 3);
  await expect(pane(guest, 3).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 2)).toHaveAttribute("data-focused", "true");

  // 名前のボタンをもう一度押しても、ペアプロモードをやめられる
  await followButton(guest, 3, "参加者 1").click();
  await expectFocusedOn(guest, 3);
  await followButton(guest, 3, "参加者 1").click();
  await expect(followIndicator(guest)).toHaveCount(0);
  await expect(followButton(guest, 3, "参加者 1")).toHaveAttribute("aria-pressed", "false");
  await clickPane(host, 1);
  await expect(pane(guest, 1).getByRole("status").getByText("参加者 1", { exact: true })).toBeVisible();
  await expect(pane(guest, 3)).toHaveAttribute("data-focused", "true");
});

test("自分で別のターミナルをクリックすると、ペアプロモードをやめる", async ({ browser }) => {
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

test("自分でショートカットで隣のターミナルへ移ると、ペアプロモードをやめる", async ({ browser }) => {
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

test("追従している相手が抜けると、ペアプロモードをやめ、画面の色も戻る", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await followButton(guest, 2, "参加者 1").click();
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");

  await host.context().close();

  await expect(followIndicator(guest)).toHaveCount(0);
  await expect(workspace(guest)).toHaveCSS("outline-style", "none");
  await expect(pane(guest, 2)).toHaveAttribute("data-focused", "true");
});

test("ペアプロモードは自分の画面のフォーカスだけに効き、追従されている側やほかの参加者のフォーカスは動かない", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  const third = await openAsParticipant(browser, accompany!.url);
  await clickPane(host, 2);
  await clickPane(third, 3);

  await followButton(guest, 2, "参加者 1").click();
  await expectFocusedOn(guest, 2);

  // 追従されている側とほかの参加者は、ペアプロモードにならず、フォーカスも動かない
  await expect(followIndicator(host)).toHaveCount(0);
  await expect(followIndicator(third)).toHaveCount(0);
  await expectFocusedOn(host, 2);
  await expectFocusedOn(third, 3);

  // 追従していない参加者がフォーカスを移しても、追従しない
  await clickPane(third, 1);
  await expect(pane(guest, 1).getByRole("status").getByText("参加者 3", { exact: true })).toBeVisible();
  await expect(pane(guest, 2)).toHaveAttribute("data-focused", "true");
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");

  // 追従されている側は、これまでどおり自由に操作できる
  await clickPane(host, 3);
  await expectFocusedOn(host, 3);
  await expectFocusedOn(guest, 3);
  await expectFocusedOn(third, 1);
});

test("ツールバーの参加者の一覧から「〇〇とペアプロ」を押すとペアプロモードになり、画面の色が相手の色に変わる", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await clickPane(guest, 1);
  // 自分は一覧のボタンに出ない
  await expect(toolbarPairButton(guest, "参加者 2")).toHaveCount(0);
  const toolbarBefore = await background(guest, "#tabs");
  const barBefore = await background(guest, ".pane-bar");
  await expect(workspace(guest)).toHaveCSS("outline-style", "none");

  await toolbarPairButton(guest, "参加者 1").click();

  await expect(followIndicator(guest)).toContainText("ペアプロモード");
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");
  await expect(toolbarPairButton(guest, "参加者 1")).toHaveAttribute("aria-pressed", "true");
  await expectFocusedOn(guest, 2);
  // 画面の縁を相手の色で太く囲み、ツールバーとターミナルのバーに相手の色を薄く敷く。端末の中（文字と背景）は変えない
  await expect(workspace(guest)).toHaveCSS("outline-color", colorOf["参加者 1"]);
  await expect(workspace(guest)).toHaveCSS("outline-width", "4px");
  expect(await background(guest, "#tabs")).not.toBe(toolbarBefore);
  expect(await background(guest, ".pane-bar")).not.toBe(barBefore);
  await guest.screenshot({ path: test.info().outputPath("pair-mode-follower.png") });

  await clickPane(host, 3);
  await expectFocusedOn(guest, 3);

  // ツールバーの「ペアプロをやめる」でやめると、色が戻る
  await stopButton(guest).click();
  await expect(followIndicator(guest)).toHaveCount(0);
  await expect(toolbarPairButton(guest, "参加者 1")).toHaveAttribute("aria-pressed", "false");
  await expect(workspace(guest)).toHaveCSS("outline-style", "none");
  expect(await background(guest, "#tabs")).toBe(toolbarBefore);
  expect(await background(guest, ".pane-bar")).toBe(barBefore);

  // 一覧のボタンをもう一度押しても、やめられる
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(followIndicator(guest)).toBeVisible();
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(followIndicator(guest)).toHaveCount(0);
});

test("追従されている側には、誰が自分に追従しているかが出て、ペアプロモードをやめると消える", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  const third = await openAsParticipant(browser, accompany!.url);
  await clickPane(host, 2);
  await expect(followedIndicator(host)).toHaveCount(0);

  await toolbarPairButton(guest, "参加者 1").click();

  await expect(followedIndicator(host)).toContainText("参加者 2 があなたの画面に追従中");
  // 追従されている側は、画面の縁を追従している人の色で細く囲む
  await expect(workspace(host)).toHaveCSS("outline-color", colorOf["参加者 2"]);
  await expect(workspace(host)).toHaveCSS("outline-width", "2px");
  // 関係のない参加者には出ない
  await expect(followedIndicator(third)).toHaveCount(0);
  await expect(followedIndicator(guest)).toHaveCount(0);
  await host.screenshot({ path: test.info().outputPath("pair-mode-followed.png") });

  // 2 人に追従されると、2 人とも出る
  await toolbarPairButton(third, "参加者 1").click();
  await expect(followedIndicator(host)).toContainText("参加者 2、参加者 3 があなたの画面に追従中");

  await stopButton(guest).click();
  await expect(followedIndicator(host)).toContainText("参加者 3 があなたの画面に追従中");
  // 自分で別のターミナルを操作してやめたときも、消える
  await clickPane(third, 1);
  await expect(followIndicator(third)).toHaveCount(0);
  await expect(followedIndicator(host)).toHaveCount(0);
  await expect(workspace(host)).toHaveCSS("outline-style", "none");
});

test("追従している人が抜けると、追従されている側の表示も消える", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await clickPane(host, 2);
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(followedIndicator(host)).toContainText("参加者 2 があなたの画面に追従中");

  await guest.context().close();

  await expect(followedIndicator(host)).toHaveCount(0);
  await expect(workspace(host)).toHaveCSS("outline-style", "none");
});

test("相手と別のターミナルのバーで検索を開くと、ペアプロモードをやめ、相手が動いても入力中の検索欄から動かない", async ({
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

test("相手と別のターミナルで右クリックメニューを開くと、ペアプロモードをやめる", async ({ browser }) => {
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

test("Workspace の切り替えより先に相手のフォーカス先が届いても、切り替えたあとにそのターミナルへ移る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  // Workspace 2 にターミナル 4・5 を並べ、host はターミナル 5 にいる
  await host.getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(host, 4, "Fake Shell ready");
  await pane(host, 4).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 5, "Fake Shell ready");
  await clickPane(host, 5);

  // 配置用の WebSocket を中継するページで開き直し、host が Workspace 1 のターミナル 3 にフォーカスしたことが届くまで、
  // Workspace の切り替えを止めておく（行き違いを起こす）。切り替えを届けたあとは参加者のフォーカス先を届けず、
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
  await host.getByRole("tab", { name: "Workspace 1", exact: true }).click();
  await clickPane(host, 3);

  // 枠の色は自分のフォーカス先が presence で戻ってきてから付くので、ここではキー入力の先だけを確かめる
  await expect(pane(page, 3).locator(".xterm-helper-textarea")).toBeFocused();
  await expect(followIndicator(page)).toContainText("参加者 1 の画面に追従中");
});

test("自分の画面で拡大していても、相手が隠れているターミナルへ移るとそこへ移り、枠に収まらなければそのターミナルを拡大する", async ({
  browser,
}) => {
  // 端末の大きさは、host の枠に入る範囲で下限（幅 480 のウィンドウに収まる列数）まで広げるので、画面の小さい guest では
  // 分割した枠に収まらず、フォーカスしているターミナルを拡大する（docs/adr/68-zoom.md、docs/adr/99-smallest-size.md）
  accompany = await startAccompany([], fakeShell, { minWindow: "480x0" });
  const host = await openAsParticipant(browser, accompany.url);
  await pane(host, 1).getByRole("button", { name: "右に分割" }).click();
  await expectPaneToShow(host, 2, "Fake Shell ready");
  await clickPane(host, 1);
  const context = await newContext(browser, { viewport: { width: 800, height: 720 } });
  const guest = await context.newPage();
  await guest.goto(accompany.url);
  await expectPaneToShow(guest, 1, "Fake Shell ready");
  await expect(pane(guest, 1).getByText("拡大中")).toBeVisible();

  await followButton(guest, 1, "参加者 1").click();
  await expectFocusedOn(guest, 1);

  await clickPane(host, 2);
  await expectFocusedOn(guest, 2);
  await expect(pane(guest, 2).getByText("拡大中")).toBeVisible();
  await expect(guest.locator('.pane[aria-label="ターミナル 1"]')).toBeHidden();
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");

  // 拡大は追従されている側には反映しない
  await expect(pane(host, 1)).toBeVisible();
  await expect(pane(host, 2).getByText("拡大中")).toBeHidden();
});

// スクロールの追従。起動時のコマンド（command）の出力で、スクロールバックを作る。
// 参加者ごとに、届いた presence を記録し（「動かない」ことを確かめる前に、相手の位置が届いたのを待つため）、
// dropScroll の間は、その参加者が送るスクロール位置をサーバーに届けない
type Participant = { page: Page; presence: Member[][]; dropScroll: boolean };
type Member = { id: number; following?: number; scroll?: { terminal: string; offset: number } };
const longOutput = ["--", "bun", "e2e/fixtures/long-output.ts"];

async function startScrollSession(browser: Browser, command = longOutput, ready = "line 200") {
  accompany = await startAccompany(command, fakeShell);
  const open = async () => {
    const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const participant: Participant = { page, presence: [], dropScroll: false };
    await page.routeWebSocket(/\/ws\/workspace$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (participant.dropScroll && JSON.parse(message.toString()).type === "scroll") return;
        server.send(message);
      });
      server.onMessage((message) => {
        const event = JSON.parse(message.toString());
        if (event.type === "presence") participant.presence.push(event.members);
        ws.send(message);
      });
    });
    await page.goto(accompany!.url);
    await expectPaneToShow(page, 1, ready);
    return participant;
  };
  const host = await open();
  const guest = await open();
  return { host, guest };
}

// その参加者に最後に届いた presence での、参加者 id のスクロール位置
function scrollOf(participant: Participant, id: number) {
  return participant.presence.at(-1)?.find((m) => m.id === id)?.scroll?.offset;
}

function rows(page: Page) {
  return pane(page, 1).locator(".xterm-rows");
}

const firstLine = /line 1(?!\d)/;

// ホイールで一番上（line 1 が見えるところ）まで戻す。ホイール 1 回では 3 行ほどしか動かないので、戻り切る回数（200 行より多く）を続けて回す
async function scrollToTop(page: Page) {
  await pane(page, 1).locator(".xterm-screen").hover();
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -2000);
  await expect(rows(page)).toContainText(firstLine);
}

async function scrollToBottom(page: Page, last = "line 200") {
  await pane(page, 1).locator(".xterm-screen").hover();
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, 2000);
  await expect(rows(page)).toContainText(last);
}

test("ペアプロモードの間は、相手のスクロール位置にも追従する", async ({ browser }) => {
  const { host: h, guest: g } = await startScrollSession(browser);
  const [host, guest] = [h.page, g.page];
  // 追従する前のスクロールは、相手に影響しない
  await scrollToTop(host);
  await expect(rows(guest)).not.toContainText(firstLine);

  // 始めたときに、相手のいまのスクロール位置に合わせる
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(rows(guest)).toContainText(firstLine);

  await scrollToBottom(host);
  await expect(rows(guest)).toContainText("line 200");
  await expect(rows(guest)).not.toContainText(firstLine);

  await scrollToTop(host);
  await expect(rows(guest)).toContainText(firstLine);

  // 追従されている側は、追従している人のスクロールには合わせない（追従している人が動いたのを見てから確かめる）
  await pane(guest, 1).locator(".xterm-screen").hover();
  await guest.mouse.wheel(0, 300);
  await expect(rows(guest)).not.toContainText(firstLine);
  await expect(rows(host)).toContainText(firstLine);
});

test("自分でスクロールすると、ペアプロモードのまま、スクロールの追従だけを止め、戻すボタンで相手の位置に戻る", async ({
  browser,
}) => {
  const { host: h, guest: g } = await startScrollSession(browser);
  const [host, guest] = [h.page, g.page];
  await toolbarPairButton(guest, "参加者 1").click();
  await scrollToTop(host);
  await expect(rows(guest)).toContainText(firstLine);

  // 自分でスクロールしても、ペアプロモードはやめず、スクロールの追従を止めていることを出す
  await scrollToBottom(guest);
  await expect(followIndicator(guest)).toContainText("参加者 1 の画面に追従中");
  await expect(followIndicator(guest)).toContainText("スクロールは追従していません");

  // 相手がスクロールしても、自分の位置は動かない（相手の新しい位置が届いてから確かめる）
  const before = scrollOf(g, 1);
  await pane(host, 1).locator(".xterm-screen").hover();
  await host.mouse.wheel(0, 300);
  await expect(rows(host)).not.toContainText(firstLine);
  await expect.poll(() => scrollOf(g, 1)).not.toBe(before);
  await expect(rows(guest)).toContainText("line 200");

  // 戻すと、相手のいまの位置に合わせ、また追従する
  await followIndicator(guest).getByRole("button", { name: "相手のスクロール位置に戻る" }).click();
  await expect(followIndicator(guest)).not.toContainText("スクロールは追従していません");
  await expect(rows(guest)).not.toContainText("line 200");
  await scrollToBottom(host);
  await expect(rows(guest)).toContainText("line 200");
});

test("一番下でホイールを回して画面が動かなければ、出力が流れても、スクロールの追従は止めない", async ({ browser }) => {
  // 出力し続けるコマンドで、一番下にいる間も画面が流れ続ける
  const { host: h, guest: g } = await startScrollSession(
    browser,
    ["--", "bun", "e2e/fixtures/long-ticker.ts"],
    "tick 1",
  );
  const [host, guest] = [h.page, g.page];
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(followedIndicator(host)).toBeVisible();

  // 一番下で下へ回しても画面は動かない。回している間も、そのあとも、出力は流れる
  await pane(guest, 1).locator(".xterm-screen").hover();
  for (let i = 0; i < 5; i++) {
    await guest.mouse.wheel(0, 300);
    await guest.waitForTimeout(100);
  }
  const tick = Number((await rows(guest).innerText()).match(/tick (\d+)\s*$/)?.[1]);
  await expect(rows(guest)).toContainText(`tick ${tick + 3}`);
  await expect(followIndicator(guest)).not.toContainText("スクロールは追従していません");

  // 相手がスクロールすれば、追従する
  await scrollToTop(host);
  await expect.poll(() => scrollOf(g, 1)).toBeGreaterThan(0);
  await expect(rows(guest)).toContainText(firstLine);
});

test("スクロールバーを押してしばらくしてからドラッグしても、自分でスクロールしたものとして、追従を止める", async ({
  browser,
}) => {
  const { host: h, guest: g } = await startScrollSession(browser);
  const [host, guest] = [h.page, g.page];
  await toolbarPairButton(guest, "参加者 1").click();
  await expect(followedIndicator(host)).toBeVisible();

  // スクロールバーはターミナルの上にマウスがあるときに出る
  await pane(guest, 1).locator(".xterm-screen").hover();
  const slider = pane(guest, 1).locator(".scrollbar.vertical .slider");
  await expect(slider).toBeVisible();
  const box = (await slider.boundingBox())!;
  await guest.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await guest.mouse.down();
  await guest.waitForTimeout(800);
  await guest.mouse.move(box.x + box.width / 2, 0, { steps: 10 });
  await guest.mouse.up();

  await expect(rows(guest)).toContainText(firstLine);
  await expect(followIndicator(guest)).toContainText("スクロールは追従していません");
});

test("ペアプロモードをやめたあとの古いスクロール位置には、始め直しても飛ばない", async ({ browser }) => {
  const { host: h, guest: g } = await startScrollSession(browser);
  const [host, guest] = [h.page, g.page];
  await toolbarPairButton(guest, "参加者 1").click();
  await scrollToTop(host);
  await expect(rows(guest)).toContainText(firstLine);

  // やめたあとに相手が一番下へ戻る。追従されていないので、相手の位置は送られない
  await stopButton(guest).click();
  await expect(followedIndicator(host)).toHaveCount(0);
  await scrollToBottom(host);
  await scrollToBottom(guest);

  // 始め直したとき、相手がいまの位置を送るより先に、やめる前の位置（一番上）へ飛ばない。
  // 相手がいまの位置を送っても届かないようにして、サーバーに古い位置が残っていないことを確かめる
  h.dropScroll = true;
  await toolbarPairButton(guest, "参加者 1").click();
  await expect.poll(() => g.presence.at(-1)?.find((m) => m.id === 2)?.following).toBe(1);
  expect(scrollOf(g, 1)).toBeUndefined();
  await expect(rows(guest)).toContainText("line 200");
});
