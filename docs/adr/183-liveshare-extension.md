# Live Share を始めると VS Code の中で Accompany を使える拡張（試作）

- 日付: 2026-10-28
- ストーリー: #183

## 背景

利用者から「liveshareのプラグインとして提供することはできないだろうか？」と要望があった。いまは、ホストが Accompany を起動し、Live Share の共有サーバーにポートを手で足し、ゲストがブラウザで開いている。

Live Share は、ほかの拡張から使える API（npm の `vsls`）を出している。これを使い、Live Share を始めるだけで Accompany を起動・共有し、VS Code のパネル（webview）で開けるかを試作で確かめる。決める必要があったのは次のこと。

1. 拡張の置き場所
2. ホストとゲストの動き（起動・共有・ポートの受け渡し・止め方）
3. `vsls` の取り込み方（セキュリティ）
4. Accompany の本体（実行ファイル）を同梱するか
5. 参加者の名前の既定の渡し方
6. webview の中でキーとクリップボードが届くか
7. 確かめ方（自動と手）

## 決定

### 1. 置き場所: `app/vscode`

Accompany の本体（`app/server`）と並べて `app/vscode` に置く。`npm/` は本体の配布のための包みで、拡張はそれ自体が動くアプリなので `app/` に置いた。依存と `bun.lock` は本体と分ける（本体の tarball に拡張の依存を入れないため）。

### 2. ホストとゲストの動き

- 拡張は起動の最後（`onStartupFinished`）に動き出し、`vsls` の `getApi` で Live Share の API を得る。Live Share が入っていなければ何もしない（コマンド「Accompany: パネルで開く」は、セッション中でなければその旨を出す）
- **ホスト**（`session.role === Host`）: 設定 `accompany.path`（既定 `accompany`）の実行ファイルを `--port 0`（空いているポート）で、開いたフォルダーを作業ディレクトリにして起動する。表示された URL からポートを読み、`shareServer({ port, displayName: "Accompany" })` で共有する。さらに `shareService("accompany")` で、ゲストの拡張に `info` の要求で `{ port }` を返す。パネルで `http://127.0.0.1:<port>/` を開く
- **ゲスト**（`session.role === Guest`）: `getSharedService("accompany")` で `info` を要求してポートを受け取り、パネルで `http://localhost:<port>/` を開く。ホストが共有する前に参加したときは、使えるようになってから開く。受け取ったポートは 1〜65535 の整数かを確かめる
- **終わったとき**（セッションがなくなったとき、VS Code を閉じるとき）: パネルを閉じ、共有サービスと共有サーバーをやめ、Accompany に SIGTERM を送る（Accompany は画面を保存してから止まる。5 秒で止まらなければ SIGKILL）
- パネルは `retainContextWhenHidden` にする。隠したときに作り直すと、Accompany のページを開き直してしまうため。拡張のファイルは読ませない（`localResourceRoots: []`）
- 起動・共有を待っている間にセッションが終わったときは、得たもの（Accompany のプロセス・共有）をその場で手放す

### 3. `vsls` の取り込み方

- `vsls` は 1.0.4753 に固定する（2022 年 5 月から新しい版が出ていない）。中身は Live Share の拡張（`ms-vsliveshare.vsliveshare`）が出す API を呼ぶ薄い層で、`vscode.js` が実行時に読み込むのは `vscode` と自身の `package.json` だけ。依存の `@microsoft/servicehub-framework` は型（`IServiceBroker`）にしか使われていない
- 拡張は `getApi` と型だけを使う。`Role` は enum の値なので、`vsls` から読み込まず、同じ値を拡張の中に持つ
- `bun build` で 1 つのファイル（`dist/extension.js`）にまとめ、`vscode` だけを外に出す。ビルドのあとに `scripts/check-bundle.ts` で、同梱したモジュールの一覧が `vsls/vscode.js` と `vsls/package.json` の 2 つとちょうど一致し（一覧が空のときも失敗にする）、実行時に読み込むのが `vscode` と Node.js の組み込みだけであることを確かめる（`@microsoft/servicehub-framework`・`nerdbank-streams`・`vscode-jsonrpc`・`msgpack` が入っていたら失敗する）
- vsix には `dist/extension.js`・`package.json`・`LICENSE` だけを入れ（`.vscodeignore`）、`vsce package --no-dependencies` で node_modules を入れない。できた vsix は 5 ファイル・約 8KB
- `@vscode/vsce` は依存に入れず、`bunx @vscode/vsce@4.0.0` で版を固定して使う。依存に入れると、発行のための `@azure/identity` などが入り、`bun audit` が使わない部分（`@azure/msal-node` の認可コードフロー）の脆弱性を報告するため。拡張の依存（`vsls` と `@types/vscode`）は `bun audit` で 0 件（2026-10-28）

