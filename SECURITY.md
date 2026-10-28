# セキュリティポリシー

Accompany は、ブラウザからサーバー上のコマンドを操作する道具です。脆弱性は、悪用されるとそのマシンでコマンドを実行されることにつながるため、公開する前に非公開で報告してください。

## 報告のしかた

- GitHub の Private vulnerability reporting で報告してください。このリポジトリの **Security** タブ →「**Report a vulnerability**」から送れます（[直接開く](https://github.com/itsuki-yamada/accompany/security/advisories/new)）
- 公開の Issue、プルリク、Discussions には書かないでください
- 再現の手順、影響を受ける版（Release の名前。実行ファイルと tarball の名前にも入っている）、OS とブラウザ、想定される影響を添えてください
- 個人で開発しているため、返事は数日以内を目安に、できる範囲で行います。修正を出したあと、報告者と相談して Security Advisory で公開します

## サポートする版

最新の正式な Release だけを修正の対象にします。古い版で見つかったものは、最新の Release でも再現するかを確かめてから報告してください。先行版 `edge` は、main の最新のコミットから作り直されるので、修正は main と `edge` に入ったあと、次の正式な Release に入ります。

## Release のファイルを確かめる

Release の実行ファイルと tarball は、このリポジトリの GitHub Actions（`.github/workflows/release.yml`）で作ったものです。ダウンロードしたファイルが、書き換えられていないことと、このリポジトリの CI で作られたことを、次の 2 つで確かめられます。実行ファイルはコード署名も Apple の公証も受けていないため、確かめるときはこちらを使ってください。

- チェックサム（SHA-256）: Release の `SHA256SUMS` と照らして、ダウンロードが壊れていないこと、書き換えられていないことを確かめます。`SHA256SUMS` と同じディレクトリに、確かめたいファイルを置いて実行します（置いていないファイルは `--ignore-missing` で飛ばせます）。

  ```sh
  gh release download v<版> --repo itsuki-yamada/accompany --pattern SHA256SUMS --pattern 'accompany-*-darwin-arm64'
  sha256sum --ignore-missing -c SHA256SUMS        # macOS は shasum -a 256 --ignore-missing -c SHA256SUMS
  ```

- 出どころの証明（attestation）: [GitHub の Artifact Attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)（Sigstore）による、ビルドの出どころの証明です。このリポジトリのワークフローが作ったファイルであることを、GitHub CLI（`gh`）で確かめられます。

  ```sh
  gh attestation verify accompany-<版>-darwin-arm64 --repo itsuki-yamada/accompany
  ```

`SHA256SUMS` と出どころの証明が付くのは、このしくみを入れたあとの Release（と先行版 `edge`）からです。それより前の Release には付いていません。

## 前提（このとおりに動くこと）

README の「[接続の制限](README.md#接続の制限)」のとおり、次を前提にしています。

- `127.0.0.1` だけで待ち受ける。ほかのマシンからは、Live Share のサーバーの共有や SSH のポート転送などでつなぐ
- 認証はまだない（[#7](https://github.com/itsuki-yamada/accompany/issues/7)）。ポートにつなげる人は、誰でもターミナルを操作し、コマンドを実行できる
- ターミナルの操作（WebSocket）とファイルのアップロードは、Host が loopback（`localhost`・`127.0.0.1`・`[::1]`）で、Origin が Host と同じ接続だけを受け付ける

## 対象とするもの

前提を破れるものを対象にします。たとえば次のものです。

- `127.0.0.1` 以外から、待ち受けているポートにつなげる
- ほかのサイトのページから、WebSocket やアップロードで端末を操作できる（Host・Origin の確かめのすり抜け、DNS rebinding など）
- アップロードしたファイルが、置き場所の外に書かれる
- ターミナルの出力やタイトルなどから、Accompany の画面でスクリプトが動く（XSS）
- 細工した入力で、Accompany のサーバー（Bun のプロセス）が落ちる、または意図しないコマンドが動く

## 対象としないもの

- 認証がないこと（#7 で扱う）。同じマシンのほかのユーザーや、ポートを転送した相手がターミナルを操作できること
- Live Share のゲストや、ポートを共有した相手が、ホストのマシンでコマンドを実行できること（README の「Live Share で使う」に書いた、意図した動き）
- Accompany の中で動かすコマンド（シェルやコーディングエージェント）そのものの脆弱性
- Bun や依存パッケージの脆弱性で、Accompany から悪用できないもの（それぞれの開発元に報告してください）

## English summary

Please report vulnerabilities privately via GitHub's Private vulnerability reporting (**Security** tab → **Report a vulnerability**), not in public issues or pull requests. Only the latest release is supported. Accompany listens on `127.0.0.1` only, has no authentication yet (#7), and accepts WebSocket and upload connections only when the Host is loopback and the Origin matches the Host. Reports that break these assumptions (e.g. remote access, cross-site terminal control, DNS rebinding, path traversal on upload, XSS) are in scope. The lack of authentication itself and command execution by people you shared the port with are out of scope.
