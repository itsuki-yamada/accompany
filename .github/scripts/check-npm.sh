#!/usr/bin/env bash
# npm のパッケージ（$1 のディレクトリにある、npm pack した tarball）を、レジストリの代わりに tarball から別のディレクトリ（$2）に入れ、
# npx で起動して画面が返り、Ctrl+C（SIGINT）で終了コード 0 で止まることを確かめる（docs/adr/132-npm.md）。
# 入れるのは、主パッケージ accompany と、このマシンの OS と CPU のパッケージ。e2e.yml と release.yml から、公開する前に呼ぶ。
# 手元でも `.github/scripts/check-npm.sh <パッケージのディレクトリ> <入れる先>` で流せる
set -euo pipefail

packages=$(cd "$1" && pwd)
install_dir=$2
platform=$(node -p 'process.platform + "-" + process.arch')
main=$(ls "$packages"/accompany-[0-9]*.tgz)
native=$(ls "$packages"/itsuki-yamada-accompany-"$platform"-[0-9]*.tgz)

mkdir -p "$install_dir"
cd "$install_dir"
install_dir=$(pwd)
npm init -y > /dev/null
npm install --no-audit --no-fund "$main" "$native"

port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
state=$(mktemp -d)
log="$state/accompany.log"
# 端末で起動したときと同じく、別のプロセスグループで起動し、Ctrl+C と同じくグループ全体に SIGINT を送る
# （ジョブ制御がないと、バックグラウンドのコマンドは SIGINT を無視する）。入れたディレクトリで起動するので、入れたものを使う
set -m
ACCOMPANY_STATE_DIR="$state/state" npx accompany --port "$port" > "$log" 2>&1 &
pid=$!
set +m
stop() {
  kill -INT -- "-$pid" 2> /dev/null || true
}
trap stop EXIT

page=""
for _ in $(seq 30); do
  if page=$(curl -fs "http://127.0.0.1:$port/"); then break; fi
  sleep 1
done
cat "$log"
if [[ $page != *"<title>Accompany</title>"* ]]; then
  echo "::error::npx で起動した Accompany から画面が返らない"
  exit 1
fi

kill -INT -- "-$pid"
status=0
wait "$pid" || status=$?
trap - EXIT
# npx（npm）自身も SIGINT を受けて、版によっては 130（SIGINT で終わった）で終わる。どちらも Ctrl+C で止まったものとする
if [ "$status" != 0 ] && [ "$status" != 130 ]; then
  echo "::error::Ctrl+C（SIGINT）で止めたときの終了コードが 0 でも 130 でもない: $status"
  exit 1
fi
# 実行ファイルが保存して終わるまで、プロセスグループ全体が終わるのを待つ
for _ in $(seq 20); do
  if ! kill -0 -- "-$pid" 2> /dev/null; then break; fi
  sleep 0.5
done
if kill -0 -- "-$pid" 2> /dev/null; then
  echo "::error::SIGINT を送っても、Accompany が止まらない"
  kill -KILL -- "-$pid" 2> /dev/null || true
  exit 1
fi
rm -rf "$state"
echo "npx で起動して画面が返り、SIGINT で止まった（終了コード $status）: $install_dir"
