#!/usr/bin/env bash
# Homebrew の formula（Formula/accompany.rb）を、下のひな形から作り直す（docs/adr/131-homebrew.md、191-run-on-bun.md）。
# formula は Release の tarball を入れ、その JS（dist/cli.js）を Homebrew の bun で動かす。
#
#   update-formula.sh <版>              正式な Release v<版> の tarball にする。Release を出したあとに調整役が流し、
#                                       書き換えた formula をプルリクにする。sha256 は、GitHub が Release のファイルに付けた
#                                       digest を使う（ダウンロードはしない）
#   update-formula.sh --tarball <パス>  手元の tarball（bun pm pack で作ったもの）を file:// で入れる formula にする。
#                                       check-formula.sh が、コミットする前の tarball と formula を確かめるときに使う
#
# 使う環境変数: GH_REPO（省略すると、このリポジトリ）、FORMULA（書き出す先。省略すると、このリポジトリの Formula/accompany.rb）
set -euo pipefail

usage="使い方: update-formula.sh <版（例: 0.16.0）> | update-formula.sh --tarball <tarball のパス>"
root=$(cd "$(dirname "$0")/../.." && pwd)
formula=${FORMULA:-$root/Formula/accompany.rb}
repo=${GH_REPO:-itsuki-yamada/accompany}

if [ "${1:-}" = --tarball ]; then
  tarball=${2:?$usage}
  tarball="$(cd "$(dirname "$tarball")" && pwd)/$(basename "$tarball")"
  # Homebrew は url のファイル名（accompany-<版>.tgz）から版を読む
  if [[ ! $(basename "$tarball") =~ ^accompany-[0-9]+\.[0-9]+\.[0-9]+\.tgz$ ]]; then
    echo "tarball の名前は accompany-<版>.tgz にする: $tarball" >&2
    exit 1
  fi
  url="file://$tarball"
  sha256=$(shasum -a 256 "$tarball" | cut -d " " -f 1)
else
  version=${1:?$usage}
  version=${version#v}
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "版は 0.16.0 のような形で指定する: $1" >&2
    exit 1
  fi
  name="accompany-$version.tgz"
  # 各ファイルの名前と digest（sha256:<16 進>）。Release がなければ、gh が失敗して止まる
  assets=$(gh release view "v$version" --repo "$repo" --json assets -q '.assets[] | "\(.name) \(.digest)"')
  digest=$(awk -v name="$name" '$1 == name { print $2 }' <<< "$assets")
  if [[ ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "v$version の Release に $name（と、その sha256）がない" >&2
    exit 1
  fi
  url="https://github.com/$repo/releases/download/v$version/$name"
  sha256=${digest#sha256:}
fi

# ひな形。@URL@ と @SHA256@ を置き換える。formula を変えるときは、ここを直して流し直す
template=$(cat <<'EOF'
# Release の tarball を入れ、その JS（dist/cli.js）を Homebrew の bun で動かす（docs/adr/191-run-on-bun.md）。
# 署名のない実行ファイルを入れず、広く使われている bun が動かすので、セキュリティの製品に止められにくい。
# このファイルは .github/scripts/update-formula.sh が作る。手で直さず、スクリプトのひな形を直して流し直す
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  url "@URL@"
  sha256 "@SHA256@"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  # homebrew-core の bun。版は Accompany と別に上がる（対応する版の下限と、最新の bun で動くことは e2e.yml で確かめる）
  depends_on "bun"

  def install
    libexec.install Dir["*"]
    # bun の場所は、PATH の bun（mise などで入れた古いものかもしれない）ではなく、依存の bun に決めておく
    (bin/"accompany").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("bun")}/bun" "#{libexec}/dist/cli.js" "$@"
    SH
  end

  test do
    assert_match "accompany #{version}", shell_output("#{bin}/accompany --version")

    port = free_port
    # 画面の保存先を、ホームではなくテストの作業ディレクトリにする
    ENV["ACCOMPANY_STATE_DIR"] = (testpath/"state").to_s
    pid = spawn bin/"accompany", "--port", port.to_s
    begin
      # 起動して待ち受けるまで待ち、画面（HTML）が返ることを確かめる
      page = testpath/"index.html"
      30.times do
        break if quiet_system "curl", "-fso", page, "http://127.0.0.1:#{port}/"

        sleep 1
      end
      assert_match "<title>Accompany</title>", page.read
    ensure
      Process.kill "TERM", pid
      Process.wait pid
    end
  end
end
EOF
)
template=${template//@URL@/$url}
template=${template//@SHA256@/$sha256}
mkdir -p "$(dirname "$formula")"
# mv では一時ファイルの権限になるので、そのまま書く
printf '%s\n' "$template" > "$formula"

if [ "$formula" = "$root/Formula/accompany.rb" ]; then
  git -C "$root" --no-pager diff --stat -- Formula/accompany.rb
fi
echo "$formula を $url にした"
