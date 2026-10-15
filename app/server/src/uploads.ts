import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 1 回のアップロード（ドロップ）で受け付ける大きさの上限。スクリーンショットや小さなファイルを渡す用途に十分な大きさにする
export const maxUploadBytes = 100 * 1024 * 1024;

// ブラウザからドロップされたファイルの保存先。Accompany ごとに一時ディレクトリを 1 つ作り、止めるときに消す（docs/adr/29-file-drop.md）
export class Uploads {
  readonly dir = mkdtempSync(join(tmpdir(), "accompany-"));
  private nextId = 1;

  // ドロップ 1 回ごとにディレクトリを分け、元のファイル名のまま保存する。同じ名前のファイルを何度ドロップしても上書きしない
  async save(files: File[]) {
    const dir = join(this.dir, String(this.nextId++));
    // 長く起動している間に OS が一時ディレクトリを掃除しても保存できるよう、親のディレクトリごと作る
    mkdirSync(dir, { recursive: true });
    const used = new Set<string>();
    const paths: string[] = [];
    for (const file of files) {
      let name = safeName(file.name);
      for (let n = 2; used.has(name); n++) name = `${n}-${safeName(file.name)}`;
      used.add(name);
      const path = join(dir, name);
      await Bun.write(path, file);
      paths.push(path);
    }
    return paths;
  }

  remove() {
    rmSync(this.dir, { recursive: true, force: true });
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
