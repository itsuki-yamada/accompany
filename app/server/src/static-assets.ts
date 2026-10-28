import type { HTMLBundle } from "bun";
import { isAbsolute, resolve } from "node:path";

// gzip で縮むものだけを圧縮して配る（PNG などはほとんど縮まない）
const worthCompressing = 0.9;

// ほかのページに iframe で埋め込まれて、見えない形で重ねたボタンを押させられないよう（クリックジャッキング）、
// 埋め込めるのを Accompany 自身のページに限る。VS Code の拡張は webview（vscode-webview:）の中の iframe で開き、
// frame-ancestors はすべての祖先（workbench の vscode-file: も）を確かめるので、拡張が起動するとき
// （--allow-vscode-webview）だけ、その 2 つも許す（docs/adr/185-frame-ancestors.md）
export function contentSecurityPolicy({ allowVscodeWebview = false } = {}) {
  return `frame-ancestors 'self'${allowVscodeWebview ? " vscode-webview: vscode-file:" : ""}`;
}

type Asset = { body: Uint8Array; gzip?: Uint8Array; headers: Headers };

// 画面のファイル 1 つ（ルートからのパスで指定する）の中身と、Bun が付けるヘッダー
type Load = (path: string) => Promise<{ body: Uint8Array; headers: Headers }>;

// tarball の JS（bun build --target=bun で固めた dist/cli.js）では、HTML の取り込みは画面のファイルの一覧（manifest）になる。
// 一覧のパスは固めた JS からの相対で書かれるが、Bun.serve はそれを起動したディレクトリからの相対として読むので、
// ほかのディレクトリで起動すると見つからない（Bun 1.4.0〜1.4.4。絶対パスにすると、JS・CSS などを配らない）。
// そのため一覧があれば、Bun に配らせずに、固めた JS の横のファイルを直接読む（docs/adr/191-run-on-bun.md）。
// リポジトリから起動したとき（一覧がない）と、実行ファイル（--compile。一覧のパスがはじめから /$bunfs/… の絶対パス）では、
// これまでどおり Bun に配らせる
type BundledFile = { path: string; loader: string; headers: Record<string, string> };

// 画面（HTML とそこから読み込む JS・CSS・画像）を、gzip で圧縮して配る。ゲストはネットワーク越し（ポート転送など）に
// 開くことが多く、Bun が配る画面の JS（400KB ほど）は圧縮されないため（docs/adr/111-loading.md）。
// Bun の HTML の取り込みが作るファイルは、名前と中身を Bun に任せたまま使いたいので、起動時に一度だけ、
// 使い捨てのサーバーで Bun に配らせて（固めた JS では一覧から読んで）取り出し、圧縮しておく。
// どのファイルにも csp を Content-Security-Policy として付ける。返り値は Bun.serve の routes に渡す
export async function compressedRoutes(index: HTMLBundle, csp: string) {
  const { files } = index as HTMLBundle & { files?: BundledFile[] };
  if (files?.some((file) => !isAbsolute(file.path))) return collectRoutes(bundledFiles(files), csp);
  const source = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    reusePort: false,
    routes: { "/": index },
    fetch: () => new Response("Not Found", { status: 404 }),
  });
  try {
    return await collectRoutes(servedBy(source.url), csp);
  } finally {
    source.stop(true);
  }
}

async function collectRoutes(load: Load, csp: string) {
  const html = asset(await load("/"), csp);
  const text = new TextDecoder().decode(html.body);
  // HTML から読み込むファイル（Bun が付けた、ルートからのパス）
  const paths = new Set([...text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!));
  const routes: Record<string, (request: Request) => Response> = { "/": serve(html) };
  for (const path of paths) {
    const file = asset(await load(path), csp);
    // 名前に中身のハッシュが入っているので、ずっとキャッシュしてよい。実行ファイルでは Bun が付けないので、ここで付ける
    if (!file.headers.has("cache-control")) file.headers.set("cache-control", "public, max-age=31536000, immutable");
    routes[path] = serve(file);
  }
  return routes;
}

function servedBy(base: URL): Load {
  return async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`画面のファイルを用意できませんでした: ${path} (${response.status})`);
    return { body: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) };
  };
}

// 一覧の HTML はルート（/）で、ほかのファイルは、一覧のパス（./index-<ハッシュ>.js など）をルートからのパスにしたもので配る
// （bun build の --public-path=/ で、HTML もそのパスで読み込む）
function bundledFiles(files: BundledFile[]): Load {
  return async (path) => {
    const file =
      path === "/"
        ? files.find((f) => f.loader === "html")
        : files.find((f) => f.loader !== "html" && `/${f.path.replace(/^\.\//, "")}` === path);
    if (!file) throw new Error(`画面のファイルを用意できませんでした: ${path}（固めた JS の一覧にない）`);
    const body = await Bun.file(resolve(import.meta.dir, file.path)).bytes();
    return { body, headers: new Headers(file.headers) };
  };
}

function asset({ body, headers: original }: { body: Uint8Array; headers: Headers }, csp: string): Asset {
  const headers = new Headers(original);
  headers.delete("content-length");
  headers.delete("date");
  headers.set("vary", "Accept-Encoding");
  headers.set("content-security-policy", csp);
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
