# ストーリー管理ポリシー

Accompany の開発タスクは GitHub Issue と GitHub Project で管理する。

- リポジトリ: `itsuki-yamada/accompany`
- Project: [Accompany](https://github.com/users/itsuki-yamada/projects/6)（ユーザープロジェクト #6）
- Project ID: `PVT_kwHOA98Hi84Bm9BY`
- Status field ID: `PVTSSF_lAHOA98Hi84Bm9BYzhlj2HE`

## ストーリーの書き方

- タイトルは「**ユーザーは画面・機能名で、〜できる**」の形にし、誰がどこで何をできるかが分かるようにする。必要に応じて「開発者」「参加者」「管理者」など具体的な利用者を主語にする
- 例: 「参加者は共有 URL を開いて、エージェントのセッションをリアルタイムに見られる」
- ユーザー価値を届けるストーリーは「〜できる」という完了条件で書く。「開発者として〜したい」のような実装タスク視点の表現は使わない
- 画面に直接対応しない基盤検証などは、機能名や検証対象をタイトルに明示する。無理にプロダクト画面へ見立てない
- 実装・選定タスクは、対象と作業が分かる名称にする。例: 「PTY ライブラリを選定する」。ストーリーのタイトル形式へ無理に合わせない

## ストーリーの粒度と階層

- ストーリーは、対象者が得る便益を起点にする。技術的な作業を先に並べてストーリー風に命名するのではなく、対象者が何を利用・確認できるようになると役立つかを先に定める
- ストーリー出しは outside-in（ユーザー価値）で行う。ユーザー価値が単体で届かない技術層の分割（例: PTY ホストだけ / 表示だけ）は、それぞれを親ストーリーにしない。1 つの親ストーリーの下に GitHub Native の sub-issue として束ねる
- 各ストーリーは、対象者が利用・確認できる成果を届ける単位にする。対象者にはユーザーだけでなく開発者・管理者も含む
- 調査・実装を進める中でストーリーの粒度が大きすぎると分かったら、独立して価値を届け、完了を確認できる単位で適宜分割する。Docker 化など、他の成果を実現する手段だけでは独立ストーリーにしない
- Issue を分けたとき、またはほかの Issue にまとめたときは、元の Issue に、分けた先・まとめた先の Issue へのリンクを付けてコメントし、起案者が行き先を分かるようにする
- **タスク = 実装の内訳**。ストーリー本文のチェックリスト、または sub-issue で扱い、各ストーリーの着手時に JIT（just-in-time）で切り出す。ユーザーがタスク分解を依頼した場合は先に作ってもよいが、全ストーリーを事前分解しない
- 細かな実装作業・確認項目は、原則としてストーリー本文のチェックリストにまとめる。別担当への割り当てや個別の調査・議論が必要など、独立して追う理由がある場合にタスク Issue を作る
- Project のボードには成果単位のストーリーを載せる。実装タスクは載せない
- 技術選定（PTY ライブラリ、配信方式、デプロイ構成など）は独立ストーリーにせず、必要とするストーリーの作業または sub-issue として扱う

## Project の運用ルール

- Issue はタイトルと本文を基本とし、テンプレートは使わない。ただし不具合の報告は、版・入れ方・環境・手順・エラーの出力を集めるため、`.github/ISSUE_TEMPLATE/bug.yml` のテンプレートを使える（使わずに書いてもよい）
- Project で管理するフィールドは Status のみ。Priority / Size など他のフィールドは使わない
- Status option ID:

  | Status | option ID |
  |---|---|
  | Backlog | `01714203` |
  | Ready | `850c73ed` |
  | In progress | `42ec7d63` |
  | In review | `5ae73607` |
  | Done | `a259fb47` |

- ストーリーのプルリクが main にマージされたら、そのストーリーを Done にして Issue を close してよい
- それ以外（プルリクを伴わないストーリー、Not planned で閉じる場合など）で Done にする、または Issue を close する前に人間の確認を取る

## gh コマンドでの操作例

```sh
# Issue を作って Project に追加する
gh issue create --repo itsuki-yamada/accompany --title "<タイトル>" --body "<本文>"
gh project item-add 6 --owner itsuki-yamada --url <Issue の URL>

# Status を変える（item ID は gh project item-list 6 --owner itsuki-yamada --format json で確認）
gh project item-edit --project-id PVT_kwHOA98Hi84Bm9BY --id <item ID> \
  --field-id PVTSSF_lAHOA98Hi84Bm9BYzhlj2HE --single-select-option-id <option ID>
```
