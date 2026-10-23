# 版と使い方を表示し、誤った引数では短いエラーを出す

- 日付: 2026-10-23
- ストーリー: #147

## 背景

`accompany --version` を実行すると、Node の `parseArgs` が投げた `TypeError: Unknown option '--version'` が、ソースの抜粋とスタックつきでそのまま出ていた（実行ファイルにはソースマップを埋め込んでいるので、元のソースの行が出る）。版を確かめる手段も、使い方を見る手段もなかった。持ち主のコメントで「help がでるようにする」と決まった。

同じコメントの「ポートが使われていたら、空いているポートまで上げて起動する」は、#152 に分けた。

## 決定

- `--version`（`-v`）で `accompany <版>` を標準出力に出し、終了コード 0 で終わる。版は `app/server/package.json` の `version`（実行ファイルにも tarball にも入る）
- `--help`（`-h`）で使い方（オプションの一覧）を標準出力に出し、終了コード 0 で終わる
- 知らないオプションや、値の要るオプションに値がないときは、`Accompany: 知らないオプションです: --xxx`（または `Accompany: --port には値が要ります`）と使い方を標準エラーに出し、終了コード 1 で終わる。スタックは出さない。ほかの `parseArgs` の例外は、元の説明だけを同じ形で出す
- 起動の引数の読み取りは `app/server/src/cli-args.ts` にまとめる。版の確認（`require-bun.ts`）より後に動くので、古い Bun では今までどおり、Bun の版の案内が先に出る
- `--` のあとの引数（最初のターミナルで動かすコマンドの引数）は、これまでどおり読まずにコマンドに渡す（`accompany -- claude --version` は Claude Code の版を出す）
- npm の起動役（`npm/accompany/bin/accompany.js`）は、引数と終了コードをそのまま渡しているので変えない
- Homebrew の formula の `test do` に `--version` の確認を足すのは、この変更を含む版の Release を出して formula をその版に上げるプルリクで行う。formula を変えたプルリクでは、formula が指している Release の実行ファイル（いまは 0.19.0。`--version` を知らない）で `brew test` を流すため

## 理由

- 版の表示は `accompany 0.20.0` のように名前を付ける。`brew` の `assert_match version.to_s` でも、人が見ても分かる
- 誤った引数は利用者の入力の誤りなので、プログラムの不具合のように見えるスタックではなく、何が誤っているかと正しい使い方を出す。終了コード 1 は、`--min-window` の誤り（launch.spec.ts）や古い Bun の案内（docs/adr/78-binaries.md）と揃える

## 影響

- `launch.spec.ts` に、`--version`・`-v`・`--help`・`-h`・知らないオプション・値のない `--port` の E2E を足した。source・tarball・binary・npm のすべての起動のしかたで流れる
- README と npm の README に `--version` と `--help` を足した

## 含めないもの

- ポートが使われているときに空いているポートで起動する（#152）
- `--port` の値の検証（数でないものなど）
