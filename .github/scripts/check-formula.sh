#!/usr/bin/env bash
# Homebrew の formula（Formula/accompany.rb）で、tarball と bun を入れて起動できることを確かめる
# （docs/adr/131-homebrew.md、191-run-on-bun.md）。tap し、brew style（構文と書き方）、brew install、
# brew test（起動して画面が返る）を流し、最後に外す。
#
#   check-formula.sh            このリポジトリのチェックアウトを tap し、コミットした formula（Release の tarball）を確かめる。
#                               tap は git clone なので、確かめるのはコミットした formula
#   check-formula.sh <tarball> <darwin-x64 の実行ファイル>
#                               update-formula.sh のひな形で、手元の tarball（bun pm pack で作ったもの）と実行ファイル
#                               （Intel の Mac で入れるもの）を入れる formula を一時的な tap に作って確かめる。
#                               Release を出す前に、tarball と formula の形を確かめるため
#
# 手元でも流せる。利用者として tap 済みのマシンでは、それを消さないよう、何もせずに終わる
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tap=itsuki-yamada/accompany
formula=$tap/accompany
tarball=${1:-}
binary=${2:-}

if brew tap | grep -qx "$tap"; then
  echo "::error::$tap は既に tap されている。消さないよう、確かめずに終わる（brew untap $tap のあとに流す）"
  exit 1
fi

# brew style は開発者のコマンドで、開発者モードを勝手に有効にする。元が無効なら、終わったあとに戻す
developer_was_off=false
if brew developer | grep -q "is disabled"; then developer_was_off=true; fi
# 依存として入る bun も、元から入っていなければ、終わったあとに外す
bun_was_installed=true
if ! brew list --formula bun > /dev/null 2>&1; then bun_was_installed=false; fi

work=$(mktemp -d)
cleanup() {
  brew uninstall --formula "$formula" > /dev/null 2>&1 || true
  if [ "$bun_was_installed" = false ]; then brew uninstall --formula bun > /dev/null 2>&1 || true; fi
  brew untap "$tap" > /dev/null 2>&1 || true
  if [ "$developer_was_off" = true ]; then brew developer off > /dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT

tap_source=$root
if [ -n "$tarball" ]; then
  # brew tap はディレクトリを git clone するので、作った formula だけを入れた一時的なリポジトリにする
  tap_source="$work/tap"
  FORMULA="$tap_source/Formula/accompany.rb" "$root/.github/scripts/update-formula.sh" --tarball "$tarball" --binary "$binary"
  git -C "$tap_source" init --quiet
  git -C "$tap_source" add Formula
  git -C "$tap_source" -c user.name=check-formula -c user.email=check-formula@localhost commit --quiet -m "formula を確かめる"
fi

brew tap "$tap" "$tap_source"
brew style "$formula"
brew install --formula "$formula"
brew test "$formula"
accompany_path=$(command -v accompany || true)
echo "入れた accompany: $accompany_path（$(brew list --versions "$formula")）"
echo "動かす bun: $(brew --prefix bun)/bin/bun（$(brew list --versions bun)）"
