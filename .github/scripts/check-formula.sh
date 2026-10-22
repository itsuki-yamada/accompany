#!/usr/bin/env bash
# Homebrew の formula（Formula/accompany.rb）で、Release の実行ファイルを入れて起動できることを確かめる（docs/adr/131-homebrew.md）。
# このリポジトリを tap し、brew style（構文と書き方）、brew install、brew test（起動して画面が返る）を流し、最後に外す。
# tap は git clone なので、確かめるのはコミットした formula。手元でも `.github/scripts/check-formula.sh` で流せる。
# 利用者として tap 済みのマシンでは、それを消さないよう、何もせずに終わる
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tap=itsuki-yamada/accompany
formula=$tap/accompany

if brew tap | grep -qx "$tap"; then
  echo "::error::$tap は既に tap されている。消さないよう、確かめずに終わる（brew untap $tap のあとに流す）"
  exit 1
fi

# brew style は開発者のコマンドで、開発者モードを勝手に有効にする。元が無効なら、終わったあとに戻す
developer_was_off=false
if brew developer | grep -q "is disabled"; then developer_was_off=true; fi

cleanup() {
  brew uninstall --formula "$formula" > /dev/null 2>&1 || true
  brew untap "$tap" > /dev/null 2>&1 || true
  if [ "$developer_was_off" = true ]; then brew developer off > /dev/null; fi
}
trap cleanup EXIT

brew tap "$tap" "$root"
brew style "$formula"
brew install --formula "$formula"
brew test "$formula"
accompany_path=$(command -v accompany || true)
echo "入れた accompany: $accompany_path（$(brew list --versions "$formula")）"
