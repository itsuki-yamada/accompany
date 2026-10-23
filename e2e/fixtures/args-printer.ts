// E2E で、起動したときに受け取った引数を表示し、そのまま待つコマンド
console.log(`Args: ${process.argv.slice(2).join(" ")}`);
setInterval(() => {}, 60_000);
