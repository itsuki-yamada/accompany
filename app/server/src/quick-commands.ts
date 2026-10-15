// よく使うコマンド。参加者全員で共有し、選んだ人のターミナルに入力する（docs/adr/35-quick-commands.md）
// run が true なら、入力したあとに Enter も送ってすぐに実行する
export type QuickCommand = { id: string; name: string; content: string; run: boolean };

export type QuickCommandInput = Omit<QuickCommand, "id">;

// 登録できる数と長さの上限。参加者全員に配るので、大きくなりすぎないようにする
export const maxQuickCommands = 100;
const maxNameLength = 100;
const maxContentLength = 10000;

// 双方向テキストの制御文字は表示を偽装できるので、名前からも内容からも取り除く
const bidiControls = /[؜‎‏‪-‮⁦-⁩]/gu;

// ブラウザから届いた登録・編集の内容を確かめて整える。内容が空のものは受け付けない。
// 内容はそのまま端末に送るので、改行とタブ以外の制御文字（ESC など）を取り除く。改行は LF にそろえる
export function parseQuickCommand(message: { name?: unknown; content?: unknown; run?: unknown }) {
  if (typeof message.content !== "string" || typeof message.name !== "string") return;
  const content = [
    ...message.content
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029\u0085]/g, "\n")
      .replace(/[^\P{Cc}\n\t]/gu, "")
      .replace(bidiControls, "")
      // 末尾の改行は Enter として働いてしまうので取り除く。Enter を送るかは run で決める
      .replace(/\n+$/, ""),
  ]
    .slice(0, maxContentLength)
    .join("");
  if (content.trim() === "") return;
  // 名前は 1 行にする。空なら内容の 1 行目を名前にする
  const name =
    [
      ...message.name
        .replace(/[\r\n\u2028\u2029\u0085\t]/g, " ")
        .replace(/\p{Cc}/gu, "")
        .replace(bidiControls, "")
        .trim(),
    ]
      .slice(0, maxNameLength)
      .join("") || [...content.trim().split("\n")[0]!].slice(0, maxNameLength).join("");
  return { name, content, run: message.run === true } satisfies QuickCommandInput;
}
