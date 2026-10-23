# accompany

AI コーディングエージェントのターミナルをブラウザで共有する Web UI サーバー。Bun を入れずに起動できる。

```sh
npx accompany              # 最初のターミナルで $SHELL を動かす
npx accompany -- claude    # 最初のターミナルで動かすコマンドを指定する
npx accompany --port 4000  # 待ち受けるポートを変える
npx accompany --help       # 使い方を表示する
```

macOS（Apple Silicon・Intel）と Linux（x64・arm64、glibc）に対応する。使い方の詳細は [GitHub](https://github.com/itsuki-yamada/accompany) を参照。
