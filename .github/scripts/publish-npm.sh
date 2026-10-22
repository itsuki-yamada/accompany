#!/usr/bin/env bash
# npm pack した tarball（$1 のディレクトリ）を npm に公開する（docs/adr/132-npm.md）。既に公開してある版は飛ばす。
# OS と CPU ごとのパッケージを先に、主パッケージ accompany を最後に公開する（主パッケージが参照する版が先にあるように）。
# release.yml から呼ぶ。認証は npm の Trusted Publishing（GitHub Actions の OIDC）で、トークンは使わない。
# DRY_RUN=true のときは、公開せずに何を公開するかだけを表示する（npm publish --dry-run）
set -euo pipefail

packages=$1
dry_run=${DRY_RUN:-true}

for tgz in "$packages"/itsuki-yamada-accompany-*.tgz "$packages"/accompany-[0-9]*.tgz; do
  read -r name version < <(tar -xOzf "$tgz" package/package.json | node -e '
    const pkg = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(pkg.name, pkg.version);
  ')
  if npm view "$name@$version" version > /dev/null 2>&1; then
    echo "$name@$version は公開済みなので、飛ばす"
    continue
  fi
  if [ "$dry_run" = true ]; then
    echo "[dry-run] npm publish $name@$version"
    npm publish "$tgz" --access public --dry-run
  else
    npm publish "$tgz" --access public
  fi
done
