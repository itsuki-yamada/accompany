# Shift+Enter で ESC + CR を送る

- 日付: 2026-10-14
- ストーリー: #30

## 背景

Claude Code の入力欄では、Enter で送信し、改行には別のキーを使う。普段のターミナルでは `/terminal-setup` を実行すると、VS Code などのターミナルに「Shift+Enter で ESC + CR（`\x1b\r`）を送る」設定が入り、Shift+Enter で改行できるようになる。xterm.js は Shift+Enter でも Enter と同じ CR を送るので、Accompany ではそのままでは改行できない。

## 検討した選択肢

1. Shift+Enter で常に ESC + CR を送る（`/terminal-setup` と同じ）
2. kitty keyboard protocol に対応し、アプリが要求したときだけ修飾キー付きの Enter を区別して送る
3. Shift+Enter に送るものを利用者が設定できるようにする

## 決定

1 を採る。Shift+Enter（Ctrl / Alt / Cmd を押していないとき）で ESC + CR を送る。

## 理由

- Claude Code の公式の設定と同じ挙動なので、利用者の期待と一致し、追加の設定もいらない
- 2 は xterm.js での対応が必要で、実装と確認の手間が大きい。対応するアプリもまだ限られる
- 3 は今のところ必要とする利用者がいない

## 影響・今後の課題

- Claude Code 以外のコマンドにも Shift+Enter で ESC + CR が届く。bash や zsh では Meta+Enter として扱われ、多くの場合は Enter と同じか無視される。困る例が出たら 2 か 3 を検討する
