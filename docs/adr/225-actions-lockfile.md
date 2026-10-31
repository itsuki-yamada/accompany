# GitHub Actions の依存をロックファイルで固定し、Dependabot で更新を受け取る

- 日付: 2026-10-31
- ストーリー: #225

## 背景

docs/adr/87-dependency-updates.md では、ワークフローの `uses:` をコミットの SHA に固定し（`@<SHA> # v7.0.1`）、Renovate で SHA と版のコメントを上げると決めた。これには次の問題があった。

- アクションが中で使うアクション（推移的な依存）が固定されるかは、そのアクションの書き方次第になる。たとえば composite action の `actions/attest-build-provenance` は、中の `actions/attest` を SHA で呼んでいるが、タグで呼ぶアクションもある
- SHA だけでは、アクションのリポジトリがすり替わった（名前を取り直された）ことに気づけない
- Renovate の GitHub App はまだ入っておらず、Actions の更新の PR は 1 本も届いていない

2026-10-28 に、GitHub Actions のワークフローのロックファイル（`.github/workflows/actions.lock`）が GA になった。ロックファイルには、ワークフローごとの依存と、依存ごとの `ref`（タグかブランチ）・実際に動くコミット・リポジトリの `owner_id` と `repo_id` が入る。推移的な依存も入る。ランナーは、ジョブを始めるときに、ロックファイルのコミットが `ref` から辿れること、リポジトリの ID が同じことを確かめ、違えば実行を止める。ロックファイルは GitHub CLI の拡張 `gh actions-lock`（github/gh-actions-lock）で作り、手で書き換えない。Dependabot は、ロックファイルに載ったワークフローのアクションを上げるとき、同じ PR でロックファイルも作り直す。

参照した文書（2026-10-31 時点）:

- https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles
- https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies
- https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles
- https://github.com/github/gh-actions-lock （README、docs/troubleshooting.md、.github/workflows/verify-lockfile.yml、.github/dependabot.yml）

次のことを決める必要があった。

- `uses:` の書き方（SHA かタグか）。タグのないアクションをどうするか
- Actions の更新を、Renovate と Dependabot のどちらで受け取るか
- ロックファイルが古くなっていないことを、どう確かめるか

## 検討した選択肢

### `uses:` の書き方

1. これまでどおり SHA に固定し、ロックファイルも作る
2. タグ（`@v7.0.1` のような完全な版）で書き、実際に動くコミットはロックファイルで固定する

### Actions の更新

1. Renovate のまま（App を入れる）
2. Dependabot（`.github/dependabot.yml` の `github-actions`）。Renovate では Actions を扱わない

### ロックファイルの確かめ方

1. ランナーの確かめ（実行時）だけに任せる
2. プルリクと main への push で `gh actions-lock --verify` を流すワークフローを足す

## 決定

- `uses:` は 2 にする。すべて完全な版のタグで書き、動くコミットは actions.lock で固定する
  - `Homebrew/actions/setup-homebrew` は、これまで「タグがない」として `main` のコミットに固定していたが、今は週 1 回ほど日付のタグ（`2026.10.26.1` など）が付き、GitHub の Release にもなっている。これまで固定していたコミット（`d482da0`）は `2026.10.26.1` と同じだったので、そのタグにする。ブランチ（`main`）のままロックファイルで固定する案は、Dependabot がブランチの参照を上げず、`gh actions-lock --relock` を手で流す必要があるので採らない
  - `release.yml` が呼ぶ `./.github/workflows/e2e.yml`（同じリポジトリの再利用ワークフロー、`jobs.<id>.uses`）はロックファイルの対象外。ただし、呼ばれる側の e2e.yml はロックファイルに載っており、そのアクションは固定される。`./` のアクション（`steps[*].uses`）は今は使っていない
- 4 つのワークフロー（e2e.yml、formula.yml、release.yml、verify-lockfile.yml）をすべてロックファイルに載せる。載った依存は次のとおり

  | 依存 | ref | コミット | 使うワークフロー |
  |---|---|---|---|
  | actions/checkout | v7.0.1 | 3d3c42e | e2e、formula、release、verify-lockfile |
  | jdx/mise-action | v5.2.4 | 6be3c7e | e2e、formula |
  | actions/upload-artifact | v7.0.2 | cf430e0 | e2e |
  | Homebrew/actions（setup-homebrew） | 2026.10.26.1 | d482da0 | formula |
  | actions/download-artifact | v8.0.2 | 9000827 | release |
  | actions/attest-build-provenance | v4.2.2 | 4d10147 | release |
  | actions/attest（attest-build-provenance の中から使う、推移的な依存） | v4.2.1 | 508db95 | release |
  | actions/setup-node | v7.1.0 | 949feb2 | release |

- Actions の更新は 2 にする。`.github/dependabot.yml` を置き、Renovate の設定（renovate.json）では `matchManagers: ["github-actions"]` を `enabled: false` にし、`helpers:pinGitHubActionDigests` を外す。依存パッケージと mise.toml の Bun は、これまでどおり Renovate が扱う
  - 頻度とまとめ方は ADR 87 に合わせる。週 1 回、月曜の 0 時（日本時間）。major 以外（minor・patch）は 1 つの PR（グループ `non-major`）にまとめ、major は依存ごとに PR にする
  - 公開から 3 日たった版だけを PR にする（`cooldown.default-days: 3`。Renovate の npm と同じ日数）。github-actions では、Dependabot の cooldown は `default-days` だけが効く。`gh actions-lock` も、この日数より新しいタグを固定したときに `fresh-tag` で知らせる（`default-days` だけを読み、ほかのキーがあると `cooldown-config-ignored` を出す）
  - コミットメッセージは、接頭辞だけ `chore(deps):` にする。Dependabot は本文（`bump X from A to B`）とグループの PR のタイトルを変えられないので、日本語にはならない
