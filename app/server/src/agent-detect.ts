// ターミナルの前面で、エージェントが動いているかを見分ける（docs/adr/70-agent-detection.md）

// エージェントとみなすコマンドの名前
export const agentNames = new Set([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "aider",
  "cursor-agent",
  "copilot",
  "qwen",
  "amp",
]);

// スクリプトを動かすインタープリタ。npm や pip で入れた CLI は「node …/bin/gemini」のように動くので、
// 前面のプロセスの名前はインタープリタになる。そのときは次の引数（スクリプトのパス）の名前を見る
const interpreter = /^(node|nodejs|bun|deno|python[\d.]*)$/;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.(js|mjs|cjs|ts|py)$/, "");

// プロセスの引数（ps の args）が、エージェントを動かしているものか
export function isAgentCommand(args: string) {
  const words = args.trim().split(/\s+/);
  let name = basename(words[0] ?? "");
  if (interpreter.test(name)) {
    const script = words.slice(1).find((w) => !w.startsWith("-"));
    name = script ? basename(script) : "";
  }
  return agentNames.has(name);
}

// 前面のプロセスグループ。エージェントが動いていなければ agent は false
export type Foreground = { pgid: number; agent: boolean };

async function ps(args: string[]) {
  const proc = Bun.spawn(["ps", ...args], { stdout: "pipe", stderr: "ignore" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

// pid のプロセスを制御端末に持つプロセスを ps で調べ、前面のプロセスグループ（tpgid）に属するものの引数を見る。
// ps の -t と tpgid は macOS と Linux のどちらでも使える。調べられなかったら undefined
export async function foregroundOf(pid: number, tty?: string): Promise<{ tty: string; foreground: Foreground } | undefined> {
  try {
    tty ??= (await ps(["-o", "tty=", "-p", String(pid)])).trim();
    if (!tty || tty.startsWith("?")) return undefined;
    const rows = (await ps(["-o", "pgid=,tpgid=,args=", "-t", tty]))
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(-?\d+)\s+(.*)$/))
      .filter((m) => m !== null)
      .map(([, pgid, tpgid, args]) => ({ pgid: Number(pgid), tpgid: Number(tpgid), args }));
    const pgid = rows[0]?.tpgid;
    if (pgid === undefined || pgid <= 0) return undefined;
    const agent = rows.some((row) => row.pgid === pgid && isAgentCommand(row.args));
    return { tty, foreground: { pgid, agent } };
  } catch {
    return undefined;
  }
}
