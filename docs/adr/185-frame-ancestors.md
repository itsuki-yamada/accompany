# ほかのページに iframe で埋め込まれないようにする

- 日付: 2026-10-28
- ストーリー: #185（#183 の PR #184 のレビューで分かったもの）

## 背景

Accompany のページは、ほかのオリジンのページの iframe に埋め込まれることを拒んでいなかった（`Content-Security-Policy: frame-ancestors` も `X-Frame-Options` もない）。別のオリジンのページから Accompany を iframe で開いて操作でき、利用者に見えない形で重ねたボタン（`run: true` のクイックコマンドなど）を押させるクリックジャッキングができた。WebSocket とアップロードは Origin を確かめているが（`e2e/tests/security.spec.ts`）、iframe の中の Accompany は Accompany 自身のオリジンなので、それでは防げない。

一方、#183 の VS Code の拡張（PR #184）は、webview の中の iframe で Accompany を開く。`frame-ancestors` は iframe の親だけでなく祖先のすべてを確かめるため、拡張のパネルで開くには、webview（`vscode-webview:`）と、その外の workbench（デスクトップでは `vscode-file:`）を許す必要がある。

決める必要があったのは次のこと。

1. 埋め込みをどう拒むか
2. VS Code の拡張のパネルで開けるようにする方法

## 検討した選択肢

### 1. 拒み方

1. `Content-Security-Policy: frame-ancestors 'self'`
2. `X-Frame-Options: SAMEORIGIN`
3. 両方

### 2. VS Code の拡張のパネルで開く方法

1. いつも `frame-ancestors 'self' vscode-webview: vscode-file:` にする
2. 拡張が起動するときに付ける引数（`--allow-vscode-webview`）があるときだけ、`vscode-webview:` と `vscode-file:` も許す
3. 許す祖先を引数で自由に指定できるようにする（`--frame-ancestors <ソースの並び>`）

## 決定

- 画面（HTML と、そこから読み込む JS・CSS・画像）のすべての応答に `Content-Security-Policy: frame-ancestors 'self'` を付ける（1-1）
- 起動の引数 `--allow-vscode-webview` を付けたときだけ、`frame-ancestors 'self' vscode-webview: vscode-file:` にする（2-2）。VS Code の拡張は、ホストで Accompany を起動するときにこの引数を付ける（拡張の側の対応は #184 に入れる）
  - ゲストのパネルで開くのも、ホストの拡張が起動した Accompany（Live Share で転送したもの）なので、ゲストの側で引数は要らない

## 理由

- `frame-ancestors` は対応しているブラウザ（Chrome・Firefox・Safari）すべてで効き、`frame-ancestors` があるとブラウザは `X-Frame-Options` を見ない。`X-Frame-Options` には「この scheme の祖先を許す」という書き方がないので、VS Code のための許可と両立しない。そのため `X-Frame-Options` は付けない
- いつも VS Code を許す（2-1）と、ブラウザで開く利用者にも、VS Code のどの拡張の webview からでも埋め込める余地が残る。VS Code の拡張が要るときだけ許すほうが、許す範囲が狭い
- 祖先を自由に指定できる形（2-3）は、いま使う人がいない。値を確かめる手間（ヘッダーに入る文字）も増えるので、要るようになったら考える
- `vscode-webview:` だけでは足りないことを、PR #184 の VS Code の E2E（`e2e/vscode`）で確かめた。`vscode-webview:` だけを許すとパネルに Accompany が表示されず、`vscode-file:` も許すと表示された（VS Code の stable、macOS arm64）

## 影響・今後の課題

- `--allow-vscode-webview` を知らない古い Accompany に拡張が引数を付けると、知らないオプションとして起動に失敗する。拡張を配るときは、対応する Accompany の版を案内する
- VS Code for the Web では、webview は https（`vscode-cdn.net` など）のオリジンで開くので、`--allow-vscode-webview` を付けても埋め込めない。拡張が VS Code for the Web に対応するときに考える
- WebSocket・アップロードの Origin の確かめ方は変えていない。iframe の中の Accompany は Accompany 自身のオリジンなので、パネルで開いたときもこれまでどおりつながる
- Accompany の応答のうち、画面でないもの（Hono が返す 404 や API の応答）には付けていない。操作できる画面ではないため
