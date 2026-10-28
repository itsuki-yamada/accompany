// 拡張に同梱するコード（dist/extension.js）に、vsls のうち getApi のある vscode.js（と版を読む package.json）だけが入り、
// 依存の @microsoft/servicehub-framework などが入っていないことを確かめる（docs/adr/183-liveshare-extension.md）。
// あわせて、実行時に読み込むのが vscode と Node.js の組み込みのモジュールだけであることを確かめる
import { builtinModules } from "node:module";

const bundle = await Bun.file(new URL("../dist/extension.js", import.meta.url)).text();

// bun build は、同梱したモジュールごとに「// node_modules/<パス>」の注釈を付ける
const bundled = [...new Set([...bundle.matchAll(/^\/\/ (node_modules\/\S+)$/gm)].map((m) => m[1]))].sort();
const allowedModules = ["node_modules/vsls/package.json", "node_modules/vsls/vscode.js"];
const unexpectedModules = bundled.filter((path) => !allowedModules.includes(path));

const required = [...new Set([...bundle.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((m) => m[1]))].sort();
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const unexpectedRequires = required.filter((name) => name !== "vscode" && !builtins.has(name));

const forbidden = ["servicehub-framework", "nerdbank-streams", "vscode-jsonrpc", "msgpack"].filter((name) =>
  bundled.some((path) => path.includes(name)),
);

console.log(`同梱したモジュール: ${bundled.join(", ") || "なし"}`);
console.log(`実行時に読み込むモジュール: ${required.join(", ")}`);
if (unexpectedModules.length > 0 || unexpectedRequires.length > 0 || forbidden.length > 0) {
  console.error(`想定していないモジュールがあります: ${[...unexpectedModules, ...unexpectedRequires, ...forbidden].join(", ")}`);
  process.exit(1);
}
