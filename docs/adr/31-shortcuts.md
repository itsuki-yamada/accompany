# ターミナルの分割・移動・タブ操作のキーボードショートカット

- 日付: 2026-10-15
- ストーリー: #31

## 背景

ターミナルの分割・閉じる・隣のターミナルへのフォーカス移動・新しいタブ・次／前のタブを、キーボードだけで操作できるようにしたい。割り当てには次の制約がある。

- シェルやエージェントの Ctrl キー（`control-keys.spec.ts` の Ctrl+F / P / W / A / H / J など）、Claude Code の Shift+Enter（`agent-keys.spec.ts`）、検索の Cmd+F / Ctrl+Shift+F（`search.spec.ts`、docs/adr/27-search-keys.md）とぶつからないこと
- Accompany はブラウザで動くので、ブラウザが予約していてページに届かないキー（macOS の Cmd+T / W / N / Q、Cmd+Shift+T / W / N、Windows / Linux の Ctrl+T / W / N、Ctrl+Shift+T / W / N、Ctrl+Tab など）は使えない
- 参考にした Orca（Electron アプリなので予約キーの制約がない）は、Cmd+\（右に分割）、Cmd+Shift+\（下に分割）、Cmd+Shift+] / [（タブ移動）を使う
- E2E は Linux（CI）と macOS（ローカル）の両方で流す。Playwright の `ControlOrMeta` は Linux では Ctrl になり、シェルの Ctrl キーと区別できない

## 検討した選択肢

1. OS ごとに割り当てを変える（macOS は Cmd+キー、Windows / Linux は Ctrl+Shift+キー）。Orca にならい、分割は `\`、タブは `]` / `[` を使う
2. tmux のようなプレフィックスキー方式（例: Ctrl+Shift+A を押してから、`|` で右に分割、`-` で下に分割、矢印で移動）
3. OS を問わず、「Cmd+Shift+キー」と「Ctrl+Shift+キー」の両方を受け付ける。キーは文字・矢印・`]` / `[` だけを使う

## 決定

選択肢 3 にする。修飾キーは **Cmd+Shift（macOS 向け）または Ctrl+Shift（Windows / Linux 向け）** で、Alt は付けない。どちらも OS を判定せずに受け付ける。

| 操作 | macOS | Windows / Linux |
|---|---|---|
| 右に分割 | ⌘⇧R | Ctrl+Shift+R |
| 下に分割 | ⌘⇧D | Ctrl+Shift+D |
| ターミナルを閉じる | ⌘⇧X | Ctrl+Shift+X |
| 隣のターミナルへフォーカスを移す | ⌘⇧←↑→↓ | Ctrl+Shift+←↑→↓ |
| 新しいタブ | ⌘⇧O | Ctrl+Shift+O |
| 次のタブ／前のタブ | ⌘⇧] / ⌘⇧[ | Ctrl+Shift+] / Ctrl+Shift+[ |

- R は Right（右）、D は Down（下）、X は閉じる（×）、O は Open（開く）と覚える
- 次／前のタブは端で反対側に回る
- キーは、ペインの要素の `keydown` を capture で受けて拾い、`preventDefault` と `stopPropagation` で xterm とブラウザに渡さない（検索 #27 と同じ方式）。xterm の `attachCustomKeyEventHandler`（#37 の Shift+Enter が使用中）は使わない。ペインの中（ターミナルと検索バー）にキー入力の先があるときだけ効く
- 文字は `event.key` を小文字にして比べる。`]` / `[` は、Shift で `}` / `{` になる配列（US・JIS とも）があるので、両方を受け付ける
- 一覧は、ターミナルのバーとタブバーのボタンのツールチップにキーを併記し、タブバーの「⌨」ボタンで全部の一覧を開けるようにする
- ショートカットでキー入力の先のターミナルを閉じたときは、閉じたターミナルに一番近いターミナルにキー入力の先を移す（キーボードだけで操作を続けられるように）

## 理由

- **Shift を必ず付ける**: シェルの Ctrl キーは Shift なしで押すので、Ctrl+Shift+キーを取ってもぶつからない（Ctrl+D の EOF、Ctrl+R の履歴検索、Ctrl+O などはこれまでどおり届く）。macOS も Cmd 単独ではなく Cmd+Shift にしたのは、Cmd+R（再読み込み）・Cmd+D・Cmd+[（戻る）など Cmd 単独のブラウザのキーを奪わないためと、Windows / Linux と表が揃って覚えやすいため
- **選択肢 1 の `\` を使わない**: Ctrl+Shift 系では Shift が修飾キーに含まれるので「`\` と Shift+`\`」で右と下を分けられない。また JIS 配列では `\` の位置と入力される文字が US 配列と大きく違い（¥ キー・ろキー）、Ctrl+Shift+- は readline の取り消し（Ctrl+_）と同じキーになる。文字と矢印なら配列に左右されない
- **OS を判定しない**: 検索（docs/adr/27-search-keys.md）と同じ考え方。実装が単純で、E2E も Linux と macOS で同じキー（`Meta+Shift+…` と `Control+Shift+…`）をそのまま押して確かめられる。macOS でも Cmd+Shift 系がブラウザに取られた場合に Ctrl+Shift 系で代わりに操作できる
- **プレフィックスキー方式（選択肢 2）を採らない**: プレフィックスのキー 1 つを取るだけでよい利点はあるが、1 回の操作に 2 回押す必要があり、待ち受け中の状態の表示や解除（タイムアウト・Escape）が必要になる。ターミナルの中で tmux を使う人とは操作感が衝突しやすい。シンプルな実装を優先する
- 避けたキー: T / W / N / Q（ブラウザの予約）、F（検索）、Tab（Ctrl+Tab はブラウザの予約）。I / J / C は Ctrl+Shift で開発者ツールになるので避けた

## 影響・今後の課題

- Ctrl+Shift+R / Cmd+Shift+R（強制再読み込み）、Ctrl+Shift+O / Cmd+Shift+O（ブックマーク マネージャ）、Ctrl+Shift+D / Cmd+Shift+D（全タブをブックマーク）は、ペインにキー入力の先があるときは Accompany が使う。ペインの外（タブバーなど）にキー入力の先があるときはブラウザの動作のまま
- macOS の Chrome は Cmd+Shift+] / [ をタブの切り替えとして予約しているおそれがある（E2E はページに直接キーを送るので確かめられない）。届かない場合は Ctrl+Shift+] / [ で切り替えられる
- ターミナルの中のプログラムには Ctrl+Shift+矢印（`ESC [1;6C` など）や、Shift 付きの Ctrl+R / D / X / O が届かなくなる。Shift なしの Ctrl キーで同じ文字が送られるので、困ることはまれとみている
- キーの割り当ての変更（設定）は扱わない
