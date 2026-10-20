import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { expectPaneToShow, pane, typeInPane } from "./panes";

const fakeShell = { SHELL: "e2e/fixtures/fake-shell" };

// 参加者の色（サーバーが接続順に割り当てる）
const hostColor = /rgba?\(79, 195, 247/;
const guestColor = /rgba?\(255, 183, 77/;

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

async function openAsParticipant(browser: Browser, url: string, ready = "Fake Shell ready") {
  const context = await newContext(browser, { viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(url);
  await expectPaneToShow(page, 1, ready);
  return page;
}

// host（参加者 1）と guest（参加者 2）が同じターミナルを開く
async function startSession(browser: Browser) {
  accompany = await startAccompany([], fakeShell);
  const host = await openAsParticipant(browser, accompany.url);
  const guest = await openAsParticipant(browser, accompany.url);
  return { host, guest };
}

// ターミナル 1 に描かれた、text を含む最後の行
function row(page: Page, text: string) {
  return pane(page, 1).locator(".xterm-rows > div").filter({ hasText: text }).last();
}

// 行の中の text の範囲（画面上の位置）。描かれた文字から測る
async function textBox(page: Page, line: string, text: string) {
  return row(page, line).evaluate((element, text) => {
    const start = (element.textContent ?? "").indexOf(text);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (start >= offset && start < offset + length) range.setStart(node, start - offset);
      if (start + text.length > offset && start + text.length <= offset + length) {
        range.setEnd(node, start + text.length - offset);
      }
      offset += length;
    }
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  }, text);
}

// 行の中の text を、マウスでドラッグして選択する
async function selectText(page: Page, line: string, text: string) {
  const box = await textBox(page, line, text);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, y, { steps: 5 });
  await page.mouse.up();
}

// ほかの参加者の選択範囲の表示
function remoteSelection(page: Page) {
  return pane(page, 1).locator(".remote-selection");
}

// 要素の位置を、端末の画面（.xterm-screen）の左上からの位置で表す。複数あれば全体を囲む範囲。
// 大きさのない要素（xterm は使わない行の選択の要素を、高さなしで残している）は除く。
// xterm は描き直すたびに要素を作り直すので、見つからなければ undefined を返す（呼ぶ側で取り直す）
type Box = { x: number; y: number; width: number; height: number };
async function boxInScreen(locator: Locator): Promise<Box | undefined> {
  return locator.evaluateAll((elements) => {
    const screen = elements[0]?.closest(".xterm-screen")?.getBoundingClientRect();
    const boxes = elements.map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    if (!screen || boxes.length === 0) return undefined;
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    const right = Math.max(...boxes.map((b) => b.right));
    const bottom = Math.max(...boxes.map((b) => b.bottom));
    return { x: left - screen.left, y: top - screen.top, width: right - left, height: bottom - top };
  });
}

// 自分の選択範囲（xterm が描く）
function ownSelection(page: Page) {
  return pane(page, 1).locator(".xterm-selection > div");
}

// 2 つの要素の位置と大きさが揃っていることを確かめる。only は、比べるもの（既定ではすべて）
async function expectSameBox(actual: Locator, expected: Locator, only: (keyof Box)[] = ["x", "y", "width", "height"]) {
  await expect
    .poll(async () => {
      const [a, e] = await Promise.all([boxInScreen(actual), boxInScreen(expected)]);
      if (!a || !e) return Infinity;
      return Math.max(...only.map((key) => Math.abs(a[key] - e[key])));
    })
    .toBeLessThan(1.5);
}

test("ほかの参加者がターミナルで選択している範囲が、その人の色で自分の画面にも出る。選択をやめると消える", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);

  await selectText(host, "Fake Shell ready", "Shell ready");

  await expect(ownSelection(host)).not.toHaveCount(0);
  await expect(remoteSelection(guest)).not.toHaveCount(0);
  await expect(remoteSelection(guest).first()).toHaveCSS("background-color", hostColor);
  // 選択した人の画面の選択範囲と、同じ位置・大きさに出る
  await expectSameBox(remoteSelection(guest), ownSelection(host));
  // 自分の選択範囲は、ほかの参加者の選択範囲としては出さない
  await expect(remoteSelection(host)).toHaveCount(0);

  // 選択をやめる（どこかをクリックする）と消える
  await pane(host, 1).locator(".xterm-screen").click({ position: { x: 300, y: 200 } });
  await expect(ownSelection(host)).toHaveCount(0);
  await expect(remoteSelection(guest)).toHaveCount(0);
});

