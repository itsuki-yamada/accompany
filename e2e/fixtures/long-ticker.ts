// E2E で、画面に収まらない量を出力したあと、一定間隔で出力し続けるコマンドの代わりに起動する
for (let i = 1; i <= 200; i++) console.log(`line ${i}`);
let count = 0;
setInterval(() => console.log(`tick ${++count}`), 200);
