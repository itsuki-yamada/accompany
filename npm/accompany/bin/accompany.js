#!/usr/bin/env node
// npm で入れた Accompany の起動役（docs/adr/132-npm.md）。
// このマシンの OS と CPU のパッケージ（@itsuki-yamada/accompany-<OS>-<CPU>）に入っている実行ファイルを探して起動し、
// 引数と標準入出力をそのまま渡す。止める合図は実行ファイルに伝え、実行ファイルの終了コード（または合図）で終わる。
// Node の古い版でも動くよう、CommonJS と古くからある API だけを使う
"use strict";

const { spawn } = require("child_process");

const supported = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const platform = `${process.platform}-${process.arch}`;
const releases = "https://github.com/itsuki-yamada/accompany/releases";

function fail(message) {
  console.error(`Accompany: ${message}`);
  process.exit(1);
}

if (!supported.includes(platform)) {
  fail(`この OS と CPU（${platform}）には対応していません。対応しているのは ${supported.join("、")} です: ${releases}`);
}

const pkg = `@itsuki-yamada/accompany-${platform}`;
let binary;
try {
  binary = require.resolve(`${pkg}/bin/accompany`);
} catch {
  fail(
    `${pkg} が入っていません。optionalDependencies を入れない設定（--omit=optional など）を外して、入れ直してください`,
  );
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// 端末の Ctrl+C はプロセスグループ全体に届くので、実行ファイルにも直接届く。kill などで起動役だけに送られたときも
// 実行ファイルに伝える（実行ファイルは、二度目以降の合図を無視する）。起動役は、実行ファイルが保存して終わるまで待つ
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => fail(`${binary} を起動できませんでした: ${error.message}`));

child.on("exit", (code, signal) => {
  if (signal) {
    // 実行ファイルと同じ合図で終わり、呼び出し元（シェルなど）に合図で終わったことを伝える
    for (const s of signals) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    // 合図を無視する設定を受け継いでいて終わらなかったときは、終了コードで伝える
    setTimeout(() => process.exit(1), 1000);
    return;
  }
  process.exit(code);
});