### 4. Accompany の本体は同梱しない

入っている `accompany`（Homebrew・npm・実行ファイル）を使う。設定 `accompany.path` で実行ファイルを指定できる。

- 理由: 実行ファイルは OS と CPU ごとに約 60〜100MB あり、拡張を OS ごとに分けて出す必要がある。本体の版と拡張の版を別々に上げられる
- 設定 `accompany.path` は `scope: machine` にし、ワークスペースの設定では変えられないようにする。開いたフォルダー（Live Share のホストが開いたリポジトリなど）の `.vscode/settings.json` で、任意のコマンドを起動させないため
- **使える Accompany は 0.23.1 以上**。Accompany は既定でほかのページへの埋め込みを拒む（`frame-ancestors 'self'`。docs/adr/185-frame-ancestors.md）ので、拡張は `--allow-vscode-webview` を付けて起動し、webview（`vscode-webview:`）と workbench（`vscode-file:`）からの埋め込みを許す。0.23.0 までの Accompany は、この引数を知らないオプションとして起動に失敗する。拡張は、エラー出力に知らないオプションと出たら「Accompany を 0.23.1 以上に上げてください」と知らせる

### 5. 参加者の名前の既定: URL の `name`

拡張は、Live Share の表示名（`session.user.displayName`）を URL の `name` に付けて開く（`http://127.0.0.1:<port>/?name=やまだ`）。Accompany は、このブラウザに名前を保存していないときに、これを名前として使う（保存はしない。入力欄で確定したときに保存する）。サーバーはこれまでどおり名前を整えてから配る（docs/adr/96-member-name.md）。

- 理由: webview の中の iframe は、webview ごとに違う親（`vscode-webview://<id>`）の下で開くため、ブラウザの保存（localStorage）が開くたびに分かれることがある。名前を毎回入れ直さずに済むよう、Live Share の表示名を既定にする
- Live Share が利用者の情報を拡張に見せないとき（`user` が `null`）は、これまでどおり「参加者 N」になる

### 6. webview の中のキーとクリップボード

VS Code 1.143.1（macOS arm64 と CI の Linux）で、E2E で確かめた。

- **キー**: パネルの中の Accompany（iframe）にフォーカスがあると、キーは VS Code のキー割り当てより先に Accompany に届く。Ctrl+P（クイックオープン）・Ctrl+W・Ctrl+F・Ctrl+B・Ctrl+J・Ctrl+R、プレフィックスの Ctrl+T（VS Code ではシンボルへ移動）、⌘⇧O / Ctrl+Shift+O（VS Code ではシンボルへ移動）が Accompany に届き、VS Code のクイック入力は開かなかった
  - 逆に、パネルにフォーカスがある間は、F1・⌘⇧P などの VS Code のキー割り当ても効かない（Accompany に届く）。VS Code を操作するときは、エディタなどをクリックしてフォーカスを移す。webview の中の iframe はほかのオリジンなので、VS Code（webview）はキーを見られず、Accompany からキーを VS Code に返すこともしない
  - E2E は Chrome DevTools Protocol でキーを送るので、macOS のメニューのショートカット（⌘Q・⌘W・⌘N など、ネイティブのメニューが先に受け取るもの）は確かめられていない。手で確かめる
