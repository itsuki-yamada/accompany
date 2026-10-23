import { parseArgs } from "node:util";
import { version } from "../package.json";
import { isShell, shellIntegrationScript, shells } from "./shell-integration";

export const usage = `使い方: accompany [オプション] [-- <コマンド...>]

ブラウザで開くターミナルを、ペアプログラミングの相手と共有する。
-- のあとに書いたコマンドを最初のターミナルで動かす（省略すると $SHELL）

オプション:
  --port <ポート>          待ち受けるポート（既定: 3000。使われていたら、空いているポートまで上げる。10 個まで）
  --fresh                  前回の画面の配置とスクロールバックを戻さずに、新しく始める
  --min-window <幅>x<高さ>  端末の大きさの下限を、ウィンドウの大きさ（ピクセル）で指定する（例: 480x1080。保存はしない）
  --shell-integration <シェル>
                           シェルの統合のスクリプト（zsh・bash・fish）を表示する。直前のコマンドの出力をコピーするのに使う
                           （例: ~/.zshrc に eval "$(accompany --shell-integration zsh)" と書く）
  -v, --version            版を表示する
  -h, --help               この使い方を表示する`;

// 起動の引数を読む。版や使い方を求められたら表示して終了コード 0 で、誤った引数なら、例外のスタックではなく
// 何が誤っているかと使い方を表示して、終了コード 1 で終わる（docs/adr/147-cli-options.md）
export function parseCliArgs(args = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        port: { type: "string", default: "3000" },
        fresh: { type: "boolean", default: false },
        "min-window": { type: "string" },
        "shell-integration": { type: "string" },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (error) {
    console.error(`Accompany: ${describe(error)}\n\n${usage}`);
    process.exit(1);
  }
  if (parsed.values.help) {
    console.log(usage);
    process.exit(0);
  }
  if (parsed.values.version) {
    console.log(`accompany ${version}`);
    process.exit(0);
  }
  // 直前のコマンドの出力をコピーするための、シェルの統合のスクリプト（docs/adr/112-copy-last-output.md）
  const shell = parsed.values["shell-integration"];
  if (shell !== undefined) {
    if (!isShell(shell)) {
      console.error(`Accompany: --shell-integration は ${shells.join("・")} のどれかで指定してください: ${shell}\n\n${usage}`);
      process.exit(1);
    }
    process.stdout.write(shellIntegrationScript(shell));
    process.exit(0);
  }
  // 数でない値や範囲の外の値で、ポートを試さずに、値の誤りとして終わる（docs/adr/152-free-port.md）
  const port = parsed.values.port;
  if (!/^\d+$/.test(port) || Number(port) > maxPort) {
    console.error(`Accompany: --port は 0〜${maxPort} の整数で指定してください: ${port}\n\n${usage}`);
    process.exit(1);
  }
  return parsed;
}

export const maxPort = 65535;

// parseArgs の例外を、短い日本語の説明にする。知らない種類のものは、元の説明をそのまま使う
function describe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const option = message.match(/Unknown option '([^']+)'/)?.[1];
    if (option) return `知らないオプションです: ${option}`;
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const option = message.match(/Option '(-[^\s']+)/)?.[1];
    // 値の要るオプションのあとに別のオプションが続いたとき（--port --fresh）は ambiguous になる
    if (option && /argument missing|argument is ambiguous/.test(message)) return `${option} には値が要ります`;
    if (option && /does not take an argument/.test(message)) return `${option} は値を取りません`;
  }
  return message;
}
