// E2E で、一定間隔で出力し続けるエージェントの代わりに起動する
let count = 0;
setInterval(() => console.log(`tick ${++count}`), 200);
