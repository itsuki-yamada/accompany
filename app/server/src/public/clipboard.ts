// クリップボードに書き込む。VS Code の拡張のパネル（webview）の中の iframe で開いたときは、VS Code が
// localhost のページにクリップボードの許可を与えないので、書き込めなければ、親の webview に頼んで書き込んでもらう
// （docs/adr/183-liveshare-extension.md）。頼む先は VS Code の webview（vscode-webview:）だけにし、ほかのページに
// iframe で埋め込まれたときに、コピーした文字を渡さない
export async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const parent = vscodeWebviewOrigin();
    if (!parent) throw error;
    // webview は長すぎる文字を黙って捨てるので、渡す前に断り、書き込めなかったことを知らせる
    if (text.length > maxWebviewClipboardLength) throw error;
    window.parent.postMessage({ type: "accompany.clipboard.write", text }, parent);
  }
}

// webview に頼んで書き込める文字数（UTF-16 の単位）の上限。拡張（app/vscode/src/extension.ts の maxClipboardLength）と同じ
const maxWebviewClipboardLength = 10_000_000;

function vscodeWebviewOrigin() {
  if (window.parent === window) return undefined;
  const origin = location.ancestorOrigins?.[0];
  return origin?.startsWith("vscode-webview://") ? origin : undefined;
}
