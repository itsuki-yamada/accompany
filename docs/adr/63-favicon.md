# ファビコンの形式と配り方

- 日付: 2026-10-18
- ストーリー: #63

## 背景

ブラウザのタブで Accompany を見分けられるよう、ファビコンを付ける。元画像はユーザーが用意した 1024×1024 の JPEG（[Issue #63 のコメント](https://github.com/itsuki-yamada/accompany/issues/63)に添付）。そのまま配ると重く、tarball にも入るので、ファビコンに適した大きさに変換して入れる。

迷ったのは、どの形式・大きさを用意するかと、サーバーからどう配るか。

## 検討した選択肢

形式・大きさ:

1. 32×32 の PNG（`rel="icon"`）と 180×180 の PNG（`rel="apple-touch-icon"`）だけを用意する
2. 1 に加えて `favicon.ico`（16・32・48 を 1 つにまとめたもの）と、192・512 の PNG とマニフェストを用意する
3. 1024 の JPEG をそのまま `rel="icon"` に指定する

配り方:

1. `public/index.html` に `<link>` を書き、Bun の HTML の取り込み（`import index from "./public/index.html"`）に任せる
2. Hono に `/favicon.png` などの経路を足し、ファイルを返す

## 決定

形式・大きさは 1、配り方も 1 を採る。

- `app/server/src/public/favicon.png`（32×32）と `apple-touch-icon.png`（180×180）を、macOS の `sips` で元画像から縮小して作る。画像の中身と関係のないメタデータ（Exif・XMP）は取り除く
- `index.html` に `<link rel="icon" type="image/png" sizes="32x32">` と `<link rel="apple-touch-icon" sizes="180x180">` を書く

## 理由

- いまのブラウザは `<link rel="icon">` の PNG を使うので、`.ico` は要らない。192・512 やマニフェストは PWA としてインストールするためのもので、このストーリーの範囲（タブで見分ける）を超える
- Bun の HTML の取り込みは、`<link rel="icon">` などが指すファイルもまとめて、ハッシュ付きの名前（`/favicon-xxxx.png`）で `Content-Type: image/png` と長いキャッシュ付きで返す。CSS や JS と同じ仕組みなので、経路を自分で足す必要がなく、新しい経路の守り（loopback・同じオリジン）も考えなくてよい
- 画像は `src/public/` に置くので、`package.json` の `files`（`src`）で tarball にも入る。ビルド手順や `release.sh` の変更は要らない

## 影響・今後の課題

- `<link>` を見ずに `/favicon.ico` を取りに行くクライアント（一部のブックマークツールなど）には、アイコンが出ない
- 角の外側は透過させず、元画像の白のまま。暗いテーマのタブでは角の外側が白く見える。気になるなら、透過した画像に差し替える
- 通知（Notification）の `icon` には使っていない。使う場合は別のストーリーで扱う