- **クリップボード**: VS Code（Electron）は、`localhost` のページにクリップボードの許可を与えない（`navigator.clipboard.writeText` / `readText` が `NotAllowedError`。iframe の `allow` に `clipboard-read; clipboard-write` を付けても同じ）。webview（`vscode-webview:`）自身は書き込める
  - iframe の `allow` にはクリップボードの権限を付けない。書き込みは webview を経由するので要らない。読み取りの権限を渡しておくと、VS Code（Electron）の扱いが変わったときに、ホストが配るページからゲストのクリップボードを読める道になるため
  - コピー（選択のコピー・直前の出力のコピー #112）: Accompany は、書き込めなかったときに、親が VS Code の webview（`location.ancestorOrigins` が `vscode-webview://` で始まる）なら、その親だけに `postMessage` で文字を渡す。webview は、開いた iframe（オリジンも一致するもの）からのもので、利用者の操作の直後（`navigator.userActivation.isActive`。iframe の中のクリックなどは親にも伝わる）の、長すぎない（1000 万文字まで）ものだけを拡張に渡し、拡張が `vscode.env.clipboard.writeText` で書き込む。ゲストのパネルに出るのはホストが配るページなので、利用者の操作なしにゲストのクリップボードを書き換えさせないため。ほかのページに iframe で埋め込まれたときには、コピーした文字を渡さない
  - ペースト: キーボードのペースト（macOS は ⌘V、Linux は Ctrl+Shift+V）は許可が要らないので届く。Linux の Ctrl+V は、ブラウザで開いたときと同じく、ターミナル（xterm.js）が ^V としてコマンドに送る。メニューの「ペースト」は読み取りの許可がないので使えず、これまでどおりキーボードでペーストするよう案内が出る。webview 経由でクリップボードを読む手段は作らない。ゲストのパネルに出るのはホストの Accompany が配るページなので、読む手段を渡すと、ホストの側から、ゲストのクリップボードを黙って読めてしまうため

### 7. 確かめ方

- **自動（`e2e/vscode`、CI の `e2e (vscode)`）**: `@vscode/test-electron` で VS Code を取得し（版は 1.143.1 に固定する。`stable` にすると、VS Code の新しい版が出ただけで CI の結果が変わるため。`VSCODE_VERSION` で上書きできる）、`--remote-debugging-port` で起動して Playwright から Chrome DevTools Protocol でつなぐ。本物の Live Share はサインインが要るので、同じ ID（`ms-vsliveshare.vsliveshare`）の偽物の拡張（`e2e/fixtures/vscode/fake-liveshare`）を入れ、コマンドでホスト・ゲストのセッションを始め・終える。偽物は、拡張が呼んだ API（`shareServer` など）をファイルに書き、テストが読む
  - ホスト: Accompany を起動して `shareServer` で共有し、パネルで開く。名前の既定が Live Share の表示名。共有サービスの `info` がポートを返す。終えると共有をやめ、Accompany が止まる（ポートが閉じる）、パネルが閉じる
  - ゲスト: 共有サービスから受け取ったポートの Accompany を、Live Share の表示名でパネルで開く
  - キー・クリップボード（6 のとおり）。利用者の操作なしの書き込みを受け付けないこと
  - ワークスペースの設定（`.vscode/settings.json`）で `accompany.path` を変えても使わないこと
  - ブラウザの E2E（`e2e/tests/context-menu.spec.ts`）: ほかのオリジンのページに埋め込まれたときは、コピーした文字を親に渡さないこと。埋め込みはふだん `frame-ancestors` で拒むので、それが効かなかったときの守りとして、テストでは Accompany のページの CSP を取り除いて埋め込む
  - 古い Accompany（`--allow-vscode-webview` を知らないもの）で起動に失敗したときに、上げる版を案内すること
  - ビルドの中で、同梱したモジュールを確かめ、vsix を作る。CI は vsix を成果物（`accompany-vscode-vsix`）として上げる
- CI の `e2e (vscode)` はプルリクのときだけ流す。`e2e.yml` は release.yml からも呼ばれ、Release と npm の公開はその E2E を待つ。配布物に入らない試作の拡張のために、Release を止めないため
- `@vscode/test-electron` のテストランナー（拡張のホストの中で動くテスト）は、webview の中にキーを送れないので使わず、VS Code の取得にだけ使う
- VS Code の E2E はブラウザの E2E（`playwright.config.ts`）とは分け、`bun run test:vscode`（拡張をビルドしてから流す）で流す。VS Code はシステムのクリップボードを使うので、手元で流すとクリップボードが書き換わる
- **手（PR に手順を書く）**: 本物の Live Share でのサインイン・共有・ゲストへの転送

## 理由

- ホストとゲストの両方で同じ拡張を入れれば、Live Share を始める・参加するだけで済み、ポートを手で足す手順がなくなる。拡張を入れていないゲストは、これまでどおり Live Share の共有サーバーの一覧からブラウザで開ける
- ゲストがポートを知る手段として、`shareServer` の情報は API で取れないため、共有サービスを使う。共有サービスは Live Share 側で使える拡張が制限されることがある（`null` を返す）ので、そのときはゲストはパネルで開けず、共有サーバーの一覧から開いてもらう（出力に理由を書く）

