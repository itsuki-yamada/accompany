# ターミナルの検索バーを開くキー

- 日付: 2026-10-14
- ストーリー: #27

## 背景

ターミナルの出力を検索するバーを、キーボードから開けるようにしたい。macOS では Cmd+F で開くと決めている。一方、Ctrl+F はシェルの「1 文字進む」のキーで、コマンドに届くことを E2E（`control-keys.spec.ts`）で約束しているので奪えない。Windows / Linux には Cmd キーがないため、別の開き方を決める必要がある。

また、E2E は Linux（CI）と macOS（ローカル）の両方で流す。Playwright の `ControlOrMeta+F` は Linux では Ctrl+F になり、シェルのキーと区別できない。

## 検討した選択肢

1. OS を判定し、macOS では Cmd+F、それ以外では Ctrl+Shift+F だけで開く
2. OS を問わず、Cmd+F（Meta+F）と Ctrl+Shift+F の両方で開く。ターミナルのバーにも検索ボタンを置く
3. キーは Cmd+F だけにし、Windows / Linux ではボタンから開く

## 決定

選択肢 2 にする。

- Cmd+F（Meta+F）と Ctrl+Shift+F のどちらでも、OS を問わず検索バーを開く
- ターミナルのバーに検索ボタン（⌕）を置く
- Ctrl+F（Shift なし）は奪わず、これまでどおりコマンドに届く
- キーは、ペインの要素の `keydown` を capture で受けて拾い、`preventDefault` でブラウザのページ内検索も止める。xterm の `attachCustomKeyEventHandler` は 1 つしか登録できず、ほかのキー（#30 の Shift+Enter など）と取り合いになるので使わない

## 理由

- OS を判定しないので実装が単純で、E2E も Linux と macOS で同じキー（`Meta+F` と `Control+Shift+F`）をそのまま押して確かめられる
- Ctrl+Shift+F は VS Code のターミナルや Windows Terminal などでも検索に使われ、Windows / Linux の利用者になじみがある。シェルで Ctrl+Shift+F に意味を持たせることはまれ
- Windows / Linux で Meta（Windows キー / Super）+F は OS に取られることが多いが、届いた場合に開いても困ることはない
- ボタンがあれば、キーを知らない参加者も検索に気づける

## 影響・今後の課題

- macOS でも Ctrl+Shift+F は検索バーを開くので、シェルには届かない。これが困る場面が出てきたら、OS ごとの割り当てを見直す
- キーボードショートカットの設定（割り当ての変更）は扱わない
