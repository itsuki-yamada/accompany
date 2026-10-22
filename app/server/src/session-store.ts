import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseMinWindow, type WindowSize } from "./min-window";
import { parseQuickCommand, type QuickCommand } from "./quick-commands";
import { clampSize, type Size } from "./terminal";

// 再起動しても戻す、タブの並びとターミナルごとのスクロールバック、よく使うコマンド（docs/adr/34-session-restore.md）、
// 端末の大きさの下限（docs/adr/99-smallest-size.md）。参加者ごとの表示は保存しない（docs/adr/100-terminal-tabs.md）
export type SavedTerminal = Size & {
  // サーバー側の画面を書き出したもの（xterm の SerializeAddon）
  scrollback: string;
  // 起動時のコマンドを動かしていたターミナルか
  initial: boolean;
};
export type SavedSession = {
  version: 2;
  // どのディレクトリで起動した Accompany のものか（人が保存ファイルを見たときのため）
  cwd: string;
  // タブ（ターミナルの ID）の並び
  tabs: string[];
  terminals: Record<string, SavedTerminal>;
  commands: QuickCommand[];
  // 下限を保存する前の版のファイルにはない
  minWindow?: WindowSize;
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

// 保存ファイルは本人が書いたものだが、壊れていたり古い形式だったりするかもしれないので、形を確かめてから使う。
// 前の形式（version 1。Workspace ごとの分割の配置）は、Workspace の順・配置の順にターミナルを並べてタブとして戻し、
// 分割の配置と表示中の Workspace は捨てる（docs/adr/100-terminal-tabs.md）
export function parseSavedSession(data: unknown): SavedSession | undefined {
  if (!isObject(data) || !Array.isArray(data.tabs) || data.tabs.length === 0) return;
  const tabs = data.version === 2 ? parseTabs(data.tabs) : data.version === 1 ? parseWorkspaces(data.tabs) : undefined;
  if (!tabs) return;

  const savedTerminals = isObject(data.terminals) ? data.terminals : {};
  const terminals: Record<string, SavedTerminal> = {};
  for (const id of tabs) {
    const t = savedTerminals[id];
    terminals[id] = {
      ...(isObject(t) && isSize(t) ? clampSize({ cols: t.cols, rows: t.rows }) : { cols: 80, rows: 24 }),
      scrollback: isObject(t) && typeof t.scrollback === "string" ? t.scrollback : "",
      initial: isObject(t) && t.initial === true,
    };
  }

  const commands: QuickCommand[] = [];
  for (const c of Array.isArray(data.commands) ? data.commands : []) {
    const command = isObject(c) && isNumericId(c.id) && parseQuickCommand(c);
    if (command && !commands.some((x) => x.id === c.id)) commands.push({ id: c.id as string, ...command });
  }

  const minWindow = parseMinWindow(data.minWindow);
  return { version: 2, cwd: String(data.cwd ?? ""), tabs, terminals, commands, ...(minWindow && { minWindow }) };
}

// タブの並び。ターミナルの ID が重なっていないこと
function parseTabs(ids: unknown[]): string[] | undefined {
  const tabs: string[] = [];
  for (const id of ids) {
    if (!isNumericId(id) || tabs.includes(id)) return;
    tabs.push(id);
  }
  return tabs;
}

// 前の形式の Workspace（{ id, layout }）の並びから、ターミナルを配置の順に取り出す。
// ターミナルと分割の節の ID は、どちらもすべての Workspace を通して 1 つずつ
function parseWorkspaces(workspaces: unknown[]): string[] | undefined {
  const seen = new Set<string>();
  const tabs: string[] = [];
  for (const workspace of workspaces) {
    if (!isObject(workspace) || !walkLayout(workspace.layout, seen, tabs, 0)) return;
  }
  return tabs;
}

function walkLayout(node: unknown, seen: Set<string>, tabs: string[], depth: number): boolean {
  if (!isObject(node) || depth > 100) return false;
  if (node.type === "terminal") {
    if (!isNumericId(node.id) || seen.has(node.id)) return false;
    seen.add(node.id);
    tabs.push(node.id);
    return true;
  }
  if (node.type !== "split" || typeof node.id !== "string" || !/^split-[1-9]\d{0,8}$/.test(node.id)) return false;
  if (seen.has(node.id)) return false;
  seen.add(node.id);
  if (!Array.isArray(node.children) || node.children.length !== 2) return false;
  return node.children.every((child) => walkLayout(child, seen, tabs, depth + 1));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumericId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,8}$/.test(value);
}

function isSize(value: Record<string, unknown>): value is Record<string, unknown> & Size {
  // 上限（maxSize）を超えるものは、捨てずに上限に丸めて使う
  const valid = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1;
  return valid(value.cols) && valid(value.rows);
}
