# Homebrew の formula をこのリポジトリに置き、Release のあとに調整役がプルリクで版を合わせる

- 日付: 2026-10-22
- ストーリー: #131

## 背景

Release の実行ファイル（docs/adr/78-binaries.md）を、Homebrew で入れて `brew upgrade` で上げられるようにする。tap はこのリポジトリの中に置く（ユーザーの判断）。`brew tap itsuki-yamada/accompany https://github.com/itsuki-yamada/accompany` のあと入れる形。次のことを決める必要があった。

- formula で何を入れるか
- Release を出したあと、formula の版と sha256 をどう合わせるか。main はルールセットでプルリクが必須（必須のチェックは `e2e (source)` / `(tarball)` / `(binary)`、bypass なし）なので、formula の更新もプルリクになる
- formula をどう確かめるか

## 検討した選択肢

### 入れるもの

1. Release の OS と CPU ごとの実行ファイル（`on_macos` / `on_linux` と `on_arm` / `on_intel` で選ぶ）
2. tarball と、依存に Bun（`depends_on "oven-sh/bun/bun"` など）

### formula の版と sha256 の合わせ方

1. 調整役が、Release のあとにスクリプト（`.github/scripts/update-formula.sh <版>`）で formula を書き換え、プルリクを作る。バージョンを上げるプルリクと同じ流れ
2. Release を作るジョブ（`release.yml`）が、`GITHUB_TOKEN` で formula を書き換えたプルリクを作る
3. 2 を、持ち主が用意する PAT か GitHub App のトークンで行う
4. formula を別のリポジトリ（`homebrew-accompany`）に置き、ルールセットをかけずに、Release を作るジョブがそこへ直接 push する
5. バージョンを上げるプルリクで、formula も一緒に上げる

### 確かめ方

1. 手元で確かめるだけ
2. formula を変えたプルリクで、`brew style`・`brew install`・`brew test` を CI で流す。ubuntu だけ、または 4 つの OS と CPU

## 決定

- 入れるものは 1 にする。`Formula/accompany.rb` が、Release `v<版>` の `accompany-<版>-<OS>-<CPU>` を選び、`bin/accompany` として入れる。sha256 は GitHub が Release の各ファイルに付ける digest と同じもの
- `livecheck` は Release の Latest（`:github_latest`）を見る。`brew livecheck` で formula が遅れているかを確かめられる
- `test do` は、空いているポートで起動し、`curl` で画面の HTML（`<title>Accompany</title>`）が返ることを確かめて、SIGTERM で止める。画面の保存先（`ACCOMPANY_STATE_DIR`）はテストの作業ディレクトリにする
- 版の合わせ方は 1 にする。`update-formula.sh <版>` は、`gh release view` で Release の 4 つの実行ファイルの digest を取り、formula の `version`・`url`・`sha256` を書き換える（ダウンロードはしない）。Release に実行ファイルが 1 つでも欠けていれば、書き換えずに失敗する。調整役は、正式な Release ができたのを確かめてから流し、`chore: Homebrew の formula を <版> にする` のようなプルリクを作る。formula は tarball の中身ではないので、このプルリクではバージョンを上げない
- 確かめ方は 2 にし、4 つの OS と CPU（`macos-latest`・`macos-15-intel`・`ubuntu-latest`・`ubuntu-24.04-arm`）で流す。`.github/workflows/formula.yml` が、formula と確かめる手順（`.github/scripts/check-formula.sh`・`update-formula.sh`）を変えたプルリクだけで、`check-formula.sh` を流す。スクリプトは、このリポジトリのチェックアウトを tap し、`brew style`・`brew install`・`brew test` を流して、最後に外す。必須のチェックにはしない
- 利用者には、最初の `brew install` を `itsuki-yamada/accompany/accompany` と tap の名前付きで案内する。Homebrew 7 は、信頼していない tap の formula を読み込まず、名前を付けて入れたものを信頼する（`brew install accompany` だけでは断られた）。入れたあとは `brew upgrade accompany` で上がる

## 理由

- 実行ファイルなら Bun が要らず、Homebrew 側でビルドもしない。Release の E2E を通した実行ファイルそのものを入れるので、「確かめたもの」と「入れるもの」が同じになる
- `GITHUB_TOKEN` で作ったプルリクでは、ほかのワークフロー（必須の E2E）が動かないので、マージできない（2）。動かすには、人が閉じて開き直すなどの手間がかかる
- 3 は自動になるが、持ち主がトークンを作り、期限や権限を管理し続ける必要がある。トークンは main への書き込みに近い権限になる
- 4 は、tap をこのリポジトリに置くというユーザーの判断と合わない。別のリポジトリへの push にもトークンが要る
- 5 は、sha256 が CI がマージ後に作る実行ファイルで決まるので、マージ前には分からない
- 1 は、バージョンを上げるプルリクと同じ流れで、新しい権限もトークンも要らない。formula が新しい版になるまで少し遅れるが、その間は前の版が入るだけで、壊れはしない
- Homebrew の formula は、OS と CPU ごとに別の url を選ぶ。どれか 1 つの url や sha256 の誤りは、その OS と CPU で入れたときにしか分からないので、4 つで流す。リポジトリは PUBLIC なので、macOS と arm64 のランナーにも費用はかからない。formula を変えたときだけ流すので、プルリクごとの待ち時間も増えない

## 確かめたこと

- 手元の Mac（Apple Silicon）で、このリポジトリを tap し、`update-formula.sh 0.14.0` で書き換えた formula で 0.14.0 を入れ、`update-formula.sh 0.15.0` に戻して `brew upgrade accompany` で 0.15.0 に上がること、`brew test` が通ることを確かめた
- その `/opt/homebrew/bin/accompany` に対して、`ACCOMPANY_CMD` で E2E を全件流し、通った

## 影響・今後の課題

- 正式な Release のあとに、調整役が `update-formula.sh` を流してプルリクを作る手順が増える。忘れると、Homebrew の利用者は前の版のまま。`brew livecheck itsuki-yamada/accompany/accompany` で遅れに気づける
- `brew update` は、tap した main の formula を取り込む。formula のプルリクがマージされるまでは、`brew upgrade` しても上がらない
- edge は formula にしない（`--HEAD` も用意しない）
- Homebrew/core への登録はしない