- ロックファイルの確かめ方は 2 にする。`.github/workflows/verify-lockfile.yml` を、配布元の同名のワークフローを元に足す
  - プルリクと main への push で、`gh actions-lock --verify` を流す。ロックファイルがワークフローの `uses:` と合っていない、固定したコミットがタグやブランチから辿れない、リポジトリの ID が違う、といったときに落ちる
  - 必須のチェックにしても待ち続けないよう、`paths` で絞らない
  - 拡張の版は `--pin v0.4.0` で固定する。Dependabot はこれを上げないので、手で上げる
  - このワークフロー自体もロックファイルに載せる

### 持ち主に提案すること（このプルリクでは変えない）

- verify-lockfile を必須のチェックにする（main の ruleset の required status checks に `verify-lockfile` を足す）。ロックファイルの直し忘れを、マージの前に止められる
- リポジトリの Actions の設定で **Require lockfile** を有効にする。ロックファイルに載っていないワークフローは実行されなくなる。いまのワークフローはすべて載っているので、このプルリクのマージ後に有効にしてよい。以後、ワークフローを足したら、同じプルリクで `gh actions-lock` を流してロックファイルに載せる必要がある

## 理由

- ロックファイルなら、推移的な依存とリポジトリの ID まで固定でき、実行時にランナーが確かめる。SHA の固定より守れる範囲が広い
- 動くコミットをロックファイルで固定するなら、`uses:` を SHA にしておく理由はなくなる。タグで書けば、どの版を使っているかがワークフローを読むだけで分かる。完全な版のタグ（`v7.0.1`）が付け替えられたら、ロックファイルのコミットと合わなくなり、`--verify` とランナーが止める
- Dependabot は、`uses:` とロックファイルを同じ PR で上げられる。Renovate がロックファイルを作り直せるかは確かめられておらず、作り直せないと、Actions の更新の PR がすべて verify-lockfile で落ちる
- Dependabot は設定ファイルを置くだけで動き、App のインストールが要らない。Renovate の App がまだ入っていないので、Actions の更新は Dependabot のほうが早く届く
- ADR 87 で Dependabot を採らなかった理由は mise.toml の Bun に対応していないことで、Actions には当てはまらない。Actions だけを Dependabot に分ければ、仕組みが 2 つになっても、それぞれの受け持ちは重ならない
- 3 日の cooldown は、乗っ取られた版が見つかって取り下げられるのを待つため（ADR 87 の npm と同じ考え）

## ADR 87 のうち、この ADR で置き換えたところ

ADR 87 の本文は変えない。次の点は、この ADR が優先する。

- 「決定」の「ワークフローの `uses:` は、すべてコミットの SHA に固定し、末尾に版のコメント（`# v7.0.1`）を付ける。Renovate が SHA とコメントを一緒に上げる」→ `uses:` は完全な版のタグで書き、動くコミットは actions.lock で固定する。上げるのは Dependabot
- 「決定」の 2（Renovate だけ）のうち GitHub Actions → Actions は Dependabot が扱い、Renovate では扱わない（`helpers:pinGitHubActionDigests` も外した）
- 「理由」の「タグ（`@v7`）は、あとから別のコミットに付け替えられる。SHA に固定すれば、確かめたコードだけが動く」→ 付け替えはロックファイルとランナーの確かめで止める
- 「影響・今後の課題」の「Actions の SHA 固定は、ワークフローを足すときにも守る」→ ワークフローを足したり `uses:` を変えたりしたら、`gh actions-lock` を流してロックファイルを直す
- 「決定」の脆弱性の項の「GitHub Actions は、版を SHA で固定すると alert が出ない」→ タグで書いたので、Actions にも Dependabot alerts が出るようになる見込み。Dependabot security updates は、ADR 87 のとおり使わない（有効にすると npm の依存にも PR が届き、Renovate と二重になる）。alert が出たら、週 1 回の更新を待たずに手で上げる

## 影響・今後の課題

- ワークフローを足す、または `uses:` を変えるプルリクでは、`gh actions-lock` を流してロックファイルもコミットする。忘れると verify-lockfile が落ちる（Require lockfile を有効にしたあとは、ワークフローそのものが実行されない）
- Dependabot は、ロックファイルに載っていないワークフローを載せない（載せるのは `gh actions-lock` だけ）
- Dependabot の PR は、同じリポジトリのブランチ（`dependabot/…`）からの PR なので、e2e.yml と verify-lockfile.yml がふつうに流れる。Dependabot が起こした実行の `GITHUB_TOKEN` は読み取りだけだが、`gh actions-lock --verify` は公開リポジトリを読むだけなので足りる
- Dependabot の PR は、Project には自動で入らない
- 浮動の参照（`v4`、`main`）を古いコミットに戻すロックファイルの変更は、`gh actions-lock` では見つからない。`uses:` は完全な版のタグで書き、ロックファイルの差分のコミットが変わっていたら、版を上げるのと同じように確かめる
- verify-lockfile の `gh-actions-lock` の版（`--pin`）は手で上げる
- コンテナのイメージはロックファイルの対象外（いまは使っていない）
