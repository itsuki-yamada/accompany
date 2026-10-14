// ターミナルに画像やファイルをドロップすると、サーバーにアップロードして保存し、保存先のパスをターミナルの入力に貼り付ける。
// ブラウザからはドロップしたファイルのローカルのパスを取れないので、サーバー上に置いたコピーのパスを渡す
export function acceptFileDrop(element: HTMLElement, paste: (text: string) => void) {
  const indicator = document.createElement("div");
  indicator.className = "drop-indicator";
  indicator.textContent = "ドロップしてパスを貼り付け";
  element.append(indicator);

  // 子要素に出入りするたびに dragenter / dragleave が届くので、数えて外に出たときだけ表示を消す
  let depth = 0;
  const show = (visible: boolean) => {
    if (visible) element.dataset.dropTarget = "true";
    else delete element.dataset.dropTarget;
  };
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

  element.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    show(true);
  });
  element.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    // 既定ではドロップを受け付けないので、取り消して受け付ける
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  });
  element.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  element.addEventListener("drop", async (event) => {
    if (!hasFiles(event)) return;
    // ブラウザがファイルを開いてページを移動しないようにする
    event.preventDefault();
    depth = 0;
    show(false);
    const files = [...event.dataTransfer!.files];
    if (files.length === 0) return;
    const paths = await upload(files);
    if (paths) {
      // Enter は送らない。続けて指示を書き足してから送れるよう、末尾に空白を付ける
      paste(`${paths.map(quoteForShell).join(" ")} `);
    } else {
      // 失敗したことがわかるよう、少しの間だけ表示を出す
      indicator.textContent = "アップロードできませんでした";
      element.dataset.dropError = "true";
      setTimeout(() => {
        indicator.textContent = "ドロップしてパスを貼り付け";
        delete element.dataset.dropError;
      }, 3000);
    }
  });
}

async function upload(files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  try {
    const response = await fetch("/api/uploads", { method: "POST", body: form });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const { paths } = (await response.json()) as { paths: string[] };
    return paths;
  } catch (error) {
    console.error("ファイルをアップロードできませんでした", error);
    return undefined;
  }
}

// 空白などシェルで特別な意味を持つ文字を含むパスは、シングルクォートで囲む
function quoteForShell(path: string) {
  if (/^[\p{L}\p{N}_\-.,/+@%:=]+$/u.test(path)) return path;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
