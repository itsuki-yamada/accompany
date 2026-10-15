// E2E で、検索する出力を出すコマンドの代わりに起動する。検索する言葉（needle）を、画面から流れた位置・途中・最後に置く
console.log("Needle in the scrollback");
for (let i = 1; i <= 150; i++) console.log(`filler ${i}`);
console.log("a needle in the middle");
for (let i = 151; i <= 300; i++) console.log(`filler ${i}`);
console.log("needle near the end");
console.log("Search output ready");
// 入力した行を表示し、キー入力がコマンドに届いたことを確かめられるようにする
for await (const line of console) console.log(`got: ${line}`);
