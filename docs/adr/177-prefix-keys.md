# tmux のようなプレフィックス（Ctrl+T）のあとのキーで操作する

- 日付: 2026-10-28
- ストーリー: #177

## 背景

利用者から「ショートカットキーをtmux likeにしたい　prefix C tで」と要望があった。利用者は macOS の Chrome で使っている。

いまのショートカット（docs/adr/31-shortcuts.md）は ⌘⇧ / Ctrl+Shift + キーで、tmux を使い慣れた人には覚えにくい。#112（直前の出力のコピー）・#163（ペインの入れ替え・向きの変更）では、⌘⇧L などのキーがぶつかったため、ショートカットを作らずにマウスで操作する形にして、この Issue に回した。

ADR 31 は「プレフィックス方式を採らない」と決めている。決める必要があったのは次のこと。

1. Ctrl+T がページに届くか（macOS / Windows / Linux の Chrome）。Windows / Linux での代わり
2. いまの ⌘⇧ / Ctrl+Shift のショートカットを置き換えるか、残すか
3. キーの割り当てと、キーの判定（`event.key` か `event.code` か）
4. 待ち受け中の表示と解除、タイムアウト
5. シェルの Ctrl+T（readline の transpose-chars、fzf のファイル検索など）の扱い

## Ctrl+T がページに届くか（Chromium のソースで確かめた）

Chromium（main、2026-10-28 時点）のソースで確かめた。

- **Windows / Linux**: `chrome/browser/ui/accelerator_table.cc` の `kAcceleratorMap` は、`#if !BUILDFLAG(IS_MAC)` の中で `{ui::VKEY_T, ui::EF_PLATFORM_ACCELERATOR, IDC_NEW_TAB}` を定める（`EF_PLATFORM_ACCELERATOR` は Windows / Linux では Ctrl）。同じファイルの `kReservedCommandIds` に `IDC_NEW_TAB` があり、`chrome/browser/ui/browser_command_controller.cc` の `IsReservedCommandOrKey` が予約されたコマンドと判定するので、キーはページに届かず、`preventDefault` もできない。押すとブラウザの新しいタブが開く
  - ただし `IsReservedCommandOrKey` は、アプリのウィンドウ（`TYPE_APP` / `TYPE_APP_POPUP`。Chrome の「ページをアプリとしてインストール」や「ショートカットを作成」で「ウィンドウとして開く」にしたもの）では何も予約しない（`// In Apps mode, no keys are reserved.`）。全画面（F11）のときも、全画面をやめるキーのほかは予約しない。このときは Ctrl+T がページに届く
- **macOS**: `chrome/browser/ui/cocoa/accelerators_cocoa.mm` の新しいタブ（`IDC_NEW_TAB`）は `ui::EF_COMMAND_DOWN` + T（Cmd+T）。`chrome/browser/global_keyboard_shortcuts_mac.mm` の `GetShortcutsNotPresentInMainMenu` にも、Control だけを付けた T はない（T を使うのは、開発用の `kUIDebugTools` が有効なときの Ctrl+Shift+Option+T だけ）。macOS で Control を使うのは Ctrl+Tab・Ctrl+PageUp / PageDown など。したがって macOS の Chrome では Ctrl+T はページに届く。E2E（Playwright の Chromium）でも、Ctrl+T のあとのキーで操作できることを確かめた

## 検討した選択肢

### Windows / Linux の扱い

1. プレフィックスは OS を問わず Ctrl+T にし、Windows / Linux では、いまの Ctrl+Shift のショートカットを残して使ってもらう。アプリのウィンドウで開けば Ctrl+T も使える
2. Windows / Linux では別のプレフィックス（例: Ctrl+B、Ctrl+Space）にする
3. プレフィックスを設定で変えられるようにする

### いまの ⌘⇧ / Ctrl+Shift のショートカット

1. プレフィックスに置き換えて、なくす
2. 残し、プレフィックスと両方受け付ける

### キーの判定

1. `event.key`（入力される文字）で判定する
2. ADR 31 と同じく `event.code`（キーの位置）で判定する

### タイムアウト

1. なし（tmux と同じ。Escape や関係ないキーでやめる）
2. 数秒で自動でやめる

## 決定

- プレフィックスは **Ctrl+T**（Shift・Alt・Cmd なし）。OS を判定せずに受け付ける（Windows / Linux の選択肢 1）
- いまの ⌘⇧ / Ctrl+Shift のショートカットは残す（選択肢 2）
- Ctrl+T のあとのキーは `event.key`（入力される文字）で判定する（選択肢 1）。英字は、入力される文字が英数字でない（Latin 以外の配列）ときだけ、キーの位置（`event.code` の `KeyC` など）で判定する。プレフィックスの T も同じ
- タイムアウトは設けない（選択肢 1）

