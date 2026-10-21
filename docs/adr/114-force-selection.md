# マウスの報告モードを使うアプリの上でも、修飾キーを押しながらドラッグして選択する

- 日付: 2026-10-22
- ストーリー: #114

## 背景

ターミナルで Codex（OpenAI の Codex CLI）を起動すると、範囲を選択してコピーできない、と報告があった。

### 原因の確認

Codex CLI 0.163.0（npm の `@openai/codex`、2026-10-22 時点の最新）を、手元の疑似端末（120 列 x 40 行、`TERM=xterm-256color`）で起動し、出力を記録して確かめた。

- 起動すると、代替画面（`?1049h`）に入ったうえで、マウスの報告モード `?1000h`（押下・離す）、`?1002h`（ドラッグ）、`?1003h`（すべての動き）と、SGR 形式の `?1006h` を有効にする。そのまま入力欄（「Ask Codex to do anything」）を出す
- ソース（openai/codex の `codex-rs/tui/src/tui/alternate_screen.rs`、タグ `rust-v0.163.0`）でも、代替画面に入るとき（`AlternateScreen::configure_input`）に `\x1b[?1000h\x1b[?1002h\x1b[?1003h` と `\x1b[?1006h` を書いている
- ログインの画面（「Welcome to Codex」）を出している間は、マウスの報告モードを無効にする（`?1000l` など）

マウスの報告モードが有効な間、xterm.js はドラッグをアプリに報告し、ブラウザの中では選択しない。そのため Codex の上では範囲を選べない。xterm.js には、修飾キーを押しながらのドラッグなら報告せずに選択する仕組み（`shouldForceSelection`）があるが、macOS では `macOptionClickForcesSelection` を有効にしないと働かない。Accompany はこれを既定（無効）のままにしていたので、macOS ではマウスの報告モードを使うアプリの上で選択する方法がなかった（docs/adr/94-remote-selection.md の今後の課題）。Windows・Linux では、既定のまま Shift を押しながらドラッグすると選択できる。

## 検討した選択肢

1. `macOptionClickForcesSelection: true` にして、macOS では Option を押しながらのドラッグで選択する
2. 既定のままにして、Codex 側で報告モードを使わない設定にしてもらう
3. マウスの報告モードを Accompany 側で無視する（アプリにマウスを渡さない）

## 決定

1 を採る。

- `Terminal` の `macOptionClickForcesSelection` を `true` にする。Windows・Linux の Shift は xterm.js の既定のまま
- ショートカットの一覧の表に「範囲を強制して選択」の行（macOS: Option+ドラッグ、Windows / Linux: Shift+ドラッグ）を足し、画面から分かるようにする

## 理由

- 1 は xterm.js の設定 1 つで済み、Codex 以外のマウスの報告モードを使うアプリ（Claude Code の全画面の表示、vim など）でも同じ操作で選べる。選んだ範囲は、ふだんの選択と同じく、ほかの参加者にも見える（docs/adr/94-remote-selection.md）
- 2 は利用者に設定を求めることになり、ほかのアプリには効かない
- 3 では、Claude Code の全画面の表示のように、マウスで操作するアプリが使えなくなる

### トレードオフ: macOS の Option+ドラッグの矩形選択

xterm.js は、Option（Alt）を押しながらドラッグすると矩形（列）で選択する（`shouldColumnSelect`）。ただし、macOS で `macOptionClickForcesSelection` が有効なときは、Option+ドラッグを選択の強制に使うため、矩形選択にしない。そのため、macOS では矩形選択ができなくなる（Windows・Linux の Alt+ドラッグの矩形選択は残る）。

それでも有効にするのは、次の理由による。

- マウスの報告モードを使うアプリの上で範囲を選べないことは、コピーそのものができないので影響が大きい。矩形選択は、ふだんの行単位の選択で代わりがきく
- macOS で選択を強制できる修飾キーは、xterm.js では Option だけ（Shift は使えない）。矩形選択と両立させる設定はない

## 影響・今後の課題

- macOS で Option+ドラッグの矩形選択を使っていた人は、使えなくなる。困る例が出たら、設定で切り替えられるようにすることを検討する
- 修飾キーを押しながらのドラッグは、アプリには届かない。アプリが自分で描く選択（Claude Code の全画面の表示）を使いたいときは、修飾キーなしでドラッグする

## 含めないもの

- 矩形選択を別の操作に割り当てること
- 修飾キーの設定画面
