# Homebrew と npm で入れた Accompany を、署名のない実行ファイルではなく Bun で動かす

- 日付: 2026-10-28
- ストーリー: #191
- 関係する ADR: 78-binaries.md（実行ファイル）、131-homebrew.md（formula）、132-npm.md（npm のパッケージ）。この ADR は、131 の「入れるもの」と 132 の「起動の仕組み」を変える。78 の実行ファイルは、Bun を入れたくない人向けの選択肢として残す

## 背景

#167 で、Linux の実行ファイル（`accompany-0.20.0-linux-x64`）が、ブラウザがつないだ直後（シェルを起動するところ）に SIGKILL で止められた。EDR が入った環境とみられる（docs/adr/148-killed-on-first-access.md）。Homebrew で入れたものもセキュリティの製品に検知されたという話があった。

Homebrew・npm・Release のどの入れ方でも、最後に動くのは `bun build --compile` で固めた、署名のない実行ファイルだった。Bun の本体の後ろに JS を継ぎ足した形で、ハッシュも版ごとに変わり、評判による判定では「見たことのない、署名のないファイル」になる。Go や Rust のツールを `install` で配るのと同じく、動かすのを広く使われている処理系（Bun）にする。

次のことを決める必要があった。

- Bun に何を動かさせるか（tarball の中身）
- Homebrew の formula の形と、版の合わせ方（update-formula.sh）
- npm の起動役が Bun を使う条件
- Bun の版の幅と、その確かめ方
- Bun の tap（`oven-sh/bun`）の `bun` との関係
- 起動の速さ
- ps での見え方と、合図・`accompany activate` が今までどおり動くか

## 検討した選択肢

### Bun に動かさせるもの

1. これまでの tarball（`src/` の TypeScript と、`dependencies` の hono・xterm）。動かす前に依存を入れる（Homebrew なら install で `bun install`）
2. tarball に、`bun build --target=bun` で固めた JS（`dist/`）を入れ、依存は入れない
3. Release に、固めた JS を別のファイルとして置く

### Homebrew の formula の形を変える時期

1. このプルリクで、`Formula/accompany.rb` を新しい形（tarball と `depends_on "bun"`）にする
2. このプルリクでは、`update-formula.sh` が新しい形の formula を作るようにし、次の正式な Release のあとに調整役が流したときに、新しい形になる

### npm の起動役が Bun を使う条件

1. PATH に `bun` があれば使う
2. PATH に `bun` があり、その版が 1.4.0 以上なら使う。そうでなければ実行ファイルを起動する
3. どちらで動かすかを、利用者が選べるようにする（環境変数）

## 決定

### tarball の中身（選択肢 2）

- `app/server/package.json` に `build`（`bun build --target=bun --minify --sourcemap=linked --public-path=/ src/cli.ts --outdir dist`）と、それを呼ぶ `prepack` を足す。`bun pm pack` で tarball を作ると、`dist/` だけが入る（`files`）。`bin` は `dist/cli.js`
- hono と xterm は、固めた JS に入るので `devDependencies` にする。`bunx --package <tarball>` で起動したときも、依存を入れなくなる
- 画面の HTML・JS・CSS・画像は、固めた JS の横（`dist/`）に置かれ、`import index from "./public/index.html"` は、それらの一覧（manifest）になる。Bun 1.4.0〜1.4.4 では、一覧のパスが起動したディレクトリからの相対として読まれ、ほかのディレクトリで起動すると見つからない。パスを絶対パスにすると、Bun は HTML しか配らない。そのため `static-assets.ts` は、一覧のパスが相対なら、Bun に配らせずに固めた JS の横のファイルを直接読む（もともと起動時に一度だけ取り出して圧縮していたので、読み方だけが変わる）。`--public-path=/` で、HTML から読み込むパスをルートからのもの（`/index-<ハッシュ>.js`）にする。リポジトリから起動したときと実行ファイルでは、これまでどおり Bun に配らせる

### Homebrew（131 を変える）