### キーの割り当て（Ctrl+T のあと）

tmux の既定に寄せた。

| 操作 | キー | tmux の既定 | ⌘⇧ / Ctrl+Shift（残す） |
|---|---|---|---|
| 新しいタブ | c | new-window | O |
| 次・前のタブ | n / p | next / previous-window | . / , |
| n 番目のタブ（サイドメニューの並び順） | 1〜9 | select-window | なし |
| タブの名前を変える | , | rename-window | なし |
| 右に分割 | % | split-window -h | R |
| 下に分割 | " | split-window -v | D |
| 隣のターミナルへ移る | ←↑→↓ | select-pane -L/U/R/D | ←↑→↓ |
| 並べている順で次のターミナルへ移る | o | select-pane -t :.+ | なし |
| ターミナルを閉じる | x | kill-pane | X |
| 前・次のターミナルと入れ替える | { / } | swap-pane -U / -D | なし |
| 分割の向きを変える | space | next-layout | なし |
| 直前のコマンドの出力をコピー | y | なし | なし |
| ショートカットの一覧 | ? | list-keys | なし |
| Ctrl+T をターミナルに送る | Ctrl+T | send-prefix | なし |

- n 番目のタブは 1 から数える（タブの名前が「ターミナル 1」から始まるため）。ないタブの番号では何もしない
- { / } は、並べている順（左上から）で前・次のターミナルと位置を入れ替える（端では反対側に回る）。サーバーの `swap-panes`（docs/adr/163-rearrange-panes.md）を使う。キー入力の先は、動いたターミナルに残る
- space は、キー入力の先のターミナルを含む一番内側の分割の向きを変える。右クリックのメニューの「上下に並べる」「左右に並べる」と同じ（`rotate-split`）。tmux の next-layout は決まった配置を順に回すが、Accompany の配置は分割の木なので、一番近い分割の向きを変える
- x は tmux と違い、確かめずに閉じる。ボタンや ⌘⇧X と同じ動き
- 直前の出力のコピーは、tmux に既定のキーがないので、tmux-yank などの「yank」にならって y にする
- サイドメニューの出す・隠す（⌘⇧S）とサイドメニューへ移る（⌘⇧E）は、tmux に当たるものがないので、プレフィックスのキーは足さない
- プレフィックスのあとのキーは、押し続けて繰り返し届いても、ターミナルに文字を送らない（操作は 1 回だけ）

### 待ち受けと解除

- Ctrl+T を押すと、画面の下の中央に「Ctrl+T 次のキーを押してください（? で一覧、Esc でやめる）」を出す（`role="status"`）。次のキーを押すと消える
- Escape、関係ないキー（割り当てのないキーや、Ctrl・Alt・Cmd を付けたキー）を押すとやめる。やめたキーはターミナルに送らない（tmux と同じ）。Shift などの修飾キーを押しただけではやめない（% や " は Shift と一緒に押す）
- ページの外にフォーカスが移ったとき（ウィンドウの blur）と、どこかをクリックしたときもやめる
- 日本語入力の変換中のキーは IME に任せ、待ち受けはやめる

### その他

- 効く範囲は ADR 31 と同じく、ペインの中（ターミナルと検索バー）にキー入力の先があるとき。タブの名前の入力欄では効かない
- ? で一覧を開くと、一覧にキー入力の先を移す（ターミナルは Escape の既定の動作を止めるので、移さないと Escape で閉じられない）。閉じたら、開いたときのターミナルに戻す
- ボタンとメニューのツールチップは、プレフィックスのキーを出す（例: 「右に分割（Ctrl+T → %）」）。プレフィックスのキーがない操作（サイドメニュー）は、これまでどおり ⌘⇧ / Ctrl+Shift のキーを出す
- ショートカットの一覧は、見出しを「操作」「Ctrl+T のあと」「macOS」「Windows / Linux」の列にする（`shortcuts.ts` の `shortcutList` と同じ）。「macOS」には ⌘⇧ のキー、「Windows / Linux」には Ctrl+Shift のキーを出し、その方式のキーがない操作は「—」にする。Windows / Linux の Chrome では Ctrl+T がブラウザのキーであることと、代わりの方法を一覧に書く
- #112・#163 で作ったマウスの操作（右下のコピーのボタン、右クリックのメニュー、バーのドラッグ）はそのまま残す

## 理由

