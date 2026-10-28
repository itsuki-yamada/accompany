import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as vscode from "vscode";
// vsls は、型と getApi だけを使う。getApi が実行時に読み込むのは vscode だけで、依存の
// @microsoft/servicehub-framework などは拡張に同梱しない（scripts/check-bundle.ts で確かめる。docs/adr/183-liveshare-extension.md）
import { getApi } from "vsls/vscode";
import type { LiveShare, Role, Session } from "vsls/vscode";

// Live Share を始めるだけで、VS Code の中（パネル）で Accompany を使えるようにする（docs/adr/183-liveshare-extension.md）。
// - ホスト: セッションが始まると Accompany を起動し、共有サーバー（shareServer）と共有サービス（shareService）で共有する。
//   終わると共有をやめ、Accompany を止める
// - ゲスト: ホストの共有サービスからポートを受け取り、Live Share が転送したポートの Accompany をパネルで開く
// どちらも、参加者の名前の既定を Live Share の表示名にする

// Role は enum の値なので、vsls の実行時のコードを使わずに同じ値を持つ
const roleNone = 0 as Role;
const roleHost = 1 as Role;
const roleGuest = 2 as Role;

const serviceName = "accompany";

const output = vscode.window.createOutputChannel("Accompany");
let sessions: Sessions | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const panel = new Panel();
  context.subscriptions.push(
    output,
    panel,
    vscode.commands.registerCommand("accompany.openPanel", () => panel.reveal()),
  );
  const liveShare = await getApi(context.extension.id);
  if (!liveShare) {
    output.appendLine("Live Share が入っていないか、拡張から使えないため、Live Share のセッションに合わせて動きません");
    return;
  }
  const current = new Sessions(liveShare, panel);
  sessions = current;
  context.subscriptions.push(liveShare.onDidChangeSession((event) => current.update(event.session)));
  await current.update(liveShare.session);
}

// Live Share のセッションの役割（ホスト・ゲスト・なし）に合わせて、Accompany を起動・共有・表示する
class Sessions {
  private role = roleNone;
  // セッションが変わるたびに増やし、待っている間にセッションが変わったら、古いセッションの続きを捨てる
  private generation = 0;
  private resources: { dispose(): unknown }[] = [];

  constructor(
    private liveShare: LiveShare,
    private panel: Panel,
  ) {}

