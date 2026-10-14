import { expect, test } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, terminalScreen, typeInTerminal } from "./terminal";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

test("日本語入力では、変換を確定した文字だけがコマンドに届く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/key-reporter.ts"]);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Key reporter ready");
  await page.locator(".xterm-helper-textarea").focus();

  // IME で「にほんご」と打って変換し、「日本語」で確定する
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
  await cdp.send("Input.imeSetComposition", { text: "日本語", selectionStart: 3, selectionEnd: 3 });
  await cdp.send("Input.insertText", { text: "日本語" });

  // 「日本語」の UTF-8
  await expect(terminalScreen(page)).toContainText("keys: e6 97 a5 e6 9c ac e8 aa 9e");
  // 変換中の「にほんご」（ひらがなの「に」は e3 81 ab）は届かない
  await expect(terminalScreen(page)).not.toContainText("e3 81 ab");
});

test("クリップボードの文字をペーストすると、コマンドに届く", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await page.evaluate(() => navigator.clipboard.writeText("pasted from clipboard"));

  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("ControlOrMeta+V");
  await page.keyboard.press("Enter");

  await expectTerminalToShow(page, "pasted from clipboard");
});

test("ターミナルの文字を選択してコピーすると、クリップボードに入る", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Shell ready");
  await typeInTerminal(page, "copy me please\n");
  await expectTerminalToShow(page, "copy me please");

  // xterm は空白をノーブレークスペースで描くので、空白の種類を問わずに行を探し、トリプルクリックで行を選択する
  const line = page.locator(".xterm-rows > div").filter({ hasText: /copy\sme\splease/ }).last();
  // xterm は行を描き直し続けるので、位置を取ってマウスで直接クリックする
  const box = (await line.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { clickCount: 3 });
  await page.keyboard.press("ControlOrMeta+C");

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("copy me please");
});

test("出力に含まれる URL をクリックすると、新しいタブで開く", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/long-output.ts"]);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "See https://example.com/accompany for details");
  // 外部サイトには実際にはつながない
  await page.context().route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>example</title>" }),
  );

  const link = page.locator(".xterm-rows > div").filter({ hasText: /https:\/\/example\.com\/accompany/ });
  const box = (await link.boundingBox())!;
  const text = (await link.textContent()) ?? "";
  // URL の文字の上にマウスを置いてクリックする（等幅なので、文字の位置から座標を求める）
  const charWidth = box.width / text.length;
  const x = box.x + charWidth * (text.indexOf("https://") + 5);
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    (async () => {
      await page.mouse.move(x, box.y + box.height / 2);
      await page.mouse.click(x, box.y + box.height / 2);
    })(),
  ]);

  await expect(popup).toHaveURL("https://example.com/accompany");
});

test("画面から流れた出力を、スクロールして見返せる", async ({ page }) => {
  accompany = await startAccompany(["--", "bun", "e2e/fixtures/long-output.ts"]);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "line 200");
  await expect(terminalScreen(page)).not.toContainText(/line 1(?!\d)/);

  // ホイール 1 回で数行ずつ戻るので、最初の行が見えるまで回す
  await page.locator(".xterm-screen").hover();
  await expect(async () => {
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -2000);
    await expect(terminalScreen(page)).toContainText(/line 1(?!\d)/, { timeout: 100 });
  }).toPass();
});
