import { expect, test, type Page } from "@playwright/test";
import { startAccompany, type Accompany } from "./accompany";

let accompany: Accompany | undefined;

test.afterEach(async () => {
  await accompany?.stop();
});

// <link rel="..."> の href を、ページの URL を基準にした絶対 URL で返す
async function linkHref(page: Page, rel: string) {
  const link = page.locator(`link[rel="${rel}"]`);
  await expect(link).toHaveCount(1);
  return link.evaluate((el: HTMLLinkElement) => el.href);
}

// PNG の先頭 24 バイト（シグネチャと IHDR）から、幅と高さを読む
function pngSize(body: Buffer) {
  expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

test("ページにファビコンが設定され、その URL が 32×32 の PNG を返す", async ({ page }) => {
  accompany = await startAccompany();
  await page.goto(accompany.url);

  const href = await linkHref(page, "icon");
  const response = await page.request.get(href);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  expect(pngSize(await response.body())).toEqual({ width: 32, height: 32 });
});

test("ホーム画面に追加したとき用のアイコン（apple-touch-icon）が、180×180 の PNG を返す", async ({ page }) => {
  accompany = await startAccompany();
  await page.goto(accompany.url);

  const href = await linkHref(page, "apple-touch-icon");
  const response = await page.request.get(href);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  expect(pngSize(await response.body())).toEqual({ width: 180, height: 180 });
});
