# 依存・Bun・GitHub Actions の新しい版を、Renovate の PR で受け取る

- 日付: 2026-10-20
- ストーリー: #87

## 背景

hono・xterm・Playwright などの依存パッケージ（`app/server` と `e2e` の package.json と bun.lock）、mise.toml の Bun、ワークフローで使う GitHub Actions の版は、手で上げるしかなかった。セキュリティの修正を取り込み遅れないよう、新しい版を PR で自動で受け取りたい。次のことを決める必要があった。

- Dependabot と Renovate のどちらを使うか
- PR のまとめ方と頻度
- GitHub Actions の版の固定のしかた

## 検討した選択肢

### 仕組み

2026-10 の時点で、それぞれの公式ドキュメントで確かめた。

| | Dependabot | Renovate |
|---|---|---|
| bun.lock | 対応（`package-ecosystem: bun`、テキストの bun.lock） | 対応（`bun` マネージャー） |
| mise.toml | 未対応（`package-ecosystem` に mise がない） | 対応（`mise` マネージャー。`[tools]` の bun を見る） |
| GitHub Actions の SHA 固定 | 対応（`@<SHA> # v1.2.3` の SHA とコメントを上げる） | 対応（同じ。`helpers:pinGitHubActionDigests` で固定もする） |
| まとめ方 | `groups` で update-types ごとにまとめられる | `packageRules` で柔軟にまとめられる |
| PR のタイトル | 接頭辞（`chore(deps):`）は変えられるが、本文（`bump X from A to B`）は英語のまま | 動詞と語順をテンプレートで変えられる |
| 導入 | 設定ファイルを置くだけ | 設定ファイルに加え、持ち主が GitHub App（Mend Renovate）をインストールする |

1. Dependabot だけ
2. Renovate だけ
3. Dependabot と、mise.toml だけ別の仕組み（Bun の版を見る自作のワークフローなど）

### まとめ方と頻度

1. 依存ごとに、出たらすぐ PR
2. 週 1 回。major 以外はすべて 1 つの PR にまとめ、major は依存ごとに PR

## 決定

- 2 にする。直下に `renovate.json` を置く
- 週 1 回（月曜の 0 時から 9 時まで、日本時間。`schedule` は cron で `* 0-8 * * 1`）。major 以外（minor・patch・SHA の更新）は 1 つの PR「`chore(deps): major 以外の依存 を上げる`」にまとめ、major は依存ごとに「`chore(deps): hono を v5 にする`」のような PR にする。ただし、同じリポジトリから出る xterm のパッケージ（`@xterm/*`）は、`config:recommended` の `group:monorepos` により、major も「`chore(deps): xterm monorepo を上げる (major)`」の 1 つの PR にまとまる（同時に上げないと組み合わせが合わないので、そのほうがよい）
- npm のパッケージは、公開から 3 日たった版だけを PR にする（`security:minimumReleaseAgeNpm`）
- ワークフローの `uses:` は、すべてコミットの SHA に固定し、末尾に版のコメント（`# v7.0.1`）を付ける。Renovate が SHA とコメントを一緒に上げる
- 脆弱性の修正は、週 1 回の予定を待たずに PR にする（Renovate の `vulnerabilityAlerts`、既定で有効）。脆弱性は 2 つから拾う
  - GitHub の Dependabot alerts: GitHub の dependency graph が見つけた依存の alert を、Renovate が読む。dependency graph は bun.lock に対応していないので、見つかるのは package.json に書いた直接の依存だけ。GitHub Actions は、版を SHA で固定すると alert が出ない（alert は semver の版を指したものだけ）
  - OSV（`osvVulnerabilityAlerts: true`。Renovate が osv.dev のデータを直接引く。Renovate では experimental）: package.json の直接の依存のうち、版を固定したもの（`@xterm/*`、`@playwright/test`）。`^4.13.13` のような範囲で書いた hono は調べない（Dependabot alerts のほうで拾う）。GitHub Actions、mise.toml の Bun は、Renovate の OSV の対象外
  - どちらでも拾えないもの: bun.lock の間接的な依存、mise.toml の Bun、SHA で固定した GitHub Actions。これらは週 1 回の版の更新で追いつく
- Dependabot security updates は使わない（Renovate と同じ PR が二重に届くのを避ける。bun の security updates には Dependabot が対応していない）
- 届いた PR は、同じリポジトリのブランチ（`renovate/…`）からの PR なので、`e2e.yml` の `pull_request` でふつうに E2E が流れる。通ったらマージする

## 理由

- mise.toml の Bun を、ほかの依存と同じ仕組みで上げられるのは Renovate だけ。3 のように自作のワークフローを足すと、仕組みが 2 つになり、保守の手間が増える
- Bun は E2E を流す実行時であり、実行ファイルに同梱する実行時でもある（docs/adr/78-binaries.md）。上げ忘れを防ぐ価値が大きい
- PR のタイトルを、このリポジトリのコミットメッセージ（日本語の Conventional Commits）に合わせられる
- GitHub App のインストールは、持ち主が一度だけ行えばよい
- 依存が少なく（app/server に 6 つ、e2e に 1 つ、Actions が 4 つ）、major 以外を 1 つにまとめれば、週に 1〜2 本の PR で済む。major は破壊的な変更があり得るので、1 つずつ E2E で確かめる
- 脆弱性の alert は 1 つの仕組みでは拾いきれない。dependency graph と OSV を合わせ、拾えないものは週 1 回の更新で上げる
- 公開直後の版には、乗っ取られたパッケージが紛れることがある。3 日待てば、多くは見つかって取り下げられる
- タグ（`@v7`）は、あとから別のコミットに付け替えられる。SHA に固定すれば、確かめたコードだけが動く

## 影響・今後の課題

- 持ち主が Mend Renovate の GitHub App をこのリポジトリにインストールするまで、PR は届かない。インストールすると、Renovate が設定を確かめ、Issue「依存の更新の一覧（Renovate）」を作って、届く予定の PR を一覧にする
- Renovate の PR は、Project には自動で入らない
- 間接的な依存と Bun、Actions の脆弱性は、alert では知らされない。週 1 回の更新の PR をためずにマージする
- bun.lock の間接的な依存だけの更新（lock file maintenance）はしない。いまは直接の依存がほとんど間接的な依存を持たない。必要になったら有効にする
- Actions の SHA 固定は、ワークフローを足すときにも守る（Renovate は、固定されていない `uses:` を固定する PR を出す）
