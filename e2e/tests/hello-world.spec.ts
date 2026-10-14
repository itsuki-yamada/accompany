import { expect, test } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";

let accompany: Accompany | undefined;

test.afterEach(() => accompany?.stop());

test("起動時に表示された URL をブラウザで開くと Hello World が表示される", async ({ page }) => {
  accompany = await startAccompany();

  await page.goto(accompany.url);

  await expect(page.getByText("Hello World")).toBeVisible();
});

test("--port で指定したポートで起動する", async ({ page }) => {
  accompany = await startAccompany(["--port", "4789"]);

  expect(new URL(accompany.url).port).toBe("4789");
  await page.goto(accompany.url);
  await expect(page.getByText("Hello World")).toBeVisible();
});