- **ADR 31 を変える（プレフィックス方式を採る）**: ADR 31 がプレフィックス方式を退けた理由は、2 回押す手間、待ち受けの表示と解除の実装、ターミナルの中の tmux との衝突、実装の単純さだった。次のことから、これを変える
  - 利用者が tmux の操作感を望んでいる。tmux を使い慣れた人には、2 回押すことは手間ではなく、指が覚えている操作になる
  - 修飾キーの方式は、ブラウザ・OS・シェルが使うキーを避けると、空いているキーがもう少ない（#112・#163 では ⌘⇧L がぶつかって、ショートカットを作れなかった）。プレフィックスなら、ブラウザから取るキーは Ctrl+T 1 つで、そのあとの 1 文字は自由に割り当てられる。これから操作が増えても割り当てられる
  - ターミナルの中の tmux（既定のプレフィックスは Ctrl+B）とはプレフィックスが違うのでぶつからない。外側の Accompany が Ctrl+T、内側の tmux が Ctrl+B という使い分けになる
  - 待ち受けの表示と解除は、表示 1 つと、Escape・関係ないキー・blur で解除するだけで済んだ
- **Ctrl+T にする**: 利用者の指定。macOS の Chrome ではページに届く（上の「Ctrl+T がページに届くか」）。Cmd+T（新しいタブ）とは別のキーで、ブラウザの操作を奪わない。シェルでは Ctrl+T は transpose-chars（readline・zsh）や fzf のファイル検索に使われるが、2 回押せば送れる（tmux の send-prefix と同じ）
- **⌘⇧ / Ctrl+Shift のショートカットを残す**: Windows / Linux の Chrome では Ctrl+T がページに届かないので、なくすと Windows / Linux の人がキーボードで操作できなくなる。残しても、プレフィックスとはキーがぶつからない。ふだん ⌘⇧ を使っている人の操作も変わらない
- **Windows / Linux で別のプレフィックスにしない（選択肢 2・3 を採らない）**: Ctrl+B は内側の tmux とぶつかる。Ctrl+Space は IME の切り替えに使う人が多い。Ctrl+A は readline の行頭・GNU screen のプレフィックス。ブラウザに取られず、シェルともぶつかりにくい Ctrl キーは見つからなかった。設定で変えられるようにすると、キーの選び方・保存先・一覧の表記が増える。まずは Ctrl+Shift のショートカットとアプリのウィンドウで使ってもらい、要望があれば設定を足す
- **`event.key` で判定する（ADR 31 と変える）**: プレフィックスのあとのキーは、tmux と同じく「入力される文字」で覚えるもの。% や " は配列で位置が違い（US 配列の " は Shift+'、JIS 配列では Shift+2）、`event.code` で判定すると JIS 配列の人には別のキーになる。ADR 31 で `event.code` にした理由の 1 つ（`.` / `,` が Shift で `>` / `<` になる）は、Shift を付けずに押すので当てはまらない。もう 1 つの理由（Latin 以外の配列）には、英字だけキーの位置でも判定して対応する
- **タイムアウトを設けない**: tmux も、プレフィックスのあとは時間を区切らずに待つ。タイムアウトがあると、一覧を見ながら考えている間に切れて、押したキーがターミナルに入ってしまう。待ち受けていることは画面に出ているので、やめたければ Escape を押せばよい

## 影響・今後の課題

- macOS の Chrome では、ペインにキー入力の先があるとき、Ctrl+T（1 回）はシェルに届かなくなる。2 回押せば届く
- 割り当てのないキーで待ち受けをやめたとき、そのキーはターミナルに送らない。押し間違えた文字が入らない代わりに、Ctrl+T のあとに打った文字は捨てられる
- Windows / Linux のふつうの Chrome のタブでは、プレフィックスは使えない（Ctrl+Shift のショートカットか、アプリのウィンドウで使う）。プレフィックスにしかない操作（n 番目のタブ、名前の変更、入れ替え、向きの変更、コピーなど）は、マウスで操作する
- 日本語入力がオンのときは、Ctrl+T のあとのキーが IME に渡るので、効かない（ふつうのターミナルの tmux と同じ）
- Dead キー（US-International 配列の " や ' など、次の文字と組み合わせてアクセント付きの文字を入力するキー）は、`event.key` が `Dead` になり、割り当てのないキーとして待ち受けをやめる（そのキーはターミナルに送らない）。US-International 配列では Ctrl+T のあとの " で下に分割できないので、⌘⇧D / Ctrl+Shift+D か、ボタン・メニューを使う
- プレフィックスやキーの割り当ての変更（設定）は扱わない