## セキュリティ

### Accompany の待ち受け先

- Accompany は、もとから `127.0.0.1` だけで待ち受けている（`app/server/src/cli.ts`、`e2e/tests/security.spec.ts`）。拡張から起動するときも引数を足さずに済む
- 拡張は、Accompany が表示した URL のホストが `127.0.0.1`（か `[::1]`）でなければ共有せずに止める。将来、待ち受け先を変える引数ができても、ホストの外に開いたまま共有しないため
- 共有サーバーには Live Share のセッションの参加者しか届かない

### ゲストが開く先（試作では対策していないリスク）

ゲストの拡張は、ホストの共有サービスの `info` が返したポートを、そのままゲスト自身の `http://localhost:<port>/` として開く。ホストの答えを確かめる手段がないので、次のことが起きる。

- **転送先が違うとき**: ゲストの側でそのポートがすでに使われていると、Live Share はホストの共有サーバーを別のポートに転送する。このときパネルに開くのは Accompany ではなく、**ゲスト自身の localhost で動いている別のサービス**になる
- **悪意のあるホスト**: ホストは `info` で任意のポートを返せる。ゲストの拡張に、ゲストの localhost の任意のサービス（開発中のアプリ、管理画面など）へ `?name=<表示名>` を付けた GET を送らせ、パネルに表示させられる。そのページも、利用者がパネルの中を操作した直後なら、webview を経由してクリップボードに書き込める（親が `vscode-webview:` かを確かめて `postMessage` を送るだけでよいため）
- 書き込みは利用者の操作の直後に限り、読み取りの手段は渡さないので、黙ってクリップボードを書き換えたり読んだりはできない

本実装に進むときの対策（今後の課題）:

- ホストの拡張が、セッションごとに乱数のトークンを作り、共有サービスで渡す。Accompany はトークンを知っていることを確かめる手段（例: トークンを付けた URL でだけ応える確かめ用の API）を持ち、ゲストの拡張は開く前にその手段で、接続先がホストの Accompany かを確かめる
- 確かめられないときは、パネルで開かずに、共有サーバーの一覧からブラウザで開くよう案内する
- webview が受け付けるクリップボードの書き込みも、確かめた接続先からのものに限る

## 影響・今後の課題

- 試作の結果、キーとコピー・ペースト（キーボード）はパネルの中で使える。続けるなら、本物の Live Share で下の「手で確かめること」を確かめてから、配布を決める
- **手で確かめること**（自動では確かめられない）
  - 本物の Live Share で、`shareServer` と `shareService` が使えるか（共有サービスは、Live Share が許可した拡張にしか使えないことがある）
  - ゲストの `localhost:<ホストのポート>` に転送されるか。ゲストでそのポートが使われていると、Live Share は別のポートに転送することがあり、そのときはゲスト自身の localhost の別のサービスが開く（上の「ゲストが開く先」）
  - macOS のメニューのショートカット（⌘W・⌘Q など）がパネルの中でどうなるか
  - 端末の大きさ（#99）: パネルは画面の半分ほどなので、一番小さい参加者がパネルになることが多い。既定の下限（480×1080）より低いパネルでは、端末がパネルより大きくなり、スクロールする
  - Live Share の表示名が名前の既定になるか
- 配布（Marketplace・Open VSX）は、持ち主が発行者のアカウントを用意してから決める。`package.json` の `publisher`（いまは `itsuki-yamada`）は仮の値
- `@types/vscode` は `engines.vscode`（^1.100.0）と同じ版に固定している。Renovate が `@types/vscode` だけを上げると `vsce package` が失敗するので、続けるなら Renovate で `engines` と揃えるか、上げないようにする
- `--allow-vscode-webview` を付けて起動した Accompany は、ホストの VS Code の、ほかの拡張の webview（セキュリティを無効にした Markdown のプレビューなど）にも埋め込める。`frame-ancestors` では、どの拡張の webview かを区別できないため。VS Code for the Web では webview のオリジンが違うので、パネルで開けない（docs/adr/185-frame-ancestors.md）
- ホストのワークスペースがリモート（SSH・コンテナ）のときは試していない。拡張はワークスペースの側の拡張ホストで動くので、Accompany もそちらで起動する
