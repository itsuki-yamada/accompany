# リンクのスキームの確認と、その E2E の作り方

- 日付: 2026-10-17
- ストーリー: #61

## 背景

#60 で、ターミナルのリンクを開く処理を `public/pane.ts` の `openLink` にまとめ、`Terminal` の `linkHandler` と `WebLinksAddon` の両方に渡した。`openLink` は URL のスキームを確かめずに新しいタブで開く。

いまは次の理由で、http・https 以外の URL は `openLink` に届かない。

- xterm.js は、`linkHandler.allowNonHttpProtocols` が有効でなければ、OSC 8 のリンクのうち `new URL()` で解釈できないものと http・https 以外を捨てる
- `WebLinksAddon` は http・https の URL しかリンクにしない

ただし設定の変更や xterm.js の更新で届くようになると、`javascript:` のリンクで Accompany と同じオリジンのスクリプトが動く（実際に、絞り込みを外した状態で `javascript:` のリンクをクリックすると、新しいタブで Accompany のオリジンの `localStorage` に書き込めることを E2E で確かめた）。多層防御として `openLink` でも確かめる。

困るのはテストの作り方で、画面からのクリックだけでは xterm.js が先に捨てるので、`openLink` の確認がなくても落ちない（Red にできない）。

## 検討した選択肢

1. 本番の `linkHandler` で `allowNonHttpProtocols: true` にし、`openLink` だけで絞り込む。E2E はそのまま `javascript:` などの OSC 8 のリンクをクリックして確かめる
2. 本番の設定は変えず、E2E でだけ、ページの読み込み前（`page.addInitScript`）に `Object.prototype` に `allowNonHttpProtocols` を足し、xterm.js から `linkHandler.allowNonHttpProtocols` が有効に見えるようにする
3. `openLink` を別のモジュールに切り出して、単体テストで確かめる。E2E は既存のまま
4. テスト用の口（`window` に `openLink` を出すなど）を本番のコードに開ける

## 決定

2 を採る。本番の設定とコードの構造は変えず、`openLink` で `new URL()` で解釈できて、プロトコルが `http:`・`https:` のときだけ開く。

## 理由

- 1 は、xterm.js の絞り込みを外すので、守りが 2 重から 1 重に減り、多層防御の目的に反する。また http・https 以外の OSC 8 のリンク（`file:` など）にも下線と指のカーソルが出るのに、クリックしても開かない見た目になる。マウスの報告モードを使うアプリでは、リンクの上のクリックをアプリに渡さなくなるので（#59）、アプリが自分で開いていた `file:` などのリンクも開かなくなる
- 2 は、この Issue が心配している「設定の変更や xterm.js の更新で、http・https 以外が `openLink` に届く」状態をそのまま作れる。本番のコードに手を入れず、画面からのクリック（OSC 8 のリンクを出すアプリ → xterm.js → `openLink`）の経路全体を通して確かめられる
- 3 は、E2E を仕様とする方針から外れ、単体テストの仕組みを新たに持ち込むことになる
- 4 は、テストのためだけに本番のコードに口を開けることになる

## 影響・今後の課題

- E2E は、xterm.js が `linkHandler` の `allowNonHttpProtocols` を `linkHandler?.allowNonHttpProtocols` のように読むこと（プロトタイプをたどる読み方）に頼っている。xterm.js が読み方を変えて効かなくなると、`javascript:` などはリンクにならず、テストはカーソルが指になるのを待つところで落ちる（黙って通ることはない）
- `Object.prototype` を書き換えるのは、そのテストのページの中だけ（`addInitScript` はそのテストのページにだけ効く）
- http・https 以外のリンク（`file:` など）を開けるようにする場合は、改めて判断する
