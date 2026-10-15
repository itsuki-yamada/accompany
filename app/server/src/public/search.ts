import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";

// ヒットの強調の色（#RRGGBB で指定する必要がある）
const decorations: ISearchOptions["decorations"] = {
  matchBackground: "#5a4a00",
  matchOverviewRuler: "#d0a000",
  activeMatchBackground: "#d07000",
  activeMatchColorOverviewRuler: "#ff8000",
};

// 検索バーを開くキー。macOS の Cmd+F と、Windows / Linux 向けの Ctrl+Shift+F。
// Ctrl+F はシェルのキー（1 文字進む）なので奪わない（docs/adr/27-search-keys.md）
export function isSearchKey(event: KeyboardEvent) {
  if (event.key.toLowerCase() !== "f" || event.altKey) return false;
  const cmdF = event.metaKey && !event.ctrlKey && !event.shiftKey;
  const ctrlShiftF = event.ctrlKey && event.shiftKey && !event.metaKey;
  return cmdF || ctrlShiftF;
}

// 1 つのターミナルの出力（スクロールバックを含む）を検索するバー。
// 検索は参加者ごとの操作なので、ブラウザの中で完結し、サーバーには何も送らない
export class SearchBar {
  readonly element = document.createElement("div");
  private addon = new SearchAddon();
  private input = document.createElement("input");
  private count = document.createElement("span");
  private caseSensitive: HTMLButtonElement;
  private regex: HTMLButtonElement;

  constructor(private terminal: Terminal) {
    terminal.loadAddon(this.addon);

    this.element.className = "search-bar";
    this.element.setAttribute("role", "search");
    this.element.setAttribute("aria-label", "ターミナルの検索");
    this.element.hidden = true;

    this.input.type = "text";
    this.input.placeholder = "検索";
    this.input.setAttribute("aria-label", "検索する文字");
    this.input.addEventListener("input", () => this.find("next", true));
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.find(event.shiftKey ? "previous" : "next");
      } else if (event.key === "Escape" && !event.isComposing) {
        // 日本語入力で変換を取り消す Escape は IME に任せる
        event.preventDefault();
        this.close();
      }
    });

    this.count.className = "search-count";
    this.count.setAttribute("role", "status");

    this.caseSensitive = toggle("大文字と小文字を区別", "Aa", () => this.research());
    this.regex = toggle("正規表現", ".*", () => this.research());

    this.element.append(
      this.input,
      this.count,
      this.caseSensitive,
      this.regex,
      button("前のヒット", "↑", () => this.find("previous")),
      button("次のヒット", "↓", () => this.find("next")),
      button("検索を閉じる", "×", () => this.close()),
    );

    this.addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (resultCount === 0) this.count.textContent = this.input.value ? "結果なし" : "";
      // ヒットが多すぎて何件目か数えられないとき
      else if (resultIndex < 0) this.count.textContent = `${resultCount}+ 件`;
      else this.count.textContent = `${resultIndex + 1}/${resultCount}`;
    });
  }

  open() {
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
    if (this.input.value) this.find("next", true);
  }

  close() {
    this.element.hidden = true;
    this.addon.clearDecorations();
    this.terminal.focus();
  }

  // 大文字・小文字の区別や正規表現を切り替えたとき。addon-search（0.16.0）は、言葉が同じだと
  // 切り替えても前の条件でのヒットを使い回すので、ヒットを消してから探し直す
  private research() {
    this.addon.clearDecorations();
    this.find("next", true);
  }

  // incremental: 入力や切り替えのたびに、いま選んでいるヒットに留まったまま探し直す
  private find(direction: "next" | "previous", incremental = false) {
    const term = this.input.value;
    if (!term) {
      this.addon.clearDecorations();
      this.count.textContent = "";
      return;
    }
    const options: ISearchOptions = {
      caseSensitive: pressed(this.caseSensitive),
      regex: pressed(this.regex),
      incremental,
      decorations,
    };
    try {
      if (direction === "next") this.addon.findNext(term, options);
      else this.addon.findPrevious(term, options);
    } catch (error) {
      if (!options.regex) throw error;
      // 書きかけの正規表現（例: 閉じていない括弧）
      this.addon.clearDecorations();
      this.count.textContent = "正規表現が正しくない";
    }
  }
}

function button(label: string, text: string, onClick: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = label;
  element.setAttribute("aria-label", label);
  element.addEventListener("click", onClick);
  return element;
}

function toggle(label: string, text: string, onChange: () => void) {
  const element = button(label, text, () => {
    element.setAttribute("aria-pressed", String(!pressed(element)));
    onChange();
  });
  element.setAttribute("aria-pressed", "false");
  return element;
}

function pressed(element: HTMLElement) {
  return element.getAttribute("aria-pressed") === "true";
}
