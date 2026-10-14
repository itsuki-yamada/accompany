// E2E で Claude Code の代わりに起動する、入力に応答するだけのエージェント
console.log("Fake Agent ready");
for await (const line of console) {
  console.log(`Agent received: ${line}`);
}
