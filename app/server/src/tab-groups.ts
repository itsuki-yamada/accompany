// タブのグループの色。決まった色から選ぶ。どの色を画面にどう出すかはブラウザが決める（docs/adr/209-tab-groups.md）
export const groupColors = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "grey"] as const;
export type GroupColor = (typeof groupColors)[number];

export function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === "string" && (groupColors as readonly string[]).includes(value);
}
