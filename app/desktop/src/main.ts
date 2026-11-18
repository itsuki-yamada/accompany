// Accompany のデスクトップアプリ（試作）のメインプロセス。
// サーバーには手を入れず、外側の入れ物として 2 通りに動く。
// - ホスト: 選んだフォルダーで Accompany のサーバー（bun dist/cli.js --port <ポート>）を子プロセスとして起動し、その画面を開く
// - ゲスト: 共有された URL（Live Share で転送された http://localhost:<port> など）を開く
import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";

type Server = { origin: string; stop(): Promise<void> };
// ウィンドウごとに、開いている Accompany のオリジンと、ホストなら起動したサーバーを持つ
// trialGuestOf: 試しに開いたゲストのウィンドウなら、そのホストのウィンドウ（webContents の id）
// portNote: ホストで、指定したポートが使われていて別のポートで待ち受けたときの知らせ（タイトルに出す）
type WindowState = { origin?: string; server?: Server; trialGuestOf?: number; portNote?: string };
const states = new Map<number, WindowState>();

// bun build は __dirname をビルドしたときのソースの場所に置き換えるので、アプリの場所（package.json のあるところ）から組み立てる
const dist = path.join(app.getAppPath(), "dist");
const startPage = path.join(dist, "start.html");
const serverCli = app.isPackaged
  ? path.join(process.resourcesPath, "dist", "cli.js")
  : path.join(app.getAppPath(), "..", "server", "dist", "cli.js");

// GUI から起動したアプリは、ログインシェルの環境変数（PATH など）を受け継がない。
// bun を見つけるためと、ターミナルのシェルにふだんの環境を渡すため、ログインシェルから環境変数を読む
let shellEnv: Promise<NodeJS.ProcessEnv> | undefined;
function loadShellEnv() {
  shellEnv ??= new Promise((resolve) => {
    const marker = "__ACCOMPANY_ENV__";
    execFile(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", `printf '${marker}'; env -0`],
      { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        const text = stdout?.split(marker)[1];
        if (error || text === undefined) {
          resolve(process.env);
          return;
        }
        const env: NodeJS.ProcessEnv = {};
        for (const entry of text.split("\0")) {
          const i = entry.indexOf("=");
          if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
        }
        for (const name of ["PWD", "OLDPWD", "SHLVL", "_"]) delete env[name];
        resolve(env);
      },
    );
  });
  return shellEnv;
}

// 指定がなければ CLI と同じ 3000 から始める。使われていたら、サーバーが空いているポートまで上げる（docs/adr/152-free-port.md）。
// --port 0 にしないのは、Live Share に足すポートを毎回同じにしやすくするため
const defaultPort = 3000;

