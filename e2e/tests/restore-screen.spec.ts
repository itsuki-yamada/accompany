import { expect, test, type Browser, type Page } from "@playwright/test";
import { closeContexts, newContext, startAccompany, type Accompany } from "./accompany";
import { boxAndText, expectTerminalToShow, terminalScreen, typeInTerminal } from "./terminal";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await closeContexts();
  await accompany?.stop();
});

// 参加者ごとに別のブラウザコンテキストで開く
async function openAsParticipant(browser: Browser, url: string) {
  const context = await newContext(browser);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

test("途中から参加した人の画面に、参加前の出力が表示される", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-agent.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "Fake Agent ready");
  await typeInTerminal(host, "before guest joins\n");
  await expectTerminalToShow(host, "Agent received: before guest joins");

  const guest = await openAsParticipant(browser, accompany.url);

  await expectTerminalToShow(guest, "Fake Agent ready");
  await expectTerminalToShow(guest, "Agent received: before guest joins");
});

test("全画面の TUI でも、途中から参加した人に現在の画面が表示される", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-tui.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "count: 0");
  await typeInTerminal(host, "\n\n\n");
  await expectTerminalToShow(host, "count: 3");

  const guest = await openAsParticipant(browser, accompany.url);

  await expectTerminalToShow(guest, "Fake TUI");
  await expectTerminalToShow(guest, "count: 3");
  // 同じ位置に描き直しているので、古い値は残らない
  await expect(terminalScreen(guest)).not.toContainText("count: 2");
});

test("TUI がカーソルを隠しているとき、途中から参加した人の画面でもカーソルが隠れている", async ({
  browser,
}) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-tui.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "count: 0");
  await expect(host.locator(".xterm-rows .xterm-cursor")).toHaveCount(0);

  const guest = await openAsParticipant(browser, accompany.url);

  await expectTerminalToShow(guest, "count: 0");
  await expect(guest.locator(".xterm-rows .xterm-cursor")).toHaveCount(0);
});

test("途中から参加した直後の出力も、取りこぼさずに表示される", async ({ browser }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/fake-agent.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "Fake Agent ready");

  const guest = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(guest, "Fake Agent ready");
  await typeInTerminal(host, "after guest joins\n");

  await expectTerminalToShow(guest, "Agent received: after guest joins");
});

// text を含む行の左端から、右へ少しドラッグする
async function dragAlongRow(page: Page, text: string) {
  const row = page.locator(".xterm-rows > div").filter({ hasText: text }).last();
  const box = await boxAndText(row);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, y, { steps: 2 });
  await page.mouse.up();
}

// 画面に出ている、アプリが受け取った入力の行
async function reports(page: Page) {
  return ((await terminalScreen(page).textContent()) ?? "").match(/keys: [0-9a-f ]+?(?=keys:|$)/g) ?? [];
}

test("マウスの報告モードを使う TUI では、途中から参加した人のドラッグも、TUI が指定した形式（SGR）で届く", async ({
  browser,
}) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/mouse-reporter.ts"]);
  const host = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(host, "Mouse reporter ready");
  // TUI が動き始めたときから開いている人のドラッグは、SGR 形式（ESC [ < 32 ...）で届く
  await dragAlongRow(host, "Mouse reporter ready");
  await expectTerminalToShow(host, "keys: 1b 5b 3c 33 32");
  // 離したことの報告（SGR 形式では m で終わる）まで届いてから数える
  await expect.poll(async () => (await reports(host)).join("\n")).toMatch(/6d *$/);
  const before = (await reports(host)).length;

  const guest = await openAsParticipant(browser, accompany.url);
  await expectTerminalToShow(guest, "Mouse reporter ready");
  await dragAlongRow(guest, "Mouse reporter ready");

  // 途中から参加した人のドラッグも、同じ SGR 形式で届く。従来の形式（ESC [ M ...）になると、ブラウザが送らずアプリに届かない
  // ドラッグの報告（SGR 形式では ESC [ < 32、従来の形式では ESC [ M に 0x40）が届くまで待ってから比べる
  const received = async () => (await reports(host)).slice(before).join("\n");
  await expect.poll(received).toMatch(/1b 5b 3c 33 32|1b 5b 4d 40/);
  expect(await received()).toContain("1b 5b 3c 33 32");
  expect(await received()).not.toContain("1b 5b 4d");
});