- formula は、Release の tarball（`accompany-<版>.tgz`）を `libexec` に入れ、`depends_on "bun"`（homebrew-core）にする。`bin/accompany` は、`exec "<依存の bun の opt>/bin/bun" "<libexec>/dist/cli.js" "$@"` だけの sh のスクリプトにする。PATH の `bun`（mise などで入れた古いものかもしれない）ではなく、依存の `bun` に決めておく
- 時期は選択肢 2 にする。v0.24.0 までの tarball には `dist/` がなく、いま formula を新しい形にすると、`brew install` で入るものが動かない。このプルリクのあと、版を上げて正式な Release を出し、調整役が `update-formula.sh <版>` を流すと、新しい形の formula のプルリクになる
- `update-formula.sh` は、formula を書き換えるのではなく、スクリプトの中のひな形から作り直す。formula を変えるときは、ひな形を直す。`<版>` を渡すと、Release の tarball の digest で、`--tarball <パス>` を渡すと、手元の tarball を `file://` で入れる formula を作る（`FORMULA` で書き出す先を変えられる）
- `check-formula.sh <tarball>` は、`--tarball` で作った formula だけを入れた一時的なリポジトリを tap し、`brew style`・`brew install`・`brew test` を流す。`formula.yml` は、コミットした formula に加えて、このコミットの tarball をひな形の formula で入れて、4 つの OS と CPU で確かめる。Release を出す前に、tarball と formula の形が合うことが分かる。tarball の作り方（`app/server/package.json`）を変えたときも流す
- 依存として入った `bun` は、元から入っていなければ、`check-formula.sh` の終わりに外す（手元で流しても残さない）

### npm（132 を変える）

- 主パッケージ `accompany` に、tarball の `dist/` をそのまま入れる。`build-npm-packages.sh` は、実行ファイルのディレクトリに加えて tarball を受け取る。`release.yml` の `npm` ジョブは、E2E を通した tarball（成果物 `accompany-tarball`）も取得する
- 起動役の条件は、選択肢 2 と 3 にする
  - PATH の `bun`（起動役そのものを Bun が動かしているときは、その Bun）の版が 1.4.0 以上なら、`bun <パッケージ>/dist/cli.js <引数>` を起動する。1.4.0 は `require-bun.ts` の `required` と同じ（起動役は CommonJS の 1 ファイルなので、値を写して持つ）
  - Bun がない、古い、または `ACCOMPANY_USE_BINARY` が付いていれば、これまでどおり OS と CPU のパッケージの実行ファイルを起動する。Node だけの人も、そのまま使える。古い Bun で `require-bun.ts` に止められるより、動くほうを選ぶ
  - Bun で動かすときは、実行ファイルのパッケージがなくても（`--omit=optional`、musl の Linux、対応していない OS と CPU）起動できる
  - 合図・終了コード・引数・標準入出力の渡し方は、起動するものが Bun になるだけで変わらない
- optionalDependencies の実行ファイルのパッケージは、Bun がある人にも入る（npm は、入れる前に Bun があるかを見られない）。Bun がない人のための保険として残す

### Bun の版の幅

- 下限は 1.4.0 のままにする（`require-bun.ts`）。Homebrew の `bun` は Accompany と別に上がるので、`e2e.yml` に、tarball を展開して `dist/cli.js` を指定した版の Bun で動かす target を足す
  - `bun-min`: Bun 1.4.0（下限）。決まった版なので、いつも流す
  - `bun-latest`: mise で入れたその時の最新の Bun。新しい Bun で壊れたことに、プルリクで気づく。Release（`release.yml` から呼ぶとき）では流さない。新しい Bun で壊れても、直した版の Release を止めないため
- mise.toml の Bun は、Renovate が上げるプルリクで、`source`・`tarball`・`npm` の E2E がその版で通ることを確かめる

### oven-sh/bun の tap

