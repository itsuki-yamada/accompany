# OS と CPU ごとの実行ファイルを、ubuntu でクロスコンパイルして Release に置く

- 日付: 2026-10-20
- ストーリー: #78

## 背景

Release には tarball だけを置いていて（docs/adr/47-release.md）、`bunx --package <tarball> accompany` で起動する。利用者のマシンに Bun が要る。M3 の Mac で、tarball からは起動できなかったという報告があった（エラーの内容はまだ聞けていない）。

Bun の `bun build --compile` で OS と CPU ごとの実行ファイルを作り、Bun を入れていないマシンでも起動できるようにする。次のことを決める必要があった。

- M3 で起動できなかった原因
- どの OS と CPU 向けを、どこで作るか
- 実行ファイルの E2E をどこまで CI で流すか（リポジトリは PRIVATE で、macOS のランナーは分単位の費用が高い）
- 名前と置き方
- macOS の署名と Gatekeeper

## 調査: M3 で tarball から起動できなかった原因

Accompany にアーキテクチャに依存するもの（ネイティブモジュール）はない。そこで Bun の版を疑い、手元の Apple Silicon（arm64）の Mac で、古い Bun（mise で入れた公式のビルド）を PATH の先頭にして、tarball から bunx で起動した。

| Bun | 起動 | 画面 |
|---|---|---|
| 1.2.23 / 1.3.4 / 1.3.5 / 1.3.10 / 1.3.14 | URL を表示する | 何も出ない |
| 1.4.0 / 1.4.1 / 1.4.2 / 1.4.3 | URL を表示する | 出る |

- Bun 1.3 までは、bunx がインストールした先（起動したディレクトリの外）にある HTML を取り込むと、HTML が参照する JS と CSS の URL が `/../../…/<起動したディレクトリ>/chunk-….js` のように壊れ、404 になる。サーバーは起動して URL も表示し、エラーも出ないので、ブラウザで開くと画面が空のままになる
- また、PTY を作る `Bun.spawn` の `terminal` は Bun 1.3.5 で入ったので、それより古い Bun では画面が出てもターミナルは動かない
- アーキテクチャには依存せず、arm64 の Mac でそのまま再現した。報告の原因は、Bun が 1.4 より古かったことの可能性が高い。ほかに、Bun が入っていない、tarball を相対パスで指定した（bunx が失敗する）、なども考えられる。エラーの内容を聞けたら確かめる

## 検討した選択肢

### 古い Bun で起動されたとき

1. 何もしない（実行ファイルを案内するだけ）
2. 起動の最初に Bun の版を確かめ、1.4.0 より古ければ、必要な版と実行ファイルの案内を表示して終了する
3. package.json の `engines` に書く

### 作る場所

1. OS と CPU ごとのランナー（macOS の arm64・x64、ubuntu の x64・arm64）でそれぞれ作る
2. ubuntu のランナー 1 台で、4 つすべてをクロスコンパイルする

### macOS 向けの E2E

1. CI で macOS のランナーを使って流す
2. CI では流さず、プルリクのたびに、CI で作った darwin-arm64 を手元の Apple Silicon の Mac で起動し、E2E を流して記録する

### 置き方

1. 実行ファイルをそのまま置く
2. zip や tar.gz に固めて置く（実行の権限を保てる）

## 決定

- 古い Bun では 2 にする。`app/server/src/require-bun.ts` を `cli.ts` で最初に読み込み、Bun が 1.4.0 より古ければ「Bun 1.4.0 以上が必要です（いまの Bun: …）」と、`bun upgrade` か実行ファイルを使う案内を表示して、終了コード 1 で終わる。E2E（`bun-version.spec.ts`）で、Bun 1.3.14 で起動したときを確かめる。実行ファイルは Bun を中に持っているので、この確認はいつも通る
- 実行ファイルは次の 4 つにする。名前は `accompany-<バージョン>-<OS>-<CPU>`、edge では `accompany-<バージョン>-<短いコミット ID>-<OS>-<CPU>`（tarball と同じく、どのコミットのものか分かるようにする）

  | 名前の末尾 | `--target` |
  |---|---|
  | `darwin-arm64` | `bun-darwin-arm64` |
  | `darwin-x64` | `bun-darwin-x64-baseline` |
  | `linux-x64` | `bun-linux-x64-baseline` |
  | `linux-arm64` | `bun-linux-arm64` |

