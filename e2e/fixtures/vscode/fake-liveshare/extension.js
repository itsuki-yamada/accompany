// E2E で Live Share（ms-vsliveshare.vsliveshare）の代わりに入れる拡張。
// Accompany の拡張が vsls の getApi で受け取る API のうち、使う部分（セッション、shareServer、shareService、
// getSharedService）だけを真似る。本物の Live Share はサインインが要り、自動では確かめられないため（docs/adr/183-liveshare-extension.md）。
// 拡張が呼んだ API は FAKE_LIVESHARE_LOG のファイルに 1 行ずつ JSON で書き、テストが読む。
// ゲストとして参加したときに、ホストの共有サービスが返すポートは FAKE_LIVESHARE_HOST_PORT で渡す
const vscode = require("vscode");
const { appendFileSync } = require("node:fs");

const Role = { None: 0, Host: 1, Guest: 2 };
const user = { displayName: process.env.FAKE_LIVESHARE_NAME ?? "", emailAddress: null, userName: null, id: "fake" };

function log(entry) {
  if (process.env.FAKE_LIVESHARE_LOG) appendFileSync(process.env.FAKE_LIVESHARE_LOG, `${JSON.stringify(entry)}\n`);
}

function activate(context) {
  const sessionChanged = new vscode.EventEmitter();
  const availability = new vscode.EventEmitter();
  let session = { id: null, role: Role.None, user, peerNumber: 0, access: 0, presentationMode: false };
  const handlers = new Map();
  let available = false;

  const setSession = (role) => {
    session = { ...session, id: role === Role.None ? null : "fake-session", role };
    available = role !== Role.None;
    sessionChanged.fire({ session });
    availability.fire(available);
  };

  const api = {
    get session() {
      return session;
    },
    onDidChangeSession: sessionChanged.event,
    async shareServer(server) {
      log({ call: "shareServer", server });
      return new vscode.Disposable(() => log({ call: "unshareServer", server }));
    },
    async shareService(name) {
      log({ call: "shareService", name });
      return {
        get isServiceAvailable() {
          return available && session.role === Role.Host;
        },
        onDidChangeIsServiceAvailable: availability.event,
        onRequest: (method, handler) => handlers.set(`${name}/${method}`, handler),
        onNotify() {},
        notify() {},
      };
    },
    async unshareService(name) {
      log({ call: "unshareService", name });
    },
    async getSharedService(name) {
      log({ call: "getSharedService", name });
      return {
        get isServiceAvailable() {
          return available && session.role === Role.Guest;
        },
        onDidChangeIsServiceAvailable: availability.event,
        onNotify() {},
        notify() {},
        // ゲストとして参加したときは、ホストの共有サービスの代わりに、FAKE_LIVESHARE_HOST_PORT のポートを返す
        async request(method) {
          log({ call: "request", name, method });
          if (method === "info") return { port: Number(process.env.FAKE_LIVESHARE_HOST_PORT) };
          throw new Error(`知らない要求: ${method}`);
        },
      };
    },
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("fakeLiveShare.startHost", () => setSession(Role.Host)),
    vscode.commands.registerCommand("fakeLiveShare.joinAsGuest", () => setSession(Role.Guest)),
    vscode.commands.registerCommand("fakeLiveShare.end", () => setSession(Role.None)),
    // ゲストがホストの共有サービスに info を要求したときの代わり。ホストの拡張が登録した処理を呼び、結果を書く
    vscode.commands.registerCommand("fakeLiveShare.requestInfo", async () => {
      const handler = handlers.get("accompany/info");
      log({ call: "requestInfo", result: handler ? await handler([], undefined) : null });
    }),
  );
  return { getApi: async () => api };
}

module.exports = { activate };
