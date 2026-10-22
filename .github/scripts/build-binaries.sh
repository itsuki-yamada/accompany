#!/usr/bin/env bash
# OS と CPU ごとの、Bun の要らない実行ファイルを $1 のディレクトリに作る（docs/adr/78-binaries.md）。
# 名前は accompany-<package.json のバージョン>-<OS>-<CPU>。どの OS からでも 4 つすべてを作れる（クロスコンパイル）。
# e2e.yml から呼ぶ。手元でも、依存を入れたあとに `.github/scripts/build-binaries.sh <出力先>` で作れる
set -euo pipefail

out=$1
root=$(cd "$(dirname "$0")/../.." && pwd)
version=$(cd "$root/app/server" && bun -e 'console.log(require("./package.json").version)')
mkdir -p "$out"

# 名前の <OS>-<CPU> と、bun build --compile の --target。
# x64 は、AVX2 のない古い CPU（2013 年より前の Intel Mac など）でも動く baseline にする
targets=(
  "darwin-arm64 bun-darwin-arm64"
  "darwin-x64 bun-darwin-x64-baseline"
  "linux-x64 bun-linux-x64-baseline"
  "linux-arm64 bun-linux-arm64"
)
# --minify: 実行ファイルに入れる画面の JS も、tarball（Bun が本番として配るもの）と同じく縮める（docs/adr/111-loading.md）。
# --sourcemap: 縮めても、エラーのときに元のソースの行を出す（縮めた 1 行を出すと、読めないうえ、
# ポートが使われているときのエラーにも URL の文字列が混ざる）。ソースマップは実行ファイルに埋め込まれるので、
# 横に書き出される .map は配らない
for entry in "${targets[@]}"; do
  read -r name target <<< "$entry"
  bun build --compile --minify --sourcemap --target="$target" "$root/app/server/src/cli.ts" --outfile "$out/accompany-$version-$name"
done
rm -f "$out"/*.map
ls -l "$out"
