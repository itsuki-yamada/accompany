#!/usr/bin/env node
// npm で入れた Accompany の起動役（docs/adr/132-npm.md、191-run-on-bun.md）。
// Bun（1.4.0 以上）があれば、同梱した JS（dist/cli.js。Release の tarball と同じもの）を Bun で動かす。
// 署名のない実行ファイルより、広く使われている Bun が動かすほうが、セキュリティの製品に止められにくいため。
// Bun がなければ（または ACCOMPANY_USE_BINARY を付けると）、このマシンの OS と CPU のパッケージ
// （@itsuki-yamada/accompany-<OS>-<CPU>）に入っている実行ファイルを起動する。
// 引数と標準入出力はそのまま渡す。止める合図は起動したものに伝え、その終了コード（または合図）で終わる。
// Node の古い版でも動くよう、CommonJS と古くからある API だけを使う
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const supported = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const platform = `${process.platform}-${process.arch}`;
const releases = "https://github.com/itsuki-yamada/accompany/releases";
// app/server/src/require-bun.ts の required と同じ版。これより古い Bun では動かさず、実行ファイルを起動する
const requiredBun = [1, 4, 0];
const script = path.join(__dirname, "..", "dist", "cli.js");

function fail(message) {
  console.error(`Accompany: ${message}`);
  process.exit(1);
}

// PATH の bun（起動役そのものを Bun が動かしているときは、その Bun）。見つからなければ undefined
function findBun() {
  if (process.versions.bun) return process.execPath;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, "bun");
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // 次のディレクトリを探す
    }
  }
  return undefined;
}

// bun の版が requiredBun 以上か
function isNewEnough(bun) {
  const result = spawnSync(bun, ["--version"], { encoding: "utf8", timeout: 10000 });
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec((result.stdout || "").trim());
  if (result.status !== 0 || !match) return false;
  for (let i = 0; i < 3; i++) {
    const n = Number(match[i + 1]);
    if (n !== requiredBun[i]) return n > requiredBun[i];
  }
  return true;
}

// 起動するもの（コマンドと、その前に付ける引数）
function choose() {
  if (!process.env.ACCOMPANY_USE_BINARY && fs.existsSync(script)) {
    const bun = findBun();
    if (bun && isNewEnough(bun)) return { command: bun, args: [script] };
  }

  if (!supported.includes(platform)) {
    fail(
      `この OS と CPU（${platform}）の実行ファイルはありません。対応しているのは ${supported.join("、")} です。` +
        `Bun 1.4.0 以上を入れると、Bun で動かせます: ${releases}`,
    );
  }
  // Linux 向けの実行ファイルは glibc の上で動く。glibc の版が分からなければ、musl（Alpine など）とみなす
  if (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime) {
    fail(`musl の Linux（Alpine など）では、実行ファイルは動きません。Bun 1.4.0 以上を入れると、Bun で動かせます: ${releases}`);
  }
  const pkg = `@itsuki-yamada/accompany-${platform}`;
  try {
    return { command: require.resolve(`${pkg}/bin/accompany`), args: [] };
  } catch {
    return fail(
      `${pkg} が入っていません。optionalDependencies を入れない設定（--omit=optional など）を外して入れ直すか、` +
        "Bun 1.4.0 以上を入れてください",
    );
  }
}

const { command, args } = choose();
const child = spawn(command, args.concat(process.argv.slice(2)), { stdio: "inherit" });

// 端末の Ctrl+C はプロセスグループ全体に届くので、起動したもの（Bun か実行ファイル）にも直接届く。kill などで起動役だけに
// 送られたときも伝える（Accompany は、二度目以降の合図を無視する）。起動役は、Accompany が保存して終わるまで待つ
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => fail(`${command} を起動できませんでした: ${error.message}`));

child.on("exit", (code, signal) => {
  if (signal) {
    // 起動したものと同じ合図で終わり、呼び出し元（シェルなど）に合図で終わったことを伝える
    for (const s of signals) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    // 合図を無視する設定を受け継いでいて終わらなかったときは、終了コードで伝える
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  process.exit(code);
});
