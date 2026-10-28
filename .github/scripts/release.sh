#!/usr/bin/env bash
# E2E を通した tarball（$1）と OS・CPU ごとの実行ファイル（$2 のディレクトリの accompany-<バージョン>-<OS>-<CPU>）で、
# 先行版 edge を作り直し、まだなければ package.json のバージョンの正式な Release を作る。
# release.yml から呼ぶ。DRY_RUN=true のときは、タグも Release も作らずに何をするかだけを表示する。
# 使う環境変数: GH_TOKEN, GH_REPO, GITHUB_SHA, RUNNER_TEMP, DRY_RUN
set -euo pipefail

tarball=$1
binaries_dir=$2
dry_run=${DRY_RUN:-true}

run() {
  if [ "$dry_run" = true ]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

# bun pm pack の名前は accompany-<バージョン>.tgz
version=$(basename "$tarball" .tgz)
version=${version#accompany-}
short_sha=${GITHUB_SHA::7}
usage="自分の OS と CPU の実行ファイル（accompany-…-darwin-arm64 など）をダウンロードし、実行できるようにして起動する（Bun は要らない。macOS で実行できないときの対処は README）。
Bun 1.4.0 以上があれば、tarball をダウンロードし、\`bunx --package <ダウンロードした tarball の絶対パス> accompany\` でも起動できる。"
echo "version: $version / commit: $short_sha / dry-run: $dry_run"

# 実行ファイルの <OS>-<CPU>（.github/scripts/build-binaries.sh が作るもの）
platforms=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

# 置くファイル（tarball と実行ファイル）を $RUNNER_TEMP に、置くときの名前で用意し、パスを assets に入れる。
# $1 は、名前のバージョンのあとに付ける文字（edge のコミットなど）。実行ファイルが 1 つでも欠けていれば、cp が失敗して止まる
prepare_assets() {
  assets=("$RUNNER_TEMP/accompany-$version$1.tgz")
  cp "$tarball" "${assets[0]}"
  for platform in "${platforms[@]}"; do
    assets+=("$RUNNER_TEMP/accompany-$version$1-$platform")
    cp "$binaries_dir/accompany-$version-$platform" "${assets[-1]}"
  done
}

# assets の SHA-256 を SHA256SUMS に書き、書いたとおりに検算して、assets の最後に足す（利用者は sha256sum -c で確かめる）。
# $1 は prepare_assets と同じ文字。SHA256SUMS は Release の中の名前にするので、edge と正式版で別のディレクトリに作る
add_checksums() {
  local dir="$RUNNER_TEMP/sums$1" asset
  mkdir -p "$dir"
  : > "$dir/SHA256SUMS"
  for asset in "${assets[@]}"; do
    (cd "$(dirname "$asset")" && sha256sum "$(basename "$asset")") >> "$dir/SHA256SUMS"
  done
  # ファイル名は $RUNNER_TEMP からの相対なので、そこで検算する
  (cd "$RUNNER_TEMP" && sha256sum -c "$dir/SHA256SUMS") || { echo "::error::SHA256SUMS の検算に失敗した"; return 1; }
  cat "$dir/SHA256SUMS"
  assets+=("$dir/SHA256SUMS")
}

# --- 先行版 edge ---
# bunx は tarball のパスごとにインストール先を使い回すので、edge の tarball はコミットごとに名前を変える。
# 実行ファイルも、どのコミットのものか分かるよう、同じくコミットを名前に入れる
prepare_assets "-$short_sha"
add_checksums "-$short_sha"
edge_assets=("${assets[@]}")
edge_notes="main の最新のコミット（$GITHUB_SHA）から作った先行版（バージョン $version）。

使い方: $usage"

if gh release view edge > /dev/null 2>&1; then
  old_assets=$(gh release view edge --json assets -q '.assets[].name')
  # 途中で失敗しても食い違いにくいよう、新しいファイルを置く → ノートを直す → タグを付け直す → 古いファイルを消す、の順にする
  run gh release upload edge "${edge_assets[@]}" --clobber
  run gh release edit edge --prerelease --title edge --notes "$edge_notes"
  run gh api -X PATCH "repos/$GH_REPO/git/refs/tags/edge" -f sha="$GITHUB_SHA" -F force=true
  # 今回置いたもの以外（前のコミットの tarball と実行ファイル）を消す
  for name in $old_assets; do
    keep=false
    for asset in "${edge_assets[@]}"; do
      if [ "$name" = "$(basename "$asset")" ]; then keep=true; fi
    done
    if [ "$keep" = false ]; then
      run gh release delete-asset edge "$name" --yes
    fi
  done
else
  # タグ edge がなければ、--target のコミットに作られる。タグだけ残っていれば、先に付け直す
  if gh api "repos/$GH_REPO/git/ref/tags/edge" > /dev/null 2>&1; then
    run gh api -X PATCH "repos/$GH_REPO/git/refs/tags/edge" -f sha="$GITHUB_SHA" -F force=true
  fi
  run gh release create edge "${edge_assets[@]}" \
    --target "$GITHUB_SHA" --prerelease --title edge --notes "$edge_notes"
fi

# --- 正式な Release ---
# 既にある Release（v0.1.0、v0.2.0 など）やタグには触れない
tag="v$version"
if gh release view "$tag" > /dev/null 2>&1; then
  echo "$tag の Release は既にあるので、何もしない"
  exit 0
fi
if gh api "repos/$GH_REPO/git/ref/tags/$tag" > /dev/null 2>&1; then
  echo "::error::タグ $tag は既にあるが Release がない。別のコミットを指している可能性があるので、Release は作らない。タグを確かめて、手で Release を作るか、バージョンを上げる"
  exit 1
fi
prepare_assets ""
add_checksums ""
release_assets=("${assets[@]}")
# 変更点は、edge ではなく直前の正式な Release（Latest）からの差分にする
previous=$(gh release view --json tagName -q .tagName)
run gh release create "$tag" "${release_assets[@]}" \
  --target "$GITHUB_SHA" \
  --title "$tag" \
  --notes "使い方: $usage" \
  --generate-notes \
  --notes-start-tag "$previous" \
  --latest
