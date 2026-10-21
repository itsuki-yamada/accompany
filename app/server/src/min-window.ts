// 端末の大きさの下限。参加者全員に効く設定で、サーバーが持って全員に配り、保存する（docs/adr/99-smallest-size.md）。
// 列数・行数ではなく、ウィンドウの大きさ（ピクセル）で持つ。各ブラウザが、このウィンドウで Accompany を開いたときの
// 表示領域を、自分のブラウザの枠・Accompany のバーの実寸と、自分のフォントの大きさで列数・行数に直す
export type WindowSize = { width: number; height: number };

// 既定は、フル HD を縦に 4 つに分けた 1 つ分のウィンドウ。縦につぶれないよう、横に 4 つ並べる分け方にする
export const defaultMinWindow: WindowSize = { width: 480, height: 1080 };

// 各参加者の表示領域はフル HD までとみなす（docs/adr/51-largest-size.md）ので、下限もフル HD までにする。0 は下限なし
export const maxMinWindow: WindowSize = { width: 1920, height: 1080 };

// 0 以上・上限以下の整数だけを受け付ける。それ以外は undefined
export function parseMinWindow(value: unknown): WindowSize | undefined {
  if (typeof value !== "object" || value === null) return;
  const { width, height } = value as Record<string, unknown>;
  const valid = (n: unknown, max: number): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
  return valid(width, maxMinWindow.width) && valid(height, maxMinWindow.height) ? { width, height } : undefined;
}

// 起動オプションの「幅x高さ」（例: 480x1080）を読む
export function parseMinWindowOption(text: string): WindowSize | undefined {
  const match = /^(\d+)x(\d+)$/.exec(text);
  return match ? parseMinWindow({ width: Number(match[1]), height: Number(match[2]) }) : undefined;
}
