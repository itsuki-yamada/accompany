// 端末への問い合わせ（デバイス属性・カーソルの位置・色など、アプリが端末に答えを求めるシーケンス）への返事は、
// サーバー側の画面（@xterm/headless）だけが作り、PTY に 1 回だけ書く。参加者のブラウザの xterm.js には作らせない
// （docs/adr/231-single-query-reply.md）

// 色の問い合わせに答える色。ブラウザの既定の配色（暗い）と同じ。カーソルの色は、暗い配色では決めておらず xterm.js の既定（白）
export const defaultColors = { foreground: "#cccccc", background: "#000000", cursor: "#ffffff" };

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

// xterm.js の既定の 256 色（@xterm/xterm の DEFAULT_ANSI_COLORS と同じ）。明るい・見やすさ重視の配色も、16 色より先はこれを使う
const ansiColors: Rgb[] = (() => {
  const colors = [
    "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
    "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
  ].map(hexToRgb);
  const levels = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
  for (let i = 0; i < 216; i++) colors.push([levels[Math.floor(i / 36) % 6], levels[Math.floor(i / 6) % 6], levels[i % 6]]);
  for (let i = 0; i < 24; i++) colors.push([8 + i * 10, 8 + i * 10, 8 + i * 10]);
  return colors;
})();

// xterm.js と同じ形（16 ビットの rgb:rrrr/gggg/bbbb）で書く
function rgbString([r, g, b]: Rgb) {
  const channel = (n: number) => n.toString(16).padStart(2, "0").repeat(2);
  return `rgb:${channel(r)}/${channel(g)}/${channel(b)}`;
}

const specialColors: Record<number, Rgb> = {
  10: hexToRgb(defaultColors.foreground),
  11: hexToRgb(defaultColors.background),
  12: hexToRgb(defaultColors.cursor),
};

// 色の問い合わせ・設定に使う OSC（4: 256 色の番号ごと、10: 文字色、11: 背景色、12: カーソルの色）
const colorOscs = [4, 10, 11, 12] as const;
type ColorOsc = (typeof colorOscs)[number];

// OSC 4・10・11・12 の中身を、問い合わせ（?）への返事と、問い合わせを除いた残り（色の設定）に分ける。
// rest は、色の設定が残らなければ undefined。問い合わせがなければ、中身そのまま
export function colorQueries(ident: ColorOsc, data: string): { replies: string[]; rest: string | undefined } {
  const slots = data.split(";");
  const replies: string[] = [];
  if (ident === 4) {
    // 番号と色の組を並べる。? の組は返事にして、残りから外す
    const kept: string[] = [];
    for (let i = 0; i + 1 < slots.length; i += 2) {
      const [index, spec] = [slots[i], slots[i + 1]];
      if (spec === "?") {
        const color = /^\d+$/.test(index) ? ansiColors[Number(index)] : undefined;
        if (color) replies.push(`\x1b]4;${Number(index)};${rgbString(color)}\x1b\\`);
      } else kept.push(index, spec);
    }
    if (!slots.some((slot, i) => i % 2 === 1 && slot === "?")) return { replies, rest: data };
    return { replies, rest: kept.length > 0 ? kept.join(";") : undefined };
  }
  // 10 から順に、文字色・背景色・カーソルの色を並べられる（OSC 10;?;? は文字色と背景色の問い合わせ）。
  // 残りでは、? の場所を空にして順番を保つ（空は色として読めないので、その色は変わらない）
  slots.forEach((slot, i) => {
    const color = specialColors[ident + i];
    if (slot === "?" && color) replies.push(`\x1b]${ident + i};${rgbString(color)}\x1b\\`);
  });
  if (!slots.includes("?")) return { replies, rest: data };
  const rest = slots.map((slot) => (slot === "?" ? "" : slot));
  return { replies, rest: rest.some((slot) => slot !== "") ? rest.join(";") : undefined };
}

// @xterm/xterm と @xterm/headless のパーサーの、ここで使う部分
type Parser = {
  registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, callback: () => boolean): unknown;
  registerDcsHandler(id: { intermediates?: string; final: string }, callback: () => boolean): unknown;
  registerOscHandler(ident: number, callback: (data: string) => boolean): unknown;
};

// xterm.js が返事を作る CSI の問い合わせ。どれも返事のほかには何もしない
const csiQueries = [
  { final: "c" }, // DA1
  { prefix: ">", final: "c" }, // DA2
  { final: "n" }, // DSR（5: 状態、6: カーソルの位置）
  { prefix: "?", final: "n" }, // DECXCPR（? 6: カーソルの位置）
  { intermediates: "$", final: "p" }, // DECRQM（ANSI のモード）
  { prefix: "?", intermediates: "$", final: "p" }, // DECRQM（DEC のモード）
];

// ブラウザの xterm.js に、問い合わせへの返事を作らせない。返事は onData に人の入力と同じように乗ってくるので、
// パーサーのハンドラーで先に受け止め、xterm.js の既定の処理（返事を作る）まで行かせない。
// 色の OSC に設定と問い合わせが混ざっているときは、問い合わせを除いた設定だけを書き直して反映する
export function ignoreQueries(terminal: { parser: Parser; write(data: string): void }) {
  for (const id of csiQueries) terminal.parser.registerCsiHandler(id, () => true);
  // DECRQSS（設定の問い合わせ）
  terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true);
  for (const ident of colorOscs) {
    terminal.parser.registerOscHandler(ident, (data) => {
      const { rest } = colorQueries(ident, data);
      if (rest === data) return false;
      if (rest !== undefined) terminal.write(`\x1b]${ident};${rest}\x1b\\`);
      return true;
    });
  }
}

// サーバー側の画面で、問い合わせに答える。@xterm/headless は色を持たず色の問い合わせには答えないので、
// 既定の配色の色で答える。そのほかの問い合わせは headless が作る返事（onData）をそのまま使う
export function answerQueries(
  terminal: { parser: Parser; onData(listener: (data: string) => void): unknown },
  reply: (data: string) => void,
) {
  terminal.onData(reply);
  for (const ident of colorOscs) {
    terminal.parser.registerOscHandler(ident, (data) => {
      colorQueries(ident, data).replies.forEach(reply);
      // 設定の処理は headless に任せる（色を持たないので何もしない）
      return false;
    });
  }
}
