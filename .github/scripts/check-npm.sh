#!/usr/bin/env bash
# npm のパッケージ（$1 のディレクトリにある、npm pack した tarball）を、レジストリの代わりに tarball から別のディレクトリ（$2）に入れ、
# npx で起動して画面が返り、Ctrl+C（SIGINT）で止まることを確かめる（docs/adr/132-npm.md）。
# 起動役は、Bun があれば同梱した JS を Bun で動かし、なければ実行ファイルを起動する（docs/adr/191-run-on-bun.md）。
# PATH から Bun を外したとき（Node だけの人）は実行ファイルが、Bun があるときは Bun が動くことも確かめる
# （このマシンに Bun がなければ、後者は飛ばす）。
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

# PATH から、bun のあるディレクトリを外したもの
path_without_bun=$(node -e '
  const { delimiter, join } = require("path");
  const fs = require("fs");
  console.log(process.env.PATH.split(delimiter).filter((dir) => !fs.existsSync(join(dir, "bun"))).join(delimiter));
')

# PATH の中の相対のディレクトリ（. など）にある bun は、起動役は使わない（起動したディレクトリによって変わり、
# そこに置かれたものを動かしてしまうため）。確かめるため、入れたディレクトリに、版だけ新しい偽の bun を置いておく
cat > "$install_dir/bun" <<'FAKE'
#!/bin/sh
if [ "$1" = --version ]; then echo 99.0.0; exit 0; fi
echo "相対の PATH にある偽の bun が起動された" >&2
exit 1
FAKE
chmod +x "$install_dir/bun"

# $1: 動くはずのもの（bun / binary）、$2: 起動するときの PATH、$3 以降: 起動するときに足す環境変数（名前=値）
check() {
  local expected=$1 path=$2
  local extra_env=("${@:3}")
  local port state log pid
  port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')
  state=$(mktemp -d)
  log="$state/accompany.log"
  # 端末で起動したときと同じく、別のプロセスグループで起動し、Ctrl+C と同じくグループ全体に SIGINT を送る
  # （ジョブ制御がないと、バックグラウンドのコマンドは SIGINT を無視する）。入れたディレクトリで起動するので、入れたものを使う
  set -m
  env PATH="$path" ACCOMPANY_STATE_DIR="$state/state" ${extra_env[@]+"${extra_env[@]}"} \
    npx accompany --port "$port" > "$log" 2>&1 &
  pid=$!
  set +m
  # 途中で失敗したときも、Accompany を止めて終わるのを待ち（止まらなければ SIGKILL）、一時ディレクトリを消す
  # shellcheck disable=SC2064
  trap "kill -INT -- -$pid 2> /dev/null || true; sleep 2; kill -KILL -- -$pid 2> /dev/null || true; rm -rf '$state'" EXIT

  local page=""
  for _ in $(seq 30); do
    if page=$(curl -fs "http://127.0.0.1:$port/"); then break; fi
    sleep 1
  done
  cat "$log"
  if [[ $page != *"<title>Accompany</title>"* ]]; then
    echo "::error::npx で起動した Accompany から画面が返らない（${expected}）"
    exit 1
  fi

  # 起動役が何を起動したか（プロセスグループのコマンドライン）
  local processes
  processes=$(ps -A -o pgid=,args= | awk -v pgid="$pid" '$1 == pgid { $1 = ""; print }')
  echo "$processes"
  local runs=binary
  if grep -Eq '(^|/)bun +[^ ]*/dist/cli\.js' <<< "$processes"; then runs=bun; fi
  if [ "$runs" != "$expected" ]; then
    echo "::error::起動役が $expected ではなく $runs で動かした"
    exit 1
  fi

  kill -INT -- "-$pid"
  local status=0
  wait "$pid" || status=$?
  # npx（npm）自身も SIGINT を受けて、版によっては 130（SIGINT で終わった）で終わる。どちらも Ctrl+C で止まったものとする
  if [ "$status" != 0 ] && [ "$status" != 130 ]; then
    echo "::error::Ctrl+C（SIGINT）で止めたときの終了コードが 0 でも 130 でもない: $status"
    exit 1
  fi
  # Accompany が保存して終わるまで、プロセスグループ全体が終わるのを待つ
  for _ in $(seq 20); do
    if ! kill -0 -- "-$pid" 2> /dev/null; then break; fi
    sleep 0.5
  done
  if kill -0 -- "-$pid" 2> /dev/null; then
    echo "::error::SIGINT を送っても、Accompany が止まらない"
    exit 1
  fi
  trap - EXIT
  rm -rf "$state"
  echo "npx で起動して（${runs}${extra_env[*]+、${extra_env[*]}}）画面が返り、SIGINT で止まった（終了コード ${status}）: $install_dir"
}

check binary "$path_without_bun"
# 相対の PATH（.）にある偽の bun は使わず、実行ファイルを起動する
check binary ".:$path_without_bun"
if [ "$path_without_bun" != "$PATH" ]; then
  check bun "$PATH"
  check binary "$PATH" ACCOMPANY_USE_BINARY=1
  # ACCOMPANY_USE_BINARY は 1 のときだけ効く
  check bun "$PATH" ACCOMPANY_USE_BINARY=0
else
  echo "このマシンには Bun がないので、Bun で動かすことは確かめない"
fi
