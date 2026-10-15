#!/usr/bin/env bash
# E2E を通した tarball（$1）で、先行版 edge を作り直し、まだなければ package.json のバージョンの正式な Release を作る。
# release.yml から呼ぶ。DRY_RUN=true のときは、タグも Release も作らずに何をするかだけを表示する。
# 使う環境変数: GH_TOKEN, GH_REPO, GITHUB_SHA, RUNNER_TEMP, DRY_RUN
set -euo pipefail

tarball=$1
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
usage="\`bunx --package <ダウンロードした tarball の絶対パス> accompany\` で起動する。"
echo "version: $version / commit: $short_sha / dry-run: $dry_run"

# --- 先行版 edge ---
# bunx は tarball のパスごとにインストール先を使い回すので、edge の tarball はコミットごとに名前を変える
edge_asset="accompany-$version-$short_sha.tgz"
cp "$tarball" "$RUNNER_TEMP/$edge_asset"
edge_notes="main の最新のコミット（$GITHUB_SHA）から作った先行版（バージョン $version）。

使い方: $edge_asset をダウンロードし、$usage"

if gh release view edge > /dev/null 2>&1; then
  old_assets=$(gh release view edge --json assets -q '.assets[].name')
  # 途中で失敗しても食い違いにくいよう、tarball を置く → ノートを直す → タグを付け直す → 古い tarball を消す、の順にする
  run gh release upload edge "$RUNNER_TEMP/$edge_asset" --clobber
  run gh release edit edge --prerelease --title edge --notes "$edge_notes"
  run gh api -X PATCH "repos/$GH_REPO/git/refs/tags/edge" -f sha="$GITHUB_SHA" -F force=true
  for name in $old_assets; do
    if [ "$name" != "$edge_asset" ]; then
      run gh release delete-asset edge "$name" --yes
    fi
  done
else
  # タグ edge がなければ、--target のコミットに作られる。タグだけ残っていれば、先に付け直す
  if gh api "repos/$GH_REPO/git/ref/tags/edge" > /dev/null 2>&1; then
    run gh api -X PATCH "repos/$GH_REPO/git/refs/tags/edge" -f sha="$GITHUB_SHA" -F force=true
  fi
  run gh release create edge "$RUNNER_TEMP/$edge_asset" \
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
release_asset="accompany-$version.tgz"
cp "$tarball" "$RUNNER_TEMP/$release_asset"
# 変更点は、edge ではなく直前の正式な Release（Latest）からの差分にする
previous=$(gh release view --json tagName -q .tagName)
run gh release create "$tag" "$RUNNER_TEMP/$release_asset" \
  --target "$GITHUB_SHA" \
  --title "$tag" \
  --notes "使い方: $release_asset をダウンロードし、$usage" \
  --generate-notes \
  --notes-start-tag "$previous" \
  --latest