- x64 は baseline にする。既定（modern）は AVX2 を使い、2013 年より前の Intel の CPU や、AVX2 を渡さない仮想マシンでは起動できない。Accompany は計算の重い処理がなく、baseline の遅さは問題にならない
- Linux 向けは glibc の上で動く。Alpine などの musl では動かない（必要になったら `-musl` を足す）
- 作る場所は 2 にする。`.github/scripts/build-binaries.sh` で 4 つを作る。`e2e.yml` の matrix に `binary` を足し、ubuntu のランナーで 4 つを作って、`ACCOMPANY_CMD` を linux-x64 の実行ファイルにして E2E を全件流す。E2E を通した 4 つを成果物 `accompany-binaries` にし、`release.yml` がそれを取得して、tarball と並べて edge と正式な Release に置く
- 成果物 `accompany-binaries` は 4 つで 300MB を超えるので、残すのは 1 日にする（同じ実行の `release.yml` が取得できればよい）
- macOS 向けの E2E は 2 にする。linux-arm64 も CI では流さない
- 置き方は 1 にする。ダウンロードしたら `chmod +x` が要るが、`gh release download` で 1 つを選んで落とし、そのまま起動できる。README に手順を書く
- edge の古いファイルは、今回置いたもの（tarball と 4 つの実行ファイル）以外をすべて消す
- macOS の署名: Bun の `--compile` は darwin-arm64 に ad-hoc 署名（`linker-signed`）を付ける。Apple Silicon は署名のない実行ファイルを起動しないが、ad-hoc 署名があれば起動できる。darwin-x64 には Bun 本体の署名が残っていて、実行ファイルにしたことで無効になっているが、Intel（と Rosetta）では署名がなくても起動できる。Apple の Developer ID での署名と公証は、この範囲に含めない
- Gatekeeper: ブラウザでダウンロードすると quarantine の属性が付き、Developer ID の署名と公証がないので、起動を止められる。README に、実行する前に `xattr -d com.apple.quarantine` で外す手順と、`gh release download` や `curl` で落とせば属性が付かないことを書く

## 理由

- Bun 1.3 では、エラーも出ずに画面が空になるだけで、利用者には原因が分からない。起動の最初に止めれば、何をすればよいかがすぐ分かる。`engines` は bunx が確かめないので効かない
- macOS のランナーは、PRIVATE のリポジトリでは ubuntu の 10 倍の分数として数えられる。E2E の全件（数分）をプルリクとマージのたびに流すと費用がかさむ。Bun のクロスコンパイルは、どの OS からでも同じ Bun の実行時を同梱するだけなので、ubuntu で作って linux-x64 で E2E を通せば、Accompany 側のコード（HTML の取り込み、xterm、PTY）が実行ファイルの形で動くことは確かめられる。OS ごとの差（Bun の実行時）は Bun 側で確かめられている
- 手元の Mac で、CI が作った darwin-arm64 そのものを確かめれば、「確かめたもの」と「配るもの」が同じになる
- 1 台でクロスコンパイルすれば、作る手順が 1 か所にまとまり、ランナーを 4 つ用意しなくてよい
- 固めて置くと、展開の手順が増える。1 つのファイルなら、`gh release download --pattern` で自分のものだけを選べる
- Developer ID での署名と公証には、Apple Developer Program への登録と、macOS のランナー（または署名の仕組み）が要る。いまの利用者は開発者で、`xattr` の手順で足りる

## 影響・今後の課題

- プルリクの E2E のチェックに `e2e (binary)` が増える
- Release の資産が、tarball 1 つから、tarball と実行ファイル 4 つ（1 つ 70〜90MB）になる。edge は古いものを消すので、増えるのは正式な Release の分だけ
- macOS（arm64・x64）と linux-arm64 の実行ファイルは、CI では E2E を流さない。darwin-arm64 は手元の Mac で確かめてプルリクに記録する。darwin-x64 と linux-arm64 は、壊れても CI では気づけない
- 利用者が増えたら、Developer ID での署名と公証、musl 向け、Homebrew などでの配布を検討する
