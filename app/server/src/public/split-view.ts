// 分割表示（docs/adr/215-split-view.md）。分割したタブは、タブの一覧で 1 つのタブのように並ぶ。分割は参加者ごとなので、
// 並びはサーバーが持つタブの並び（全員で共有）から、自分の分割をまとめて作る

// 一覧の 1 つの項目。tabs は項目に並べるタブ（分割なら、分割の中の並び＝左から・上から）、lead は、タブの並びで最初に出てくるタブ。
// 項目は lead の位置に出し、lead のグループに入っているものとして扱う
export type Entry<T> = { tabs: T[]; lead: T };

// タブの並びを、項目の並びにする。分割のタブは、分割の中で並びが一番前のタブの位置にまとめる
export function entriesOf<T extends { id: string }>(tabs: T[], splits: string[][]): Entry<T>[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const placed = new Set<string>();
  const entries: Entry<T>[] = [];
  for (const tab of tabs) {
    if (placed.has(tab.id)) continue;
    const split = splits.find((ids) => ids.includes(tab.id));
    const members = split ? split.flatMap((id) => (byId.has(id) && !placed.has(id) ? [byId.get(id)!] : [])) : [tab];
    for (const member of members) placed.add(member.id);
    entries.push({ tabs: members, lead: tab });
  }
  return entries;
}
