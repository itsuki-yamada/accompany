import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 1 回のアップロード（ドロップ）で受け付ける大きさの上限。スクリーンショットや小さなファイルを渡す用途に十分な大きさにする
export const maxUploadBytes = 100 * 1024 * 1024;

// ブラウザからドロップされたファイルの保存先。Accompany ごとに一時ディレクトリを 1 つ作り、止めるときに消す（docs/adr/29-file-drop.md）
export class Uploads {
  private root = createRoot();
  private nextId = 1;

  // ドロップ 1 回ごとにディレクトリを分け、元のファイル名のまま保存する。同じ名前のファイルを何度ドロップしても上書きしない。
  // 一時ディレクトリはほかのユーザーと共有しているので、既にあるものやシンボリックリンクはたどらない
  // （ディレクトリは recursive なしで作り、ファイルは排他作成 wx で書く。既にあればエラーにする）
  async save(files: File[]) {
    // 中身は先にすべて読んでおく。保存先を確かめてから書き終えるまでに await を挟まず、同期処理だけにして、
    // 確かめたあとに保存先が置き換えられうる間をできるだけ短くする（同時に来たほかの save とも混ざらない）
    const contents = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
    const dir = join(this.currentRoot(), String(this.nextId++));
    mkdirSync(dir, { mode: 0o700 });
    const used = new Set<string>();
    return files.map((file, i) => {
      let name = safeName(file.name);
      for (let n = 2; used.has(name); n++) name = `${n}-${safeName(file.name)}`;
      used.add(name);
      const path = join(dir, name);
      writeFileSync(path, contents[i], { flag: "wx", mode: 0o600 });
      return path;
    });
  }

  remove() {
    rmSync(this.root, { recursive: true, force: true });
  }

  // 長く起動している間に OS が一時ディレクトリを掃除すると、保存先が消える。消えた名前は推測できるので、
  // 同じパスを作り直さず（ほかのユーザーが先にリンクを置けるため）、推測できない新しい保存先を作ってそちらを使う
  private currentRoot() {
    if (!isOwnPrivateDirectory(this.root)) this.root = createRoot();
    return this.root;
  }
}

// mkdtemp は推測できない名前で、自分だけが使える（0700）ディレクトリを作る
function createRoot() {
  return mkdtempSync(join(tmpdir(), "accompany-"));
}

// シンボリックリンクではなく、自分が持ち主で、ほかのユーザーが書き込めないディレクトリか
function isOwnPrivateDirectory(path: string) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

// ファイル名は送り手が自由に決められるので、保存先の外を指したり、コマンドのオプションに見えたりしないようにする
// - パスの区切り（/ と \）より前は捨て、最後の部分だけを使う
// - 制御文字を除き、先頭の . や - や空白を除く（隠しファイル、..、オプションに見えるのを防ぐ）
// - ファイル名の長さの上限（多くのファイルシステムで 255 バイト）に収まるよう、末尾（拡張子）を残して切り詰める
export function safeName(original: string) {
  const base = original.split(/[\\/]/).pop() ?? "";
  const chars = Array.from(base.replace(/[\x00-\x1f\x7f]/g, ""));
  return chars.slice(-60).join("").replace(/^[.\s-]+/, "") || "file";
}
