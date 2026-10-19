// 古い Bun で起動したら、ほかのモジュールを動かす前に、何が足りないかを表示して終了する（docs/adr/78-binaries.md）。
// Bun 1.3 では、tarball から bunx で起動すると画面の JS と CSS の URL が壊れて 404 になり、エラーも出ずに画面が空になる。
// PTY を作る Bun.spawn の terminal も、1.3.5 より前にはない
const required = "1.4.0";

if (!Bun.semver.satisfies(Bun.version, `>=${required}`)) {
  console.error(
    `Accompany: Bun ${required} 以上が必要です（いまの Bun: ${Bun.version}）。\n` +
      "`bun upgrade` で Bun を上げるか、Bun の要らない実行ファイルを使ってください: " +
      "https://github.com/itsuki-yamada/accompany/releases",
  );
  process.exit(1);
}