test("ほかの参加者の選択範囲の上でも、自分で選択できる。自分の選択範囲は相手の画面に自分の色で出る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  await selectText(host, "Fake Shell ready", "Shell ready");
  await expect(remoteSelection(guest)).not.toHaveCount(0);

  await selectText(guest, "Fake Shell ready", "Fake Shell");

  await expect(ownSelection(guest)).not.toHaveCount(0);
  await expect(remoteSelection(host)).not.toHaveCount(0);
  await expect(remoteSelection(host).first()).toHaveCSS("background-color", guestColor);
  await expectSameBox(remoteSelection(host), ownSelection(guest));
  // 相手の選択はそのまま
  await expect(ownSelection(host)).not.toHaveCount(0);
  await expectSameBox(remoteSelection(guest), ownSelection(host));
});

test("出力で画面がスクロールしても、ほかの参加者の選択範囲は選択した文字についていく。途中から参加した人にも出る", async ({
  browser,
}) => {
  const { host, guest } = await startSession(browser);
  // 画面に収まらないだけ出力し、スクロールバックがある状態で選択する
  for (let i = 1; i <= 30; i++) await typeInPane(guest, 1, `line ${i}\n`);
  await expectPaneToShow(host, 1, "line 30");
  await selectText(host, "line 28", "line 28");
  await expect(remoteSelection(guest)).not.toHaveCount(0);
  await expectSameBox(remoteSelection(guest), ownSelection(host));

  for (let i = 31; i <= 33; i++) await typeInPane(guest, 1, `line ${i}\n`);
  await expectPaneToShow(host, 1, "line 33");

  // 選択範囲は、スクロールした「line 28」の行についていく
  await expectSameBox(remoteSelection(guest), ownSelection(host));
  await expectSameBox(remoteSelection(guest), row(guest, "line 28"), ["y", "height"]);

  // 途中から参加した人にも、同じ位置に出る
  const late = await openAsParticipant(browser, accompany!.url, "line 33");
  await expectSameBox(remoteSelection(late), ownSelection(host));
});

test("選択した人が抜けると、その人の選択範囲は消える", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await selectText(host, "Fake Shell ready", "Shell ready");
  await expect(remoteSelection(guest)).not.toHaveCount(0);

  await host.context().close();

  await expect(remoteSelection(guest)).toHaveCount(0);
});

test("Workspace を切り替えてターミナルを抜けると、選択範囲は消え、戻っても出ない", async ({ browser }) => {
  const { host, guest } = await startSession(browser);
  await selectText(host, "Fake Shell ready", "Shell ready");
  await expect(remoteSelection(guest)).not.toHaveCount(0);

  await host.getByRole("button", { name: "新しい Workspace" }).click();
  await expectPaneToShow(guest, 2, "Fake Shell ready");
  await guest.getByRole("tab", { name: "Workspace 1", exact: true }).click();
  await expectPaneToShow(guest, 1, "Fake Shell ready");
  await expectPaneToShow(host, 1, "Fake Shell ready");

  // 抜けたときに選択範囲がなくなっている（xterm の選択も消える）ので、戻っても出ない
  await expect(ownSelection(host)).toHaveCount(0);
  await expect(remoteSelection(guest)).toHaveCount(0);
});

test("範囲として正しくない選択範囲は、ほかの参加者に配らない", async ({ browser }) => {
  const { guest } = await startSession(browser);

  // 改造したブラウザなどから、配置の WebSocket に直接送る。届いた参加者の情報のうち、自分の選択範囲を集める
  const observed = await guest.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws/workspace`);
    const seen: unknown[] = [];
    let you: number | undefined;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "welcome") you = message.you;
      if (message.type === "presence") {
        seen.push(message.members.find((m: { id: number }) => m.id === you)?.selections);
      }
    };
    await new Promise((resolve) => (socket.onopen = resolve));
    const send = (message: object) => socket.send(JSON.stringify({ type: "select", terminal: "1", ...message }));
    const at = (x: unknown, y: unknown) => ({ x, y });
    send({ start: at(-1, 0), end: at(3, 0) });
    send({ start: at(0, 0), end: at(1.5, 0) });
    send({ start: at("0", 0), end: at(3, 0) });
    send({ start: at(0, 0), end: at(100000, 0) });
    send({ start: at(0, 0), end: at(0, 100000) });
    // 始まりが終わりより後ろ
    send({ start: at(5, 1), end: at(0, 1) });
    send({ start: at(0, 0) });
    // 存在しないターミナル
    socket.send(JSON.stringify({ type: "select", terminal: "99", start: at(0, 0), end: at(3, 0) }));
    send({ start: at(0, 0), end: at(4, 0) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    socket.close();
    return seen;
  });

  // 正しい選択範囲だけが配られる
  const valid = { "1": { start: { x: 0, y: 0 }, end: { x: 4, y: 0 } } };
  expect(observed.at(-1)).toEqual(valid);
  for (const selections of observed) expect([{}, valid]).toContainEqual(selections);
});