  async update(session: Session) {
    const role = session.id ? session.role : roleNone;
    if (role === this.role) return;
    this.role = role;
    const generation = ++this.generation;
    await this.stop();
    const current = () => generation === this.generation;
    try {
      if (role === roleHost) await this.host(session, current);
      else if (role === roleGuest) await this.guest(session, current);
    } catch (error) {
      if (!current()) return;
      output.appendLine(String(error));
      void vscode.window.showErrorMessage(`Accompany: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async host(session: Session, current: () => boolean) {
    // 起動・共有を待っている間にセッションが終わったら、次の stop() はもう済んでいるので、得たものをすぐに手放す
    const keep = async <T extends { dispose(): unknown }>(resource: T) => {
      if (current()) {
        this.resources.push(resource);
        return resource;
      }
      await resource.dispose();
      throw new Error("セッションが終わったので、Accompany の共有をやめました");
    };
    const { port } = await keep(await startAccompany());
    await keep(await this.liveShare.shareServer({ port, displayName: "Accompany" }));
    // ゲストの拡張が、共有サービスに info を要求してポートを知る。共有サービスを使えないときは、
    // ゲストは Live Share の共有サーバーの一覧から開く
    const service = await this.liveShare.shareService(serviceName);
    if (service) {
      await keep({ dispose: () => this.liveShare.unshareService(serviceName) });
      service.onRequest("info", () => ({ port }));
    } else {
      output.appendLine("Live Share の共有サービスを使えないため、ゲストの拡張には Accompany のポートを伝えられません");
    }
    if (!current()) return;
    this.panel.open(`http://127.0.0.1:${port}/`, session.user?.displayName);
  }

  private async guest(session: Session, current: () => boolean) {
    const proxy = await this.liveShare.getSharedService(serviceName);
    if (!current()) return;
    if (!proxy) {
      output.appendLine("Live Share の共有サービスを使えないため、ホストの Accompany のポートが分かりません");
      return;
    }
    const open = async () => {
      if (!proxy.isServiceAvailable || !current()) return;
      const info = await proxy.request("info", []);
      const port = Number(info?.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ホストから受け取ったポートが正しくありません: ${info?.port}`);
      if (!current()) return;
      // Live Share は、ホストの共有サーバーを、ゲストの localhost の（空いていれば）同じポートに転送する
      this.panel.open(`http://localhost:${port}/`, session.user?.displayName);
    };
    // ホストが共有サービスを登録する前に参加したときは、使えるようになってから開く
    this.resources.push(
      proxy.onDidChangeIsServiceAvailable((available) => {
        if (available) open().catch((error) => output.appendLine(String(error)));
      }),
    );
    await open();
  }

  private async stop() {
    this.panel.close();
    const resources = this.resources.reverse();
    this.resources = [];
    for (const resource of resources) {
      try {
        await resource.dispose();
      } catch (error) {
        output.appendLine(String(error));
      }
    }
  }

  // VS Code を閉じるときに、共有をやめて Accompany を止める
  shutdown() {
    this.generation++;
    return this.stop();
  }
}

// ホストの Accompany。設定 accompany.path の実行ファイルを、空いているポート（--port 0）で起動する。
// 設定はワークスペースでは変えられない（scope: machine）。開いたフォルダーの設定で、任意のコマンドを起動させないため
async function startAccompany(): Promise<{ port: number; dispose(): Promise<void> }> {
  const command = vscode.workspace.getConfiguration("accompany").get<string>("path") || "accompany";
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === "file");
  const cwd = folder?.uri.fsPath ?? homedir();
  // --allow-vscode-webview: Accompany は既定でほかのページへの埋め込みを拒むので、webview の中に埋め込むことを許す
  // （0.23.1 から。docs/adr/185-frame-ancestors.md）
  const args = ["--port", "0", "--allow-vscode-webview"];
  output.appendLine(`起動します: ${command} ${args.join(" ")}（${cwd}）`);
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const dispose = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    // Accompany は止める前に画面を保存する（最大 3 秒）。それより長くかかるときは強制的に止める
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };
  const port = await new Promise<number>((resolve, reject) => {
    // URL を読むまでの出力だけを溜める
    let text: string | undefined = "";
    const onData = (chunk: Buffer) => {
      output.append(chunk.toString());
      if (text === undefined) return;
      text += chunk.toString();
      const url = text.match(/Accompany: (http:\/\/\S+)/)?.[1];
      if (!url) return;
      // Accompany はホストの外に開かない。loopback 以外で待ち受けていたら、共有せずに止める
      text = undefined;
      const { hostname, port } = new URL(url);
      if (hostname !== "127.0.0.1" && hostname !== "[::1]") {
        void dispose();
        reject(new Error(`Accompany が loopback 以外（${hostname}）で待ち受けているので、共有しません`));
        return;
      }
      resolve(Number(port));
    };
    child.stdout.on("data", onData);
    // 待ち受ける前に終了したときに、理由を知らせるため、URL を読むまでのエラー出力を溜める
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output.append(chunk.toString());
      if (text !== undefined) errors += chunk.toString();
    });
    child.once("error", (error) =>
      reject(
        new Error(
          `${command} を起動できませんでした（${error.message}）。Accompany を入れるか、設定 accompany.path で実行ファイルを指定してください`,
        ),
      ),
    );
    child.once("exit", (code) => {
      // 0.23.0 までの Accompany は --allow-vscode-webview を知らず、知らないオプションとして終了する
      if (/--allow-vscode-webview/.test(errors) && /知らないオプション|Unknown option/.test(errors)) {
        reject(new Error(`Accompany が古いため起動できませんでした。Accompany を 0.23.1 以上に上げてください（${command}）`));
        return;
      }
      reject(new Error(`Accompany が待ち受ける前に終了しました（終了コード ${code}）。出力パネルの「Accompany」に理由が出ています`));
    });
  });
  return { port, dispose };
}

