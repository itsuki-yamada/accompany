import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseQuickCommand, type QuickCommand } from "./quick-commands";
import type { Size } from "./terminal";
import type { Layout } from "./workspace";

// 再起動しても戻す、画面の配置とターミナルごとのスクロールバック、よく使うコマンド（docs/adr/34-session-restore.md）
export type SavedTerminal = Size & {
  // サーバー側の画面を書き出したもの（xterm の SerializeAddon）
  scrollback: string;
  // 起動時のコマンドを動かしていたターミナルか
  initial: boolean;
};
export type SavedTab = { id: string; layout: Layout };
export type SavedSession = {
  version: 1;
  // どのディレクトリで起動した Accompany のものか（人が保存ファイルを見たときのため）
  cwd: string;
  tabs: SavedTab[];
  active: string;
  terminals: Record<string, SavedTerminal>;
  commands: QuickCommand[];
};

// スクロールバックには秘密が含まれうるので、本人だけが読み書きできるようにする
const dirMode = 0o700;
const fileMode = 0o600;

// 保存先のディレクトリ。ACCOMPANY_STATE_DIR、$XDG_STATE_HOME/accompany、~/.local/state/accompany の順に使う
export function stateDir(env = process.env) {
  if (env.ACCOMPANY_STATE_DIR) return env.ACCOMPANY_STATE_DIR;
  const base = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(base, "accompany");
}

// Accompany を起動したディレクトリごとに、1 つのファイルに保存する
export class SessionStore {
  readonly file: string;

  constructor(
    private dir: string,
    cwd: string,
  ) {
    const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    this.file = join(dir, "sessions", `${key}.json`);
  }

  // 保存したものを読む。ないとき・読めないときは undefined（新しく始める）
  load(): SavedSession | undefined {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Accompany: 保存した画面を読めませんでした: ${error}`);
      return;
    }
    try {
      const session = parseSavedSession(JSON.parse(text));
      if (!session) console.warn(`Accompany: 保存した画面の形式が正しくないため、新しく始めます: ${this.file}`);
      return session;
    } catch (error) {
      console.warn(`Accompany: 保存した画面を読めないため、新しく始めます: ${error}`);
    }
  }

  // 書きかけのファイルを読まないよう、一時ファイルに書いてから rename で置き換える
  save(session: SavedSession) {
    const sessions = dirname(this.file);
    for (const dir of [this.dir, sessions]) {
      mkdirSync(dir, { recursive: true, mode: dirMode });
      // 前からあるディレクトリも、本人だけが読み書きできるようにする
      chmodSync(dir, dirMode);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    try {
      writeFileSync(tmp, JSON.stringify(session), { mode: fileMode, flag: "wx" });
      renameSync(tmp, this.file);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}

// 保存ファイルは本人が書いたものだが、壊れていたり古い形式だったりするかもしれないので、形を確かめてから使う
export function parseSavedSession(data: unknown): SavedSession | undefined {
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.tabs) || data.tabs.length === 0) return;
  // ターミナルと分割の節の ID。どちらもすべてのタブを通して 1 つずつ
  const seen = new Set<string>();
  const tabs: SavedTab[] = [];
  for (const tab of data.tabs) {
    if (!isObject(tab) || !isNumericId(tab.id) || tabs.some((t) => t.id === tab.id)) return;
    const layout = parseLayout(tab.layout, seen, 0);
    if (!layout) return;
    tabs.push({ id: tab.id, layout });
  }
  const active = tabs.some((t) => t.id === data.active) ? String(data.active) : tabs[0]!.id;

  const savedTerminals = isObject(data.terminals) ? data.terminals : {};
  const terminals: Record<string, SavedTerminal> = {};
  for (const id of [...seen].filter(isNumericId)) {
    const t = savedTerminals[id];
    terminals[id] = {
      ...(isObject(t) && isSize(t) ? { cols: t.cols, rows: t.rows } : { cols: 80, rows: 24 }),
      scrollback: isObject(t) && typeof t.scrollback === "string" ? t.scrollback : "",
      initial: isObject(t) && t.initial === true,
    };
  }

  const commands: QuickCommand[] = [];
  for (const c of Array.isArray(data.commands) ? data.commands : []) {
    const command = isObject(c) && isNumericId(c.id) && parseQuickCommand(c);
    if (command && !commands.some((x) => x.id === c.id)) commands.push({ id: c.id as string, ...command });
  }

  return { version: 1, cwd: String(data.cwd ?? ""), tabs, active, terminals, commands };
}

function parseLayout(node: unknown, seen: Set<string>, depth: number): Layout | undefined {
  if (!isObject(node) || depth > 100) return;
  if (node.type === "terminal") {
    if (!isNumericId(node.id) || seen.has(node.id)) return;
    seen.add(node.id);
    return { type: "terminal", id: node.id };
  }
  if (node.type !== "split" || typeof node.id !== "string" || !/^split-[1-9]\d{0,8}$/.test(node.id)) return;
  if (seen.has(node.id)) return;
  seen.add(node.id);
  if (node.direction !== "row" && node.direction !== "column") return;
  if (!Array.isArray(node.children) || node.children.length !== 2) return;
  const first = parseLayout(node.children[0], seen, depth + 1);
  const second = first && parseLayout(node.children[1], seen, depth + 1);
  if (!second) return;
  const ratio = typeof node.ratio === "number" && Number.isFinite(node.ratio) ? node.ratio : 0.5;
  return {
    type: "split",
    id: node.id,
    direction: node.direction,
    ratio: Math.min(0.9, Math.max(0.1, ratio)),
    children: [first!, second],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,8}$/.test(value);
}

function isSize(value: Record<string, unknown>): value is Record<string, unknown> & Size {
  const valid = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;
  return valid(value.cols) && valid(value.rows);
}
