import type { ITheme } from "@xterm/xterm";

// ターミナルの見え方（配色、フォントの大きさ、端末が表示領域より大きいときの見せ方）。
// 参加者ごとの設定で、このブラウザに保存する（docs/adr/36-appearance.md、docs/adr/51-largest-size.md）
export type Appearance = { theme: ThemeName; fontSize: number; overflow: Overflow };
type ThemeName = keyof typeof themes;
// scroll: 文字の大きさはそのままで、はみ出した部分をスクロールして見る。fit: 縮小して表示領域に収める
type Overflow = keyof typeof overflows;
const overflows = { scroll: "スクロールして見る", fit: "画面に収める（縮小）" };

const themes = {
  dark: {
    label: "暗い",
    // xterm.js の既定の配色のうち、文字色だけ少し落として、ページの文字色（#ccc）にそろえる
    colors: { background: "#000000", foreground: "#cccccc" },
  },
  light: {
    label: "明るい",
    colors: {
      background: "#ffffff",
      foreground: "#1f2328",
      cursor: "#1f2328",
      cursorAccent: "#ffffff",
      selectionBackground: "#add6ff",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#7d4e00",
      blue: "#0550ae",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
  },
  "high-contrast": {
    label: "見やすさ重視",
    colors: {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#ffff00",
      cursorAccent: "#000000",
      selectionBackground: "#ffffff",
      selectionForeground: "#000000",
      black: "#000000",
      red: "#ff5555",
      green: "#55ff55",
      yellow: "#ffff55",
      blue: "#7aa7ff",
      magenta: "#ff77ff",
      cyan: "#55ffff",
      white: "#ffffff",
      brightBlack: "#a0a0a0",
      brightRed: "#ff8080",
      brightGreen: "#80ff80",
      brightYellow: "#ffff80",
      brightBlue: "#a0c0ff",
      brightMagenta: "#ff9cff",
      brightCyan: "#80ffff",
      brightWhite: "#ffffff",
    },
  },
} satisfies Record<string, { label: string; colors: ITheme }>;

// xterm.js の既定（15px）に合わせる
const defaults: Appearance = { theme: "dark", fontSize: 15, overflow: "scroll" };
const minFontSize = 8;
const maxFontSize = 32;
const storageKey = "accompany.appearance";

export function themeColors(appearance: Appearance): ITheme {
  return themes[appearance.theme].colors;
}

// 保存した設定を読む。読めない・壊れているときは既定値を使う
export function loadAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return {
      theme: Object.hasOwn(themes, saved.theme) ? saved.theme : defaults.theme,
      fontSize: validFontSize(saved.fontSize) ? saved.fontSize : defaults.fontSize,
      overflow: Object.hasOwn(overflows, saved.overflow) ? saved.overflow : defaults.overflow,
    };
  } catch {
    return { ...defaults };
  }
}

function saveAppearance(appearance: Appearance) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(appearance));
  } catch {
    // 保存できなくても、開いている間は使う
  }
}

function validFontSize(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= minFontSize && (value as number) <= maxFontSize;
}

// 表示の設定。タブバーのボタンで開き、変えるとすぐに保存して onChange で反映する
export function appearanceSettings(initial: Appearance, onChange: (appearance: Appearance) => void) {
  let appearance = initial;
  const update = (change: Partial<Appearance>) => {
    appearance = { ...appearance, ...change };
    saveAppearance(appearance);
    onChange(appearance);
  };

  const dialog = document.createElement("div");
  dialog.id = "appearance-settings";
  dialog.className = "appearance-settings";
  dialog.popover = "auto";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "表示の設定");

  const heading = document.createElement("h2");
  heading.textContent = "表示の設定";
  const note = document.createElement("p");
  note.textContent = "自分の画面だけに使い、このブラウザに保存します";

  const theme = select(
    Object.fromEntries(Object.entries(themes).map(([name, { label }]) => [name, label])),
    appearance.theme,
  );
  theme.addEventListener("change", () => update({ theme: theme.value as ThemeName }));

  const fontSize = document.createElement("input");
  fontSize.type = "number";
  fontSize.min = String(minFontSize);
  fontSize.max = String(maxFontSize);
  fontSize.step = "1";
  fontSize.value = String(appearance.fontSize);
  fontSize.addEventListener("input", () => {
    const value = Number(fontSize.value);
    // 入力の途中（空や範囲外）は反映しない
    if (validFontSize(value)) update({ fontSize: value });
  });
  // 範囲外のまま離れたら、使っている値に戻す
  fontSize.addEventListener("change", () => (fontSize.value = String(appearance.fontSize)));

  const overflow = select(overflows, appearance.overflow);
  overflow.addEventListener("change", () => update({ overflow: overflow.value as Overflow }));

  dialog.append(
    heading,
    note,
    field("配色", theme),
    field(`フォントの大きさ（${minFontSize}〜${maxFontSize}）`, fontSize, "フォントの大きさ"),
    field("端末が画面より大きいとき", overflow),
  );
  return dialog;
}

function select(options: Record<string, string>, value: string) {
  const element = document.createElement("select");
  element.append(
    ...Object.entries(options).map(([name, label]) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = label;
      return option;
    }),
  );
  element.value = value;
  return element;
}

function field(text: string, control: HTMLElement, name = text) {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = text;
  control.setAttribute("aria-label", name);
  label.append(caption, control);
  return label;
}