function startServer(cwd: string, port: number, onExit: (message: string) => void): Promise<Server> {
  return loadShellEnv().then(
    (env) =>
      new Promise((resolve, reject) => {
        const child = spawn("bun", [serverCli, "--port", String(port)], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stopping = false;
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        const stop = async () => {
          stopping = true;
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          // Accompany は止まる前に画面を保存する（最大 3 秒）。それより長くかかるときは強制的に止める
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          await exited;
          clearTimeout(timer);
        };
        let text: string | undefined = "";
        let errors = "";
        child.stdout.on("data", (chunk: Buffer) => {
          process.stdout.write(chunk);
          if (text === undefined) return;
          text += chunk.toString();
          const url = text.match(/Accompany: (http:\/\/\S+)/)?.[1];
          if (!url) return;
          text = undefined;
          const { hostname, origin } = new URL(url);
          // Accompany はホストの外に開かない。loopback 以外で待ち受けていたら、開かずに止める
          if (hostname !== "127.0.0.1" && hostname !== "[::1]") {
            void stop();
            reject(new Error(`Accompany が loopback 以外（${hostname}）で待ち受けているので、開きません`));
            return;
          }
          resolve({ origin, stop });
        });
        child.stderr.on("data", (chunk: Buffer) => {
          process.stderr.write(chunk);
          errors = (errors + chunk.toString()).slice(-2000);
        });
        child.once("error", (error) =>
          reject(new Error(`bun を起動できませんでした（${error.message}）。Bun を入れて、ログインシェルの PATH に入れてください`)),
        );
        child.once("exit", (code, signal) => {
          const message = `Accompany が終了しました（${signal ?? `終了コード ${code}`}）${errors ? `\n${errors.trim()}` : ""}`;
          if (text !== undefined) reject(new Error(message));
          else if (!stopping) onExit(message);
        });
      }),
  );
}

// 止めている途中のサーバー。最後のウィンドウを閉じてアプリが終わるときも、画面の保存が終わるまで待つ
const stopping = new Set<Promise<void>>();
function stopServer(server: Server) {
  const done = server.stop();
  stopping.add(done);
  void done.finally(() => stopping.delete(done));
  return done;
}

function sameOrigin(url: string, origin: string | undefined) {
  if (!origin) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

// ページの外へのリンクは、アプリの中では開かず、ふだんのブラウザで開く
function openExternal(url: string) {
  try {
    const { protocol } = new URL(url);
    if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
  } catch {
    // URL でなければ何もしない
  }
}

function windowTitle(state: WindowState | undefined, title: string) {
  if (!state?.origin) return title;
  const { host, port } = new URL(state.origin);
  if (state.trialGuestOf !== undefined) return `[試しのゲスト] ${title} — ${host}`;
  if (state.server) return `${title} — ポート ${port}${state.portNote ? `（${state.portNote}）` : ""}`;
  return `${title} — ${host}`;
}

function showStartPage(win: BrowserWindow, error?: string) {
  void win.loadFile(startPage, error ? { query: { error } } : undefined);
}

function createWindow({ partition, trialGuestOf }: { partition?: string; trialGuestOf?: number } = {}) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Accompany",
    backgroundColor: "#000000",
    webPreferences: {
      partition,
      preload: path.join(dist, "preload.cjs"),
      // ゲストのときは、ほかのマシン（Live Share のホスト）から来たページを表示する。
      // ページから Node.js やこのマシンに触れられないよう、隔離して動かす
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const id = win.webContents.id;
  states.set(id, { trialGuestOf });
  const contents = win.webContents;
  // アプリにはアドレスバーがないので、Live Share に足すポートや、つないだ先をタイトルに出す
  contents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    win.setTitle(windowTitle(states.get(id), title));
  });

  // 開いている Accompany の中の移動だけを許し、それ以外はふだんのブラウザに回す
  contents.on("will-navigate", (event, url) => {
    if (sameOrigin(url, states.get(id)?.origin)) return;
    event.preventDefault();
    openExternal(url);
  });
  // Accompany は、空のウィンドウを開いてから location を差し替えてリンクを開く（pane.ts の openLink）。
  // 空のウィンドウは見せずに作り、移動しようとした先をふだんのブラウザで開いて閉じる
  contents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url === "") return { action: "allow", overrideBrowserWindowOptions: { show: false } };
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) => {
    const close = () => {
      if (!child.isDestroyed()) child.destroy();
    };
    child.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      openExternal(url);
      close();
    });
    setTimeout(close, 5000);
  });

  win.on("closed", () => {
    const server = states.get(id)?.server;
    if (server) void stopServer(server);
    states.delete(id);
    closeTrialGuests(id);
  });
  if (trialGuestOf === undefined) showStartPage(win);
  return win;
}