- Bun の tap の formula も名前が `bun`（`oven-sh/bun/bun`）。Homebrew は、同じ名前の formula を別の tap から同時には入れられない。tap の `bun` を入れている人が `brew install itsuki-yamada/accompany/accompany` すると、（確かめた結果を下に書く）
- `depends_on "oven-sh/bun/bun"` にはしない。homebrew-core の `bun` は bottle で入り、Homebrew が版を上げる。tap の formula は、Bun が出すビルドをそのまま入れるだけで、homebrew-core に入っているほうが、利用者も多く、Homebrew の利用者にとって標準になる

### ps での見え方

- Homebrew と、npm で Bun があるときは、Accompany のプロセスは `bun …/dist/cli.js` と見える（npm では、その親に `node …/.bin/accompany` の起動役がいる）。`pkill accompany` のように名前で止めていた人は、`pkill -f dist/cli.js` などにする
- `accompany --version`・`accompany activate`・合図での終了は、どの起動のしかたでも E2E（`launch.spec.ts`、`command-output.spec.ts` など）で確かめる。どちらで動いたかは `runtime.spec.ts` が、プロセスのコマンドラインで確かめる（`ACCOMPANY_EXPECT_RUNTIME`）

## 起動の速さ

手元の Mac（Apple Silicon、macOS 26）で、同じコミットから作ったもので測った。`--version` は起動して終わるまで、待ち受けは起動してから `/` が 200 で返るまで（画面のファイルを読んで圧縮し終えたあと）。1 回目を捨てた 15 回の中央値（最小〜最大）。

| 起動のしかた | `--version` | 待ち受け |
|---|---|---|
| 実行ファイル（darwin-arm64。これまでの Homebrew と npm） | 44 ms（23〜47） | 39 ms（29〜39） |
| `bun dist/cli.js`（Bun 1.4.4。Homebrew の `bun` と同じ版） | 44 ms（27〜49） | 37 ms（30〜41） |
| `bun dist/cli.js`（Bun 1.4.0） | 51 ms（41〜56） | 38 ms（35〜41） |
| npm の起動役 → Bun | 82 ms（46〜89） | 49 ms（48〜52） |
| npm の起動役 → 実行ファイル（これまでの npm） | 80 ms（57〜84） | 47 ms（47〜50） |
| 参考: `bun src/cli.ts`（これまでの tarball の中身） | 50 ms（37〜52） | 48 ms（42〜48） |

- Homebrew（`bun dist/cli.js`）は、実行ファイルと変わらない。固めた JS を読むだけで、TypeScript の変換も HTML の取り込みもしないため
- npm の起動役で Bun を選ぶと、`bun --version` を 1 回動かす分が増えるが、差は数 ms で、起動役（Node）を挟むことによる 40 ms ほどのほうが大きい。これは 132 から変わらない

## 効き目

- 署名のない実行ファイルを置かず、利用者の多い Bun が、読めるかたちの JS を動かす。ファイルの評判による判定と、「処理系に継ぎ足した形」の判定には効く見込みが高い
- シェル（PTY）を起動する振る舞いは変わらないので、振る舞いによる判定（Web サーバーがシェルを起動する、など）には効かないことがある。#167 の環境でしか確かめられないので、報告者に新しい入れ方を試してもらう

## 影響・今後の課題

- `formula.yml` は、formula や tarball の作り方を変えたプルリクで、4 つの OS と CPU で 2 回ずつ（コミットした formula と、このコミットの tarball）入れて確かめる
- E2E の target が 4 つから 7 つ（プルリク）・6 つ（Release）になる（`npm`・`npm-binary`・`bun-min`・`bun-latest`）。リポジトリは PUBLIC なので、費用はかからない
- formula を新しい形にするのは、次の正式な Release のあとの formula のプルリクになる。それまでは、Homebrew では今までどおり実行ファイルが入る
- npm の主パッケージが、JS とソースマップの分（約 2.5MB、tarball で 0.6MB）大きくなる
- Release の実行ファイルは、これまでどおり置く。署名と公証（78 の課題）は、引き続き範囲に含めない
