import { singleLine } from "./terminal";

// 参加者の名前の長さの上限（見た目の 1 文字＝書記素の数）。ブラウザの入力欄（public/member-name.ts の maxNameLength）と同じ
export const maxNameLength = 32;

// 整える前に切り詰める長さ（UTF-16 の単位）。極端に長い文字列を、書記素に分ける前に短くする。
// 絵文字の組み合わせ（1 書記素が十数単位）を上限まで並べても収まる長さにする
const maxRawLength = maxNameLength * 32;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 見えない文字。表示されない文字（Default_Ignorable_Code_Point: ゼロ幅スペース、ZWNJ、BOM、タグ文字、ソフトハイフン、
// ハングルのフィラー、CGJ、異体字セレクタなど）、空白、点字の空白（U+2800）
const invisible = /[\p{Default_Ignorable_Code_Point}\s⠀]/gu;

// 参加者が設定した名前を、ほかの参加者の画面に出せる 1 行の文字列に整える（docs/adr/96-member-name.md）。
// タイトル（sanitizeTitle）と同じく、制御文字と双方向テキストの制御文字を取り除き、改行やタブは空白にする。
// 対になっていないサロゲートも除く。続いた空白は 1 つにまとめ、前後の空白は除く。長すぎる部分は書記素の単位で切り詰める。
// 空になったとき、見えない文字だけのときは、名前を設定していないものとする
export function sanitizeName(name: string) {
  const text = singleLine(name.slice(0, maxRawLength).replace(/[\t\n\v\f\r]/g, " "))
    .replace(/\p{Cs}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...graphemes.segment(text)]
    .slice(0, maxNameLength)
    .map((s) => s.segment)
    .join("")
    .trim();
  return cut.replace(invisible, "") ? cut : undefined;
}

// 同じ名前かを比べるための形。全角・半角などの見た目の違い（NFKC）と、見えない文字・結合文字（\p{M}）を無視して、
// 見分けにくい名前も同じ名前とみなす
export function nameKey(name: string) {
  return name.normalize("NFKC").replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, "");
}
