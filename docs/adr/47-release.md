# main へのマージのたびに、E2E を通した tarball を Release に置く

- 日付: 2026-10-15
- ストーリー: #47

## 背景

これまでのリリースは手作業だった（`bun pm pack` → tarball から `ACCOMPANY_CMD="bunx --package <tarball> accompany"` で E2E → `git tag -a` → `gh release create --verify-tag`）。v0.1.0 のあとリリースを作り忘れ、v0.2.0 の準備中には tarball の形でだけ落ちるテストが見つかった（#46）。次の点を決める必要があった。

- 何をきっかけに Release を作るか
- プルリクの CI で、tarball の形の E2E をどう流すか
- どの tarball を置くか、名前をどうするか
- 同時に複数のマージが走ったときの扱い
- GitHub Actions の権限
- ワークフロー自体の確かめ方（E2E では書けない）

## 検討した選択肢

### きっかけ

1. `v*` のタグの push で、そのタグの Release を作る（タグとパッケージのバージョンの一致を確かめる）
2. main への push（プルリクのマージ）のたびに、正式なバージョンを自動で上げて Release を作る
3. main への push のたびに、先行版 `edge` を作り直す。package.json のバージョンの正式な Release（`v<バージョン>`）がまだなければ、それも作る

### tarball の形の E2E（プルリク）

1. `e2e.yml` に、既存のジョブとほぼ同じ手順の別ジョブを足す
2. `e2e.yml` のジョブを matrix（`source` / `tarball`）にする

### 置く tarball

1. Release を作るジョブで、もう一度 `bun pm pack` する
2. E2E を通した tarball を成果物にし、Release を作るジョブでそれを取得して置く

### ワークフローの確かめ方

1. 検証用のタグや Release を実際に作り、確かめたら消す
2. Release を作らない dry-run を用意し、プルリクの段階では dry-run で確かめる。実際の作成はマージ後の最初の実行で確かめる

## 決定

- きっかけは 3（main への push）にする。`.github/workflows/release.yml` は次の流れにする
  1. `e2e.yml` を `workflow_call` で呼び、リポジトリから起動する形と tarball から起動する形の両方で E2E を全件流す。通ったときだけ次へ進む
  2. 先行版 `edge`（プレリリース）を、そのコミットで作り直す。タグ `edge` をそのコミットに付け直し、tarball を `accompany-<バージョン>-<短いコミット ID>.tgz` として置いてから、古い tarball を消す
  3. `v<package.json のバージョン>` の Release がなければ、そのコミットにタグを作り、`accompany-<バージョン>.tgz` を置いた Release（Latest）を作る。リリースノートは使い方の一文と自動生成（直前の Latest からの差分）。Release があれば何もしない。タグだけあって Release がなければ、警告を出して何もしない
- プルリクの E2E は matrix（`source` / `tarball`）にする。`fail-fast: false` で、片方が落ちてももう片方の結果と HTML レポート（`playwright-report-source` / `playwright-report-tarball`）を残す。`tarball` では、`bun pm pack --destination "$RUNNER_TEMP/tarball-<run ID>-<attempt>"` で毎回新しい絶対パスに tarball を作り、`ACCOMPANY_CMD` を `bunx --package <絶対パス> accompany` にする。E2E を通した tarball は成果物 `accompany-tarball` にする
- `release.yml` は workflow 単位の `concurrency`（`cancel-in-progress: false`）で、main への push による実行を 1 本ずつ流す
- 権限はワークフロー全体を `permissions: {}` にし、ジョブごとに渡す。`contents: write` は Release を作るジョブだけ。サードパーティのアクションは増やさない（公式の `actions/download-artifact@v8` を足すだけ）
- `workflow_dispatch` で、Release もタグも作らずに、tarball・E2E・「何をするか」の表示までを流せるようにする（`dry_run` の既定は true）
- 確かめ方は 2 にする。`workflow_dispatch` は既定ブランチにあるワークフローしか起動できないため、プルリクの段階では、一時的に `pull_request` のきっかけを足したコミット（dry-run になる）で確かめ、確かめたら戻す。edge と正式な Release の実際の作成は、マージ後の最初の実行で確かめる。既存の `v0.1.0` / `v0.2.0` のタグと Release には触れない

## 理由

- タグ方式（1）は、タグを打ち忘れれば Release も作られず、v0.1.0 のあとの作り忘れを防げない。マージのたびに置けば、置き忘れが起きない
- マージのたびに正式なバージョンを上げる（2）と、CI が package.json を書き換えて main にコミットし直す必要があり、権限も手順も複雑になる。正式なバージョンは人がプルリクで package.json を上げたときだけ作り、それ以外のマージは edge で届ける
- edge の tarball の名前にコミット ID を入れるのは、bunx が tarball のパスごとにインストール先を使い回すため。同じ名前で上書きすると、ダウンロードし直しても古い中身で起動しうる
- matrix にすれば、手順を 1 か所に保ったまま並列に流せる。片方の形でだけ落ちる不具合（#46）を見分けられる。`workflow_call` で同じワークフローを呼べば、プルリクで確かめる手順とリリースで確かめる手順が食い違わない
- E2E を通した tarball そのものを置けば、「確かめた tarball」と「配る tarball」が同じになる
- concurrency で 1 本ずつ流せば、edge のタグと tarball の付け替えが入り混じらない。待っている実行は最新のものだけが残るが、edge は最新のコミットのものがあればよい
- 検証用の Release を作って消す方法（1）は、edge や Latest を一時的にでも汚すおそれがある。dry-run なら何も作らずに、名前の決め方や「正式な Release を作るか」の判断まで確かめられる

## 影響・今後の課題

- 正式なリリースの手順は「`app/server/package.json` の `version` を上げるプルリクをマージする」だけになる。タグと Release は Actions が作る
- タグは Actions が作る軽量タグになる（v0.1.0 / v0.2.0 は手作業の注釈付きタグ）
- main の E2E が落ちたら、edge も正式な Release も作られない。直すプルリクをマージすれば、そのときに作られる
- 待っている実行が新しい実行に置き換えられるため、続けてマージしてバージョンを 2 回上げると、間のバージョンの Release は作られないことがある
- プルリクの E2E のチェック名が `e2e` から `e2e (source)` / `e2e (tarball)` に、HTML レポートの成果物名が `playwright-report` から `playwright-report-source` / `playwright-report-tarball` に変わる
- npm レジストリへの公開はしない（必要になったら別のストーリーにする）