// Accompany を開くパネル（webview）。webview の中の iframe で Accompany のページを開く
class Panel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private url: string | undefined;

  open(base: string, name?: string) {
    const url = new URL(base);
    if (name) url.searchParams.set("name", name);
    this.url = url.toString();
    // 開いているパネルは、新しい URL で開き直す
    if (this.panel) this.panel.webview.html = html(this.url);
    this.reveal();
  }

  reveal() {
    if (!this.url) {
      void vscode.window.showInformationMessage("Accompany: Live Share のセッション中に開けます");
      return;
    }
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "accompany",
      "Accompany",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // 隠したときに作り直すと、Accompany のページを開き直してしまう
      // 拡張のファイルは読ませない（localResourceRoots: []）
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    panel.webview.html = html(this.url);
    // Accompany のページはクリップボードの許可がないので、コピーした文字を webview 経由で受け取って書き込む
    panel.webview.onDidReceiveMessage((message: unknown) => {
      const { type, text } = (message ?? {}) as { type?: unknown; text?: unknown };
      if (type === "clipboard.write" && typeof text === "string" && text.length <= maxClipboardLength) {
        void vscode.env.clipboard.writeText(text);
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    this.panel = panel;
  }

  close() {
    this.url = undefined;
    this.panel?.dispose();
    this.panel = undefined;
  }

  dispose() {
    this.close();
  }
}

// webview の中身。CSP で、読み込めるのを Accompany の iframe と、この中のスクリプト・スタイルだけにする。
// VS Code は localhost のページにクリップボードの許可を与えないので、Accompany はコピーした文字を postMessage で
// この webview に渡す。webview は、開いた iframe の Accompany からのもので、利用者の操作の直後（一時的なユーザー
// アクティベーション）の、長すぎないものだけを拡張に渡す。ゲストのパネルに出るのはホストが配るページなので、
// 利用者の操作なしに、ゲストのクリップボードを書き換えさせないため。
// iframe には allow でクリップボードの権限を渡さない。書き込みは webview を経由し、読み取りは渡さない
// （VS Code の扱いが変わったときに、ホストのページからゲストのクリップボードを読めるようにしないため）
function html(url: string) {
  const nonce = randomBytes(16).toString("base64");
  const origin = new URL(url).origin;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escapeHtml(origin)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe src="${escapeHtml(url)}" title="Accompany"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const origin = ${JSON.stringify(origin).replace(/</g, "\\u003c")};
const frame = document.querySelector("iframe");
// パネルにフォーカスが来たら、キー入力が Accompany に届くよう、iframe にフォーカスを移す
window.addEventListener("focus", () => frame.focus());
frame.focus();
window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== origin) return;
  const { type, text } = event.data ?? {};
  if (type !== "accompany.clipboard.write" || typeof text !== "string" || text.length > ${maxClipboardLength}) return;
  if (!navigator.userActivation?.isActive) return;
  vscode.postMessage({ type: "clipboard.write", text });
});
</script>
</body>
</html>`;
}

// webview 経由でクリップボードに書き込む文字数（UTF-16 の単位）の上限。直前の出力のコピーなどの大きなものも収まる長さにする。
// Accompany のページ（app/server/src/public/clipboard.ts の maxWebviewClipboardLength）も同じ上限で、超えたら頼まずに知らせる
const maxClipboardLength = 10_000_000;

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function deactivate() {
  return sessions?.shutdown();
}
