#!/usr/bin/env bash
# Homebrew の formula（Formula/accompany.rb）の版、URL、sha256 を、正式な Release v<版>（$1）の実行ファイルに合わせる
# （docs/adr/131-homebrew.md）。Release を出したあとに調整役が流し、書き換えた formula をプルリクにする。
# sha256 は、Release の各ファイルに GitHub が付けた digest を使う（ダウンロードはしない）。
# 使う環境変数: GH_REPO（省略すると、このリポジトリ）
set -euo pipefail

version=${1:?使い方: update-formula.sh <版（例: 0.16.0）>}
version=${version#v}
root=$(cd "$(dirname "$0")/../.." && pwd)
formula="$root/Formula/accompany.rb"
repo=${GH_REPO:-itsuki-yamada/accompany}

# 実行ファイルの <OS>-<CPU>（.github/scripts/build-binaries.sh が作るもの）
platforms=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

# 各ファイルの名前と digest（sha256:<16 進>）。Release がなければ、gh が失敗して止まる
assets=$(gh release view "v$version" --repo "$repo" --json assets -q '.assets[] | "\(.name) \(.digest)"')

args=()
for platform in "${platforms[@]}"; do
  name="accompany-$version-$platform"
  digest=$(awk -v name="$name" '$1 == name { print $2 }' <<< "$assets")
  if [[ $digest != sha256:* ]]; then
    echo "v$version の Release に $name（と、その sha256）がない" >&2
    exit 1
  fi
  args+=("$platform=${digest#sha256:}")
done

# version の行と、各 url の行（ファイル名の末尾で OS と CPU を見分ける）と、その直後の sha256 の行を書き換える
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
awk -v version="$version" -v repo="$repo" -v pairs="${args[*]}" '
  BEGIN {
    n = split(pairs, list, " ")
    for (i = 1; i <= n; i++) { split(list[i], kv, "="); sha[kv[1]] = kv[2] }
  }
  /^  version "/ { sub(/"[^"]*"/, "\"" version "\"") }
  /^ *url "https:\/\/github\.com\// {
    platform = match($0, /(darwin|linux)-(arm64|x64)"/) ? substr($0, RSTART, RLENGTH - 1) : ""
    if (!(platform in sha)) { print "知らない url: " $0 > "/dev/stderr"; exit 1 }
    sub(/"[^"]*"/, "\"https://github.com/" repo "/releases/download/v" version "/accompany-" version "-" platform "\"")
  }
  /^ *sha256 "/ && platform != "" { sub(/"[^"]*"/, "\"" sha[platform] "\""); done[platform] = 1; platform = "" }
  { print }
  END { for (p in sha) if (!(p in done)) { print "formula に " p " の url と sha256 がない" > "/dev/stderr"; exit 1 } }
' "$formula" > "$tmp"
# mv では一時ファイルの権限（600）になるので、中身だけを書き戻す
cat "$tmp" > "$formula"

git -C "$root" --no-pager diff --stat -- Formula/accompany.rb
echo "Formula/accompany.rb を $version にした。コミットしてプルリクにする"
