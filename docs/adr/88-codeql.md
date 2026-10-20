# CodeQL は GitHub の default setup で動かす

- 日付: 2026-10-20
- ストーリー: #88

## 背景

リポジトリを公開するにあたって、CodeQL のコードスキャンを PR と main で動かしたい。対象の言語は JavaScript/TypeScript（`app/server`・`e2e`）と GitHub Actions（`.github/workflows`）。

## 検討した選択肢

1. default setup: リポジトリの設定で有効にするだけ。ワークフローのファイルは置かない。PR・main への push・週 1 回で動き、言語は自動で見つける。CodeQL の版とクエリは GitHub が上げる
2. advanced setup: `.github/workflows/codeql.yml` を置く。トリガー、クエリ、ビルドの手順を自分で決められる

## 決定

- 1 にする。持ち主が Settings → Advanced Security（Code security）→ Code scanning の CodeQL analysis で「Set up」→「Default」を選び、言語に JavaScript/TypeScript と GitHub Actions が入っていることを確かめる

## 理由

- Accompany はビルドの要らない TypeScript で、JavaScript/TypeScript と GitHub Actions は、どちらも default setup がそのまま扱える。advanced setup で変えたいもの（ビルドの手順、独自のクエリ）がない
- ワークフローを置かなければ、`permissions` の絞り込み、アクションの SHA 固定、その更新（docs/adr/87-dependency-updates.md）といった、保守するものが増えない
- どちらも GitHub Actions のランナーで動き、公開リポジトリでは無料。いまは Billing の問題で Actions が動かないので、どちらを選んでも公開までは動かない

## 影響・今後の課題

- フォークからの PR では動かない（default setup の仕様）。外部の人の PR は、main にマージしたあとの push で調べられる
- 設定はリポジトリの中に残らない。有効になっているかは、Security タブの Code scanning で確かめる
- PR のチェックに「CodeQL」が増える。必須のチェックにするかは、Branch protection を決めるときに考える
- 独自のクエリやビルドの手順が要るようになったら、advanced setup に移る（default setup を止めてから `codeql.yml` を置く）
