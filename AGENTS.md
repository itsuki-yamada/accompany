# AGENTS.md

コーディングエージェント向けの指示。エージェント固有の設定ファイル（`CLAUDE.md` など）はこのファイルを参照するだけにし、指示はここに集約する。

## 参照する文書

- 開発プロセス: [docs/development-process.md](docs/development-process.md)
- ストーリー管理: [docs/story-management.md](docs/story-management.md)

## 言語

- 応答、コミットメッセージ、文書は日本語を基本とする。

## Story・Issue の完了操作

- ストーリーのプルリクが main にマージされたら、そのストーリーを Done にして Issue を close してよい。
- それ以外（プルリクを伴わないストーリー、Not planned で閉じる場合など）で Done にする、または Issue を close する前に、人間の確認を取る。

## ルールの変更

- エージェントは独自判断で開発ルール（このファイルと `docs/` 配下の文書）を変更しない。改善が必要と考えた場合は変更案を提示する。
