# Linux で初回アクセスのときに「強制終了」で落ちる報告の調査

- 日付: 2026-10-23
- ストーリー: #148

## 背景

Linux x86_64 で `accompany` を起動し、`http://127.0.0.1:3000` を開くと、プロセスが落ちるという報告があった。

```
$ accompany
Accompany: http://127.0.0.1:3000
強制終了               accompany
```

「強制終了」は、日本語の bash がジョブが SIGKILL で終わったときに出す表示（英語では `Killed`）。SIGKILL はプロセス自身では受け止められず、Bun の例外やクラッシュ（`panic`、`Segmentation fault` は「セグメンテーション違反」、`Illegal instruction` は「不正な命令」）とも表示が違う。外から送られたもの（カーネルの OOM killer、資源の上限、セキュリティの仕組みなど）である可能性が高い。

同じ報告者の #147 の出力（`at app/server/src/cli.ts:18:33` と、元のソースの抜粋）は、ソースマップを埋め込んだ実行ファイルの出力なので、Release の実行ファイル（直接か Homebrew）を使っていると考えられる。npm のパッケージはまだ公開していない。版と入れ方、メモリの大きさは分かっていない。

## 調べたこと

一時的なワークフローで、GitHub Actions の ubuntu-24.04 と ubuntu-22.04（glibc 2.39 / 2.35、16GB）で、v0.19.0 の Release の実行ファイル（linux-x64）と tarball（bunx）、リポジトリのソース（bun）を起動し、curl と Chromium（Playwright）で初回アクセスして、ターミナルに入力したあとまで `/proc/<pid>/status` を測った。CI の E2E（binary）が通っているのと同じく、どれも落ちなかった。

| 条件 | 起動後の VmRSS | 開いたあとの VmRSS（VmHWM） | 結果 |
|---|---|---|---|
| 実行ファイル | 42MB | 49MB（50MB） | 落ちない |
| 実行ファイル、`yes` を動かし続ける | 42MB | 75〜78MB（80MB）で頭打ち | 落ちない |
| tarball（bunx）、`yes` を動かし続ける | 57MB | 90MB（91MB）で頭打ち | 落ちない |
| 実行ファイル、`ulimit -v` 4G / 2G / 1G | 39〜42MB | 43〜49MB | 落ちない（仮想メモリの予約を上限に合わせて縮める） |
| 実行ファイル、`systemd-run --scope -p MemoryMax=96M / 48M / 32M -p MemorySwapMax=0` | 42MB | 48〜49MB | 落ちない（RSS の多くは実行ファイルの写像で、回収できるページ） |
| 実行ファイル、`yes` を動かし続ける、MemoryMax=96M | 42MB | 68〜77MB | 落ちない |
| 実行ファイル、`vm.overcommit_memory=2` | 43MB | 49MB | 落ちない |
| 実行ファイル、`ulimit -t 2`（CPU 時間） | 42MB | 49MB | 落ちない |
| 実行ファイル、`ulimit -u 1` | — | — | 起動の時点で SIGABRT（134）。スレッドを作れない。初回アクセスとは関係ない |
| 制御端末のある対話の bash から、前面のジョブとして起動（`script`） | 42MB | 49MB | 落ちない |
| `SHELL` が未設定 / `ps` がない | 42MB | 48MB | 落ちない |
| qemu-user で CPU の機能を絞る（`-cpu qemu64` / `kvm64`、SSE3 まで） | — | — | 起動の時点で SIGILL（132）。URL は出ない |
| qemu-user、`-cpu Nehalem`（SSE4.2 まで、AVX なし）/ `-cpu max` | 144MB（qemu を含む） | 175〜181MB | 落ちない |

- 初回アクセスでメモリが急に増える処理は見つからなかった。画面のファイルの取り出しと gzip（`static-assets.ts`）は起動のとき（URL を出す前）に済んでいて、初回アクセスで増えるのは、シェルの起動とサーバー側の端末（xterm headless、スクロールバック 1000 行）の 6〜7MB ほど。出力が止まらないコマンドでも 80〜90MB で頭打ちになる
- 実行ファイルの仮想メモリ（VmSize）は 6.5GB ほど、VmPeak は 10GB ほどあるが、予約しているだけで、`ulimit -v 1G` でも動く
- Bun の既知の不具合として、CPU の機能を絞った仮想マシン（QEMU の既定の CPU モデルなど）でメモリが膨らんで OOM で落ちる報告がある（oven-sh/bun#41361）。ただ、Accompany の実行ファイル（baseline）は、そのような CPU では起動の時点で SIGILL で落ちて URL を出さないので、今回の報告とは症状が合わない
- 手元（macOS）でも、実行ファイルは初回アクセスの前後で 31MB → 42MB だった

## 決定

- 原因は特定できなかった。コードは変えず、調べたことをこの ADR に残し、報告者に次のことを聞く
  - Accompany の版（`accompany --version`。#147 の変更より前の版では使えないので、入れたファイルの名前や `brew info accompany`）と、入れ方（Release の実行ファイル / Homebrew / tarball）
  - `dmesg`（または `journalctl -k`）に、落ちた時刻の `Out of memory: Killed process … (accompany-…)` などの記録があるか
  - `ulimit -a` の出力、メモリの大きさ（`free -m`）、コンテナや仮想マシン、WSL の中か
  - セキュリティの製品（EDR など）が入っているか。ポートで待ち受けるプロセスが、接続を受けて対話のシェルを起動するのは、リバースシェルに似ているため、止められることがある
  - `accompany -- /bin/sh`（最初のターミナルで `$SHELL` の代わりに sh を動かす）や、`--fresh` を付けても同じか
- 再現できる条件が分かったら、落ちることを確かめる E2E を先に書いて直す

## 理由

- SIGKILL は外から送られるもので、Accompany のコードの例外やクラッシュとは表示が違う。CI と同じ ubuntu で、メモリ・仮想メモリ・CPU 時間・プロセス数の上限、CPU の機能、制御端末、シェルの違いを変えても、初回アクセスで落ちる条件は見つからなかった。推測で直すと、本当の原因が分からないまま、変えたことの影響だけが残る

## 含めないもの

- 推測に基づくコードの変更（メモリの上限の設定、WebSocket の圧縮をやめる、など）
