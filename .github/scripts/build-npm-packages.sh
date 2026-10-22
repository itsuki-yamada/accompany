#!/usr/bin/env bash
# OS と CPU ごとの実行ファイル（$1 のディレクトリの accompany-<版>-<OS>-<CPU>）から、npm のパッケージを作り、
# npm pack した tarball を $2 のディレクトリに置く（docs/adr/132-npm.md）。版は app/server/package.json と同じ。
# - @itsuki-yamada/accompany-<OS>-<CPU>: 実行ファイルを bin/accompany に入れ、os と cpu でそのマシンにだけ入るようにする
# - accompany: npm/accompany の起動役。4 つを同じ版の optionalDependencies にする
# e2e.yml と release.yml から呼ぶ。手元でも `.github/scripts/build-npm-packages.sh <実行ファイルのディレクトリ> <出力先>` で作れる
set -euo pipefail

binaries=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
root=$(cd "$(dirname "$0")/../.." && pwd)
version=$(node -p 'require(process.argv[1]).version' "$root/app/server/package.json")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# 実行ファイルの <OS>-<CPU>（.github/scripts/build-binaries.sh が作るもの）
platforms=(darwin-arm64 darwin-x64 linux-x64 linux-arm64)

for platform in "${platforms[@]}"; do
  dir="$work/accompany-$platform"
  mkdir -p "$dir/bin"
  cp "$binaries/accompany-$version-$platform" "$dir/bin/accompany"
  chmod 755 "$dir/bin/accompany"
  cp "$root/LICENSE" "$dir/"
  # Linux 向けは glibc の上で動く（docs/adr/78-binaries.md）。libc を知らない古い npm は、この指定を無視する
  node - "$dir/package.json" "$version" "$platform" <<'EOF'
const [file, version, platform] = process.argv.slice(2);
const [os, cpu] = platform.split("-");
const pkg = {
  name: `@itsuki-yamada/accompany-${platform}`,
  version,
  description: `The ${platform} binary for accompany (npx accompany)`,
  license: "MIT",
  homepage: "https://github.com/itsuki-yamada/accompany",
  repository: { type: "git", url: "git+https://github.com/itsuki-yamada/accompany.git" },
  os: [os],
  cpu: [cpu],
  ...(os === "linux" && { libc: ["glibc"] }),
  files: ["bin"],
};
require("fs").writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
EOF
done

main="$work/accompany"
cp -R "$root/npm/accompany" "$main"
cp "$root/LICENSE" "$main/"
node - "$main/package.json" "$version" "${platforms[@]}" <<'EOF'
const [file, version, ...platforms] = process.argv.slice(2);
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = version;
pkg.optionalDependencies = Object.fromEntries(platforms.map((p) => [`@itsuki-yamada/accompany-${p}`, version]));
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
EOF

for platform in "${platforms[@]}"; do
  npm pack --quiet --pack-destination "$out" "$work/accompany-$platform" > /dev/null
done
npm pack --quiet --pack-destination "$out" "$main" > /dev/null
ls -l "$out"