// ホストのまま、別のウィンドウでゲストとして入ってみる。
// ゲストは別の保存領域（メモリーだけ。閉じたら消える）で開き、localStorage の名前や表示の設定を分けて、別の参加者として見えるようにする。
// Live Share で転送されたゲストと同じく localhost で開く（ホストの 127.0.0.1 とはオリジンも分かれる）
let trialGuests = 0;
function openTrialGuest(host: BrowserWindow) {
  const hostId = host.webContents.id;
  const server = states.get(hostId)?.server;
  if (!server) {
    void dialog.showMessageBox(host, { message: "ホストで始めたウィンドウで選んでください" });
    return;
  }
  trialGuests += 1;
  const partition = `trial-guest-${trialGuests}`;
  setPermissionHandlers(session.fromPartition(partition));
  const url = new URL(server.origin);
  url.hostname = "localhost";
  const win = createWindow({ partition, trialGuestOf: hostId });
  const [x, y] = host.getPosition();
  win.setPosition(x + 40, y + 40);
  states.get(win.webContents.id)!.origin = url.origin;
  void win.loadURL(url.href);
}

// ホストが止まったら、試しのゲストのウィンドウも閉じる
function closeTrialGuests(hostId: number) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && states.get(win.webContents.id)?.trialGuestOf === hostId) win.close();
  }
}

// 開始画面（file://）からの呼び出しだけを受け付ける。開いた Accompany のページからは呼ばせない
function fromStartPage(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url;
  if (!url) return undefined;
  try {
    const { protocol, pathname } = new URL(url);
    if (protocol !== "file:" || decodeURIComponent(pathname) !== startPage) return undefined;
  } catch {
    return undefined;
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = states.get(event.sender.id);
  return win && state ? { win, state } : undefined;
}

ipcMain.handle("choose-folder", async (event) => {
  const target = fromStartPage(event);
  if (!target) return undefined;
  const result = await dialog.showOpenDialog(target.win, {
    title: "Accompany を始めるフォルダー",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});

ipcMain.handle("start-host", async (event, folder: unknown, portInput: unknown) => {
  const target = fromStartPage(event);
  if (!target) return { error: "開始画面からしか始められません" };
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return { error: "フォルダーを選んでください" };
  try {
    if (!statSync(folder).isDirectory()) return { error: `フォルダーではありません: ${folder}` };
  } catch {
    return { error: `フォルダーが見つかりません: ${folder}` };
  }
  const port = portInput === undefined || portInput === null || portInput === "" ? defaultPort : Number(portInput);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "ポートは 1〜65535 の整数で指定してください" };
  const { win, state } = target;
  try {
    const server = await startServer(folder, port, (message) => {
      if (win.isDestroyed()) return;
      state.origin = undefined;
      state.server = undefined;
      closeTrialGuests(win.webContents.id);
      showStartPage(win, message);
    });
    if (win.isDestroyed()) {
      void server.stop();
      return {};
    }
    state.server = server;
    state.origin = server.origin;
    const actual = Number(new URL(server.origin).port);
    state.portNote = actual === port ? undefined : `${port} は使用中`;
    await win.loadURL(`${server.origin}/`);
    return {};
  } catch (error) {
    return { error: (error as Error).message };
  }
});

ipcMain.handle("open-guest", async (event, input: unknown) => {
  const target = fromStartPage(event);
  if (!target) return { error: "開始画面からしか開けません" };
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    return { error: "URL の形ではありません（例: http://localhost:3000）" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "http か https の URL を入れてください" };
  // つながらないときに、開始画面を離れて空の画面にならないよう、先に確かめる
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    return { error: `${url.origin} につながりませんでした（${(error as Error).message}）` };
  }
  const { win, state } = target;
  state.origin = url.origin;
  try {
    await win.loadURL(url.href);
    return {};
  } catch (error) {
    state.origin = undefined;
    showStartPage(win, `${url.href} を開けませんでした（${(error as Error).message}）`);
    return {};
  }
});

// 通知とクリップボードだけを、そのウィンドウで開いている Accompany に許す。ほかの権限（カメラ・位置など）は与えない
const allowedPermissions = new Set(["notifications", "clipboard-read", "clipboard-sanitized-write"]);
function setPermissionHandlers(target: Session) {
  target.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowed(contents, permission, details.requestingUrl)),
  );
  target.setPermissionCheckHandler((contents, permission, requestingOrigin) => allowed(contents, permission, requestingOrigin));
}

