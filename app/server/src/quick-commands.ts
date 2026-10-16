// よく使うコマンド。参加者全員で共有し、選んだ人のターミナルに入力する（docs/adr/35-quick-commands.md）
// run が true なら、入力したあとに Enter も送ってすぐに実行する
export type QuickCommand = { id: string; name: string; content: string; run: boolean };

export type QuickCommandInput = Omit<QuickCommand, "id">;

// 登録できる数と長さの上限。参加者全員に配るので、大きくなりすぎないようにする
export const maxQuickCommands = 100;
const maxNameLength = 100;
const maxContentLength = 10000;

// 画面に出ない文字を取り除く。内容はそのまま端末に送り、名前と内容は押す前に確かめるものなので、見えるものと送るものをそろえる
// - 改行とタブ以外の制御文字（C0・C1。ESC など）: 端末のモードを変えたり、ブラケットペーストの終わりを偽装したりできる
// - 書式文字（\p{Cf}）: ゼロ幅文字・BOM・タグ文字（画面に出ないが LLM には読める）・双方向テキストの制御文字（表示を偽装できる）。
//   絵文字をつなぐゼロ幅接合子（U+200D）も、見えない文字として同じく取り除く
function removeInvisible(text: string) {
  return text.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "");
}

function truncate(text: string, max: number) {
  return [...text].slice(0, max).join("");
}

// ブラウザから届いた登録・編集の内容を確かめて整える。内容が空のものは受け付けない。改行は LF にそろえる
export function parseQuickCommand(message: { name?: unknown; content?: unknown; run?: unknown }) {
  if (typeof message.content !== "string" || typeof message.name !== "string") return;
  const content = truncate(
    removeInvisible(message.content.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")),
    maxContentLength,
  )
    // 末尾の改行は Enter として働いてしまうので取り除く。Enter を送るかは run で決める。
    // 切り詰めた切れ目が改行のこともあるので、切り詰めたあとに取り除く
    .replace(/\n+$/, "");
  if (content.trim() === "") return;
  // 名前は 1 行にする。空なら内容の 1 行目を名前にする
  const name =
    truncate(removeInvisible(message.name.replace(/[\r\n\t\u2028\u2029\u0085]/g, " ")).trim(), maxNameLength) ||
    truncate(content.trim().split("\n")[0]!, maxNameLength);
  return { name, content, run: message.run === true } satisfies QuickCommandInput;
}
