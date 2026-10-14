import { expect, test } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";
import { expectTerminalToShow, typeInTerminal } from "./terminal";

const fakeAgent = ["--", "bun", "e2e/fixtures/fake-agent.ts"];

let accompany: Accompany | undefined;

test.afterEach(() => accompany?.stop());

test("起動時に指定したコマンドの出力が、ブラウザの端末に表示される", async ({ page }) => {
  accompany = await startAccompany(fakeAgent);

  await page.goto(accompany.url);

  await expectTerminalToShow(page, "Fake Agent ready");
});

test("ブラウザの端末で入力すると、コマンドに届いて応答が表示される", async ({ page }) => {
  accompany = await startAccompany(fakeAgent);
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Agent ready");

  await typeInTerminal(page, "hello agent\n");

  await expectTerminalToShow(page, "Agent received: hello agent");
});

test("コマンドを省略すると $SHELL が起動する", async ({ page }) => {
  accompany = await startAccompany([], { SHELL: "e2e/fixtures/fake-shell" });

  await page.goto(accompany.url);

  await expectTerminalToShow(page, "Fake Shell ready");
});

test("--port で指定したポートで起動する", async ({ page }) => {
  accompany = await startAccompany(["--port", "4789", ...fakeAgent]);

  expect(new URL(accompany.url).port).toBe("4789");
  await page.goto(accompany.url);
  await expectTerminalToShow(page, "Fake Agent ready");
});
