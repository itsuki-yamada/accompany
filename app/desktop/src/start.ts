// 開始画面。ホストで始めるフォルダーか、ゲストで開く URL を選ぶ。最近使ったものはこの画面の localStorage に覚える
type Bridge = {
  chooseFolder(): Promise<string | undefined>;
  startHost(folder: string, port?: number): Promise<{ error?: string }>;
  openGuest(url: string): Promise<{ error?: string }>;
};
const bridge = (window as unknown as { accompany: Bridge }).accompany;

const statusLine = document.getElementById("status") as HTMLPreElement;
const urlInput = document.getElementById("url") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const maxRecent = 5;

function load(key: string): unknown[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function remember<T>(key: string, value: T, same: (a: T, b: T) => boolean, items: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify([value, ...items.filter((item) => !same(item, value))].slice(0, maxRecent)));
  } catch {
    // 覚えられなくても始められる
  }
}

// 最近ホストで始めたフォルダーと、そのときに指定したポート（指定しなかったときはなし）
type Host = { folder: string; port?: number };
const loadHosts = () =>
  load("hosts").filter(
    (item): item is Host =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Host).folder === "string" &&
      ((item as Host).port === undefined || Number.isInteger((item as Host).port)),
  );
const loadUrls = () => load("urls").filter((item): item is string => typeof item === "string");

function showStatus(text: string, error = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("error", error);
}

function setBusy(busy: boolean) {
  document.querySelectorAll("button, input").forEach((element) => {
    (element as HTMLButtonElement | HTMLInputElement).disabled = busy;
  });
}

async function run(label: string, action: () => Promise<{ error?: string }>) {
  setBusy(true);
  showStatus(label);
  const { error } = await action();
  // 成功したときはこの画面を離れるので、失敗したときだけ戻す
  if (error) {
    setBusy(false);
    showStatus(error, true);
  }
}

// 入力欄にポートがあればそれを、なければ覚えていたポートを使う
function startHost(folder: string, savedPort?: number) {
  const typed = portInput.value.trim();
  const port = typed === "" ? savedPort : Number(typed);
  // 不正なポートは覚えない（メインプロセスでも確かめる）
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    showStatus("ポートは 1〜65535 の整数で指定してください", true);
    return;
  }
  remember("hosts", { folder, port }, (a, b) => a.folder === b.folder, loadHosts());
  const label = port === undefined ? "" : `（ポート ${port}）`;
  void run(`${folder} で Accompany を起動しています${label}…`, () => bridge.startHost(folder, port));
}

function openGuest(url: string) {
  remember("urls", url, (a, b) => a === b, loadUrls());
  void run(`${url} を開いています…`, () => bridge.openGuest(url));
}

function renderRecent(id: string, items: { label: string; onClick: () => void }[]) {
  const container = document.getElementById(id)!;
  container.replaceChildren(
    ...items.map(({ label, onClick }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = label;
      button.addEventListener("click", onClick);
      return button;
    }),
  );
}

document.getElementById("choose")!.addEventListener("click", async () => {
  const folder = await bridge.chooseFolder();
  if (folder) startHost(folder);
});

document.getElementById("guest")!.addEventListener("submit", (event) => {
  event.preventDefault();
  openGuest(urlInput.value.trim());
});

renderRecent(
  "recent-folders",
  loadHosts().map(({ folder, port }) => ({
    label: port === undefined ? folder : `${folder}（ポート ${port}）`,
    onClick: () => startHost(folder, port),
  })),
);
renderRecent(
  "recent-urls",
  loadUrls().map((url) => ({ label: url, onClick: () => openGuest(url) })),
);
const error = new URLSearchParams(location.search).get("error");
if (error) showStatus(error, true);