// ゲストの URL は自由に入れられるので、Accompany 以外のサイトを開いてしまったときにクリップボードを読ませないよう、
// loopback（Live Share や SSH で転送された localhost）のオリジンに限る
function isLoopback(url: string) {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

// このアプリが起動したサーバーのページか（ホストのウィンドウと、その試しのゲスト）
function fromOwnServer(state: WindowState) {
  const hostState = state.trialGuestOf === undefined ? state : states.get(state.trialGuestOf);
  return hostState?.server !== undefined;
}

function allowed(contents: WebContents | null, permission: string, url: string) {
  if (!contents || !allowedPermissions.has(permission) || !isLoopback(url)) return false;
  const state = states.get(contents.id);
  if (!state || !sameOrigin(url, state.origin)) return false;
  // クリップボードの読み取りは、自分が起動したサーバーのページにだけ許す。ゲストで開いたページは、
  // ほかのマシン（Live Share のホスト）から来るので、こちらのクリップボードを読ませない。
  // 読めないときは、Accompany がキーボードでのペースト（⌘V）を案内する（pane.ts の paste）
  if (permission === "clipboard-read") return fromOwnServer(state);
  return true;
}

// ブラウザが予約していてページに届かなかったキー（⌘W・⌘T・⌘N・⌘R など）を、メニューで奪わずにページへ渡す。
// メニューの操作はマウスで選ぶ（当面ショートカットは割り当てない）。編集（⌘C・⌘V）と終了（⌘Q）などは macOS の標準のまま
function setMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "ファイル",
        submenu: [
          { label: "新しいウィンドウ", click: () => createWindow() },
          {
            label: "ゲストとして参加する（試し）",
            click: (_item, win) => win instanceof BrowserWindow && openTrialGuest(win),
          },
          {
            label: "URL をコピー",
            click: (_item, win) => {
              const origin = win instanceof BrowserWindow ? states.get(win.webContents.id)?.origin : undefined;
              if (origin) clipboard.writeText(`${origin}/`);
            },
          },
          { label: "開始画面に戻る", click: (_item, win) => win instanceof BrowserWindow && void backToStart(win) },
          { type: "separator" },
          { label: "ウィンドウを閉じる", click: (_item, win) => win?.close() },
        ],
      },
      { role: "editMenu" },
      {
        label: "表示",
        submenu: [
          { label: "再読み込み", click: (_item, win) => win instanceof BrowserWindow && win.webContents.reload() },
          { label: "開発者ツール", click: (_item, win) => win instanceof BrowserWindow && win.webContents.toggleDevTools() },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

// サーバーが止まってから開始画面に戻す。止まる前に同じポートで始め直すと、ポートがずれるため
async function backToStart(win: BrowserWindow) {
  const state = states.get(win.webContents.id);
  if (!state) return;
  const server = state.server;
  state.server = undefined;
  state.origin = undefined;
  state.portNote = undefined;
  closeTrialGuests(win.webContents.id);
  if (server) await stopServer(server);
  if (!win.isDestroyed()) showStartPage(win);
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // 既定では新しいウィンドウを開かせず、外のブラウザに回す。Accompany のウィンドウだけ createWindow で上書きする。
  // リンクのために作る見えない空のウィンドウから、さらにアプリの中でページを開かせないため
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
});

// 閉じる前に、起動したサーバーをすべて止める（画面の保存を待つ）
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  const servers = [...states.values()].flatMap((state) => (state.server ? [state.server] : []));
  servers.forEach((server) => void stopServer(server));
  if (stopping.size === 0) return;
  event.preventDefault();
  quitting = true;
  void Promise.allSettled([...stopping]).finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());

void app.whenReady().then(() => {
  setPermissionHandlers(session.defaultSession);
  if (process.platform === "darwin") app.dock?.setIcon(path.join(dist, "icon.png"));
  setMenu();
  // ログインシェルの読み込みは時間がかかることがあるので、ウィンドウを出すのと並べて始めておく
  void loadShellEnv();
  createWindow();
});
