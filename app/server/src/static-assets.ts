import type { HTMLBundle } from "bun";

// gzip で縮むものだけを圧縮して配る（PNG などはほとんど縮まない）
const worthCompressing = 0.9;

type Asset = { body: Uint8Array; gzip?: Uint8Array; headers: Headers };

// 画面（HTML とそこから読み込む JS・CSS・画像）を、gzip で圧縮して配る。ゲストはネットワーク越し（ポート転送など）に
// 開くことが多く、Bun が配る画面の JS（400KB ほど）は圧縮されないため（docs/adr/111-loading.md）。
// Bun の HTML の取り込みが作るファイルは、名前と中身を Bun に任せたまま使いたいので、起動時に一度だけ、
// 使い捨てのサーバーで Bun に配らせて取り出し、圧縮しておく。返り値は Bun.serve の routes に渡す
export async function compressedRoutes(index: HTMLBundle) {
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    reusePort: false,
    routes: { "/": index },
    fetch: () => new Response("Not Found", { status: 404 }),
  });
  try {
    const html = await fetchAsset(new URL("/", source.url));
    const text = new TextDecoder().decode(html.body);
    // HTML から読み込むファイル（Bun が付けた、ルートからのパス）
    const paths = new Set([...text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!));
    const routes: Record<string, (request: Request) => Response> = { "/": serve(html) };
    for (const path of paths) {
      const asset = await fetchAsset(new URL(path, source.url));
      // 名前に中身のハッシュが入っているので、ずっとキャッシュしてよい。実行ファイルでは Bun が付けないので、ここで付ける
      if (!asset.headers.has("cache-control")) asset.headers.set("cache-control", "public, max-age=31536000, immutable");
      routes[path] = serve(asset);
    }
    return routes;
  } finally {
    source.stop(true);
  }
}

async function fetchAsset(url: URL): Promise<Asset> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`画面のファイルを用意できませんでした: ${url.pathname} (${response.status})`);
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("date");
  headers.set("vary", "Accept-Encoding");
  const gzip = Bun.gzipSync(body, { level: 9 });
  return { body, headers, gzip: gzip.byteLength < body.byteLength * worthCompressing ? gzip : undefined };
}

function serve({ body, gzip, headers }: Asset) {
  const etag = headers.get("etag");
  return (request: Request) => {
    if (etag && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    const acceptsGzip = /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "");
    if (!gzip || !acceptsGzip) return new Response(body, { headers });
    const compressed = new Headers(headers);
    compressed.set("content-encoding", "gzip");
    return new Response(gzip, { headers: compressed });
  };
}
