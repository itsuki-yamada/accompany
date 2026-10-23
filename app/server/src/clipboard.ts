// 端末のアプリが OSC 52 で頼むクリップボードへの書き込み（docs/adr/113-osc52-clipboard.md）

// 受け付ける中身の大きさの上限（base64 のままの長さ）。中身にしておよそ 750 KB まで
export const maxClipboardBase64 = 1_000_000;

export type ClipboardRequest = { type: "clipboard"; text: string } | { type: "clipboard-too-large" };

const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const decoder = new TextDecoder();

// OSC 52 の中身（「選択先;base64」）を読む。選択先（c・p・s など）は区別しない（ブラウザのクリップボードは 1 つなので）。
// 読み出しの要求（?）と、空のもの・base64 でないもの（クリップボードを空にする要求）は無視する
export function parseClipboardRequest(data: string): ClipboardRequest | undefined {
  const separator = data.indexOf(";");
  if (separator < 0) return;
  const payload = data.slice(separator + 1);
  if (payload.length > maxClipboardBase64) return { type: "clipboard-too-large" };
  if (!base64.test(payload)) return;
  return { type: "clipboard", text: decoder.decode(Buffer.from(payload, "base64")) };
}
