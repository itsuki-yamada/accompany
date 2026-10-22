import { singleLine } from "./terminal";

// 参加者の名前の長さの上限（文字数）。ブラウザの入力欄（public/index.ts の maxNameLength）と同じ
export const maxNameLength = 32;

// 参加者が設定した名前を、ほかの参加者の画面に出せる 1 行の文字列に整える（docs/adr/96-member-name.md）。
// タイトル（sanitizeTitle）と同じく、制御文字と双方向テキストの制御文字を取り除き、改行やタブは空白にする。
// 対になっていないサロゲートも除く。続いた空白は 1 つにまとめ、前後の空白は除く。長すぎる部分は切り詰める。
// 空になったら、名前を設定していないものとする
export function sanitizeName(name: string) {
  const text = singleLine(name.replace(/[\t\n\v\f\r]/g, " "))
    .replace(/\p{Cs}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...text].slice(0, maxNameLength).join("").trim() || undefined;
}

// 同じ名前かを比べるための形。全角・半角などの見た目の違いと、幅のない文字（ゼロ幅スペースなど）を無視して、
// 見分けにくい名前も同じ名前とみなす
export function nameKey(name: string) {
  return name.normalize("NFKC").replace(/\p{Cf}/gu, "");
}
