import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { Subprocess } from "bun";
import { ActivityMonitor, type AgentStatus } from "./activity";
import { type Foreground, foregroundOf, isAgentCommand } from "./agent-detect";
import { CommandMarks, type CommandMarksState } from "./command-marks";
import { processCwd } from "./process-cwd";
import { scrollback } from "./scrollback";
import { TrimmedLines } from "./trimmed-lines";

export type Size = { cols: number; rows: number };

// 端末の大きさの上限。大きすぎる値が届くと（改造したブラウザや、1 文字の大きさを小さく測る不具合など）、
// 全員の端末とサーバー側の画面がその大きさになりうる。フル HD を最小のフォント（8px）で埋めても収まる大きさで切り詰める
// （docs/adr/51-largest-size.md、docs/adr/99-smallest-size.md）
export const maxSize: Size = { cols: 512, rows: 256 };

export function clampSize({ cols, rows }: Size): Size {
  return { cols: Math.min(cols, maxSize.cols), rows: Math.min(rows, maxSize.rows) };
}

// ブラウザに送るもの。出力と端末の大きさの変更は、この順番どおりに届ける。
// trimmed は、つないだときに送る画面の書き出しより前に、スクロールバックから押し出されていた行の数（docs/adr/94-remote-selection.md）
export type Message =
  | { type: "output"; data: Uint8Array }
  | { type: "resize"; size: Size }
  | { type: "trimmed"; lines: number }
  // つないだときに送る、シェルの統合（OSC 133）で覚えた直前のコマンドの出力の範囲（docs/adr/112-copy-last-output.md）
  | ({ type: "marks" } & CommandMarksState)
  // つないだときの画面を送り終えた。画面が空のときは output を送らないので、ブラウザはこれで読み込みを終えたと分かる
  // （docs/adr/111-loading.md）
  | { type: "restored" };
type Listener = (message: Message) => void;

// 参加者のブラウザから届く大きさ。fits は表示領域（フル HD までとみなす）に収まる大きさ、
// min は下限のウィンドウで開いたときの表示領域に収まる大きさ（docs/adr/99-smallest-size.md）。
// 下限を送らない（#99 より前の）ブラウザは min がない
export type Requested = { fits: Size; min?: Size };

export type Participant = {
  resize: (requested: Requested) => void;
  detach: () => void;
};

const encoder = new TextEncoder();

// 戻したスクロールバックと、新しく起動したコマンドの出力の境目に出す区切り（docs/adr/34-session-restore.md）
export const restartedMark = "── Accompany を再起動しました ──";

// 入出力があってから、この時間を置いて前面のプロセスを調べる。出力のたびには調べない（docs/adr/70-agent-detection.md）
const detectDelayMs = 500;

// 保存のためにカレントディレクトリを調べるのを待つ上限。止めるときの保存（最大 3 秒待つ）に収まるようにする
const cwdLookupTimeoutMs = 1500;
// Enter を押してからシェルが cd し終えるまでの間に調べると、前のディレクトリが返る。調べ始める前のこの時間までに入力があれば、
// 調べ終えたあとも、調べ直すべきものとして残す
const cwdSettleMs = 200;

// 閉じるときに SIGHUP を送ってから、コマンドと前面のコマンドが終わるのを待つ上限（前面のプロセスグループを調べる時間を含む）。
// 止めるときの保存（最大 3 秒待つ）のあとに待つので、止まるまでは最大でおよそ 4 秒になる（docs/adr/197-sighup-on-close.md）
const hangUpWaitMs = 1000;
// 閉じるときに前面のプロセスグループを調べるのを待つ上限
const foregroundLookupTimeoutMs = 500;

// プロセスグループに、まだプロセスがいるか
function groupExists(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // 権限がない（EPERM）ときも、いるものとする
    return (error as { code?: unknown }).code === "EPERM";
  }
}

// 再起動の前のサーバー側の画面。大きさは、書き出したときの端末の大きさ
export type Restored = Size & { scrollback: string };

// サーバー上でコマンドを PTY 付きで動かし、入出力をつながっているブラウザと共有する
export class TerminalSession {
  private proc: Subprocess | undefined;
  private listeners = new Set<Listener>();
  // 端末の大きさは、参加者のうち一番小さい表示領域に合わせる。ページを見ていない参加者も含める。
  // 下限より表示領域の小さい参加者は、はみ出した部分をスクロールするか、縮小して見る（docs/adr/99-smallest-size.md）
  private size: Size = { cols: 80, rows: 24 };
  private requestedSizes = new Map<Listener, Requested>();
  // 途中から参加したブラウザに現在の画面を送るため、PTY の出力をサーバー側の端末にも反映しておく
  private screen = new Terminal({ ...this.size, scrollback, allowProposedApi: true });
  private serializer = new SerializeAddon();
  private trimmed = new TrimmedLines(this.screen);
  // 書き出した画面には OSC 133 の印が含まれないため、サーバー側の画面でも直前のコマンドの出力の範囲を覚えておく
  private marks = new CommandMarks(this.screen, this.trimmed);
  // 書き出した画面にはカーソルの表示・非表示が含まれないため、DECTCEM（CSI ? 25 h/l）を見て自分で追う
  private cursorHidden = false;
  // 書き出した画面にはマウスの報告の形式も含まれないため、SGR 形式（CSI ? 1006 h/l、ピクセル単位は 1016）を見て自分で追う。
  // 戻さないと、途中から参加した人のブラウザは従来の形式で報告し（xterm.js はそれを onData ではなく onBinary で出す）、
  // Claude Code などにドラッグやクリックが届かない（docs/adr/94-remote-selection.md）
  private mouseEncoding: 1006 | 1016 | undefined;
  // コマンドが OSC 0 / OSC 2 で設定したタイトル。ブラウザに出す前に sanitizeTitle で整える
  title = "";
  private activity: ActivityMonitor;
  private onOutput: () => void;
  private onStatus: () => void;
  // 前面のプロセスグループと、それがエージェントか。調べるまでは、エージェントが動いていないとみなす
  private foreground: Foreground | undefined;
  private tty: string | undefined;
  private detectTimer: ReturnType<typeof setTimeout> | undefined;
  private detecting = false;
  // 調べている最中に入出力があった。調べ終えたら調べ直す（最中に前面が替わったかもしれないので）
  private detectAgain = false;
  private killed = false;
  private hangingUp: Promise<void> | undefined;
  // 作業が終わってから、まだ誰も見ていない（docs/adr/74-unseen-done.md）。保存はしない
  private unseen = false;
  private startDir: string | undefined;
  // 保存のために最後に調べたカレントディレクトリ、調べ始めた時刻と、そのとき前面だったプロセスグループ。
  // 最後に入力があった時刻と比べて、調べ直すか決める（docs/adr/151-restore-cwd.md）
  private lastCwd: string | undefined;
  private cwdCheckedAt = Number.NEGATIVE_INFINITY;
  private cwdPgid: number | undefined;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  // 起動時のコマンドが、エージェントとみなす名前のものか（docs/adr/90-startup-agent.md）
  private startedAsAgent: boolean;

  constructor(
    private command: string[],
    // コマンドが終了したとき（シェルの exit など）に呼ぶ
    private onExit: () => void = () => {},
    // タイトルが変わったときに呼ぶ
    private onTitleChange: () => void = () => {},
    // エージェントの状態（作業中・指示待ち）が変わったとき、エージェントが動き始めた・終わったときに呼ぶ
    onStatus: () => void = () => {},
    {
      // 再起動の前の画面。コマンドを起動する前にサーバー側の画面に書き、その下に区切りを出す
      restored,
      // コマンドが出力したときに呼ぶ（保存のきっかけにする）
      onOutput = () => {},
      // コマンドを起動するディレクトリ。省略したときや、起動できなかったときは Accompany を起動したディレクトリ
      cwd,
    }: { restored?: Restored; onOutput?: () => void; cwd?: string } = {},
  ) {
    this.startDir = cwd;
    this.startedAsAgent = isAgentCommand(command.join(" "));
    this.lastCwd = cwd;
    this.onOutput = onOutput;
    this.onStatus = onStatus;
    // エージェントが前面にいないときの判定の変化は知らせない。作業中から指示待ちに変わったら、誰かが見るまで未確認にする
    this.activity = new ActivityMonitor((status) => {
      this.unseen = status === "idle";
      if (this.foreground?.agent) onStatus();
    });
    this.screen.loadAddon(this.serializer);
    if (restored) {
      this.size = { cols: restored.cols, rows: restored.rows };
      this.screen.resize(restored.cols, restored.rows);
      this.screen.write(`${restored.scrollback}\x1b[0m\r\n\x1b[2m${restartedMark}\x1b[0m\r\n`);
    }
    this.screen.onTitleChange((title) => {
      const sanitized = sanitizeTitle(title);
      if (sanitized === this.title) return;
      this.title = sanitized;
      this.onTitleChange();
    });
    for (const [final, enabled] of [["h", true], ["l", false]] as const) {
      this.screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) this.cursorHidden = !enabled;
        for (const mode of [1006, 1016] as const) {
          if (params.includes(mode)) this.mouseEncoding = enabled ? mode : undefined;
        }
        return false;
      });
    }
    // RIS（ESC c）でカーソルも表示に戻る。xterm.js は RIS でタイトルの変更を知らせないので、
    // コマンドが残したタイトルもここで消す（docs/adr/33-context-menu.md）
    this.screen.parser.registerEscHandler({ final: "c" }, () => {
      this.cursorHidden = false;
      this.mouseEncoding = undefined;
      if (this.title !== "") {
        this.title = "";
        this.onTitleChange();
      }
      return false;
    });
  }

  attach(listener: Listener): Participant {
    // サーバー側の端末は書き込みを非同期に処理する。ここまでの出力を反映し終えてから画面を書き出し、
    // それまでに届いたものは書き出した画面に含まれないので、ためておいて画面のあとに送る
    const pending: Message[] = [];
    let restored = false;
    const receive: Listener = (message) => (restored ? listener(message) : pending.push(message));
    this.listeners.add(receive);
    this.screen.write("", () => {
      listener({ type: "resize", size: this.size });
      listener({ type: "trimmed", lines: this.trimmed.count });
      listener({ type: "marks", ...this.marks.state() });
      const snapshot =
        this.serializer.serialize() +
        (this.cursorHidden ? "\x1b[?25l" : "") +
        (this.mouseEncoding ? `\x1b[?${this.mouseEncoding}h` : "");
      if (snapshot) listener({ type: "output", data: encoder.encode(snapshot) });
      listener({ type: "restored" });
      pending.forEach(listener);
      restored = true;
    });

    // 起動直後の出力を取りこぼさないよう、最初にブラウザがつながったときに起動する
    if (!this.proc) {
      this.proc = this.spawn((cwd) =>
        Bun.spawn(this.command, {
          cwd,
          terminal: {
            ...this.size,
            data: (_terminal, data) => {
              this.screen.write(data);
              this.activity.output();
              this.scheduleDetect();
              this.broadcast({ type: "output", data });
              this.onOutput();
            },
          },
        }),
      );
      this.proc.exited.then(() => this.onExit());
    }

    return {
      resize: (requested) => {
        this.requestedSizes.set(receive, requested);
        this.fitToSmallest();
      },
      detach: () => {
        this.listeners.delete(receive);
        this.requestedSizes.delete(receive);
        this.fitToSmallest();
      },
    };
  }

  // 調べてから起動するまでの間に、起動するディレクトリが消えていることがある。そのときは Bun.spawn が例外を投げるので、
  // Accompany を起動したディレクトリで起動し直す（docs/adr/109-inherit-cwd.md）
  private spawn(start: (cwd?: string) => Subprocess) {
    if (this.startDir) {
      try {
        return start(this.startDir);
      } catch {}
    }
    return start();
  }

  // 分割や新しいタブで、続きのシェルを始めるディレクトリ。前面のプロセス（なければコマンド自身）のカレントディレクトリで、
  // 分からなければ undefined。まだ起動していなければ、起動するディレクトリ（docs/adr/109-inherit-cwd.md）
  async cwd() {
    const pid = this.proc?.pid;
    if (pid === undefined) return this.startDir;
    // 前面のプロセスグループの番号は、そのグループのリーダーのプロセスの番号
    const found = await foregroundOf(pid, this.tty);
    return (found && (await processCwd(found.foreground.pgid))) ?? (await processCwd(pid));
  }

  // 保存するカレントディレクトリ。保存のたびに ps と lsof を動かさないよう、ふだんは前に調べてから入力があったときだけ調べ直す
  // （cd は入力して動かすので）。ただし、前に調べたときと同じエージェントが前面にいる間は、入力（エージェントへの指示）があっても
  // 調べ直さない。止めるとき（refresh）は、入力がなくても前面のコマンドが終わっているかもしれないので必ず調べる。
  // 調べるのは cwdLookupTimeoutMs までで、調べられなければ前に調べたものを使う。まだ起動していなければ、起動するディレクトリ
  async savedCwd({ refresh = false } = {}) {
    if (this.proc === undefined) return this.lastCwd;
    if (!refresh) {
      const inputSinceCheck = this.lastInputAt >= this.cwdCheckedAt - cwdSettleMs;
      const sameAgent = this.foreground?.agent === true && this.foreground.pgid === this.cwdPgid;
      if (!inputSinceCheck || sameAgent) return this.lastCwd;
    }
    this.cwdCheckedAt = performance.now();
    this.cwdPgid = this.foreground?.pgid;
    const found = await Promise.race([this.cwd(), Bun.sleep(cwdLookupTimeoutMs).then(() => undefined)]);
    if (found) this.lastCwd = found;
    return this.lastCwd;
  }

  write(data: string) {
    this.lastInputAt = performance.now();
    this.activity.input(data);
    this.scheduleDetect();
    this.proc?.terminal?.write(data);
  }

  // TUI が残したモード（マウスの報告など）を戻す。モードは参加者全員とサーバー側の画面が共有している状態なので、
  // RIS（ESC c）を出力の流れに混ぜて、出力と同じ順番で全員とサーバー側の画面に届ける。コマンドには何も送らない
  reset() {
    const data = encoder.encode("\x1bc");
    this.screen.write(data);
    this.broadcast({ type: "output", data });
  }

  // 保存するために、ここまでの出力を反映し終えた画面を書き出す。新しく起動するコマンドのために、
  // 代替画面（全画面の TUI が使う）とモードは含めない
  snapshot(): Promise<Restored> {
    return new Promise((resolve) =>
      this.screen.write("", () =>
        resolve({
          ...this.size,
          scrollback: this.serializer.serialize({ excludeAltBuffer: true, excludeModes: true }),
        }),
      ),
    );
  }

  // エージェントの状態。エージェントが前面で動いていなければ undefined
  get status(): AgentStatus | undefined {
    if (!this.foreground?.agent) return undefined;
    return this.activity.status === "idle" && this.unseen ? "done" : this.activity.status;
  }

  // 誰かが見たので、未確認を消す。表示が変わった（未確認だった）なら true
  markSeen() {
    const changed = this.status === "done";
    this.unseen = false;
    return changed;
  }

  // ふつうの端末のウィンドウを閉じたときと同じように、コマンド（シェル）のプロセスグループと、前面のプロセスグループに
  // SIGHUP を送る。SIGKILL は送らないので、SIGHUP を無視するもの（nohup・disown）は残る。
  // 返す Promise は、コマンドと前面のプロセスグループが終わるか、hangUpWaitMs たつと解決する（docs/adr/197-sighup-on-close.md）
  kill(): Promise<void> {
    if (this.hangingUp) return this.hangingUp;
    this.killed = true;
    clearTimeout(this.detectTimer);
    this.activity.dispose();
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return (this.hangingUp = Promise.resolve());
    const deadline = Bun.sleep(hangUpWaitMs);
    this.hangingUp = (async () => {
      // 前面のプロセスグループは、送る前に調べる。シェルが先に終わると、端末の前面のプロセスグループが分からなくなるため。
      // 調べられなければ、最後に調べたものを使う
      const found = await Promise.race([foregroundOf(proc.pid, this.tty), Bun.sleep(foregroundLookupTimeoutMs)]);
      const foreground = found ? found.foreground.pgid : this.foreground?.pgid;
      // コマンドは PTY の別セッションのリーダーなので、プロセスグループの番号は pid と同じ
      const groups = [...new Set([proc.pid, foreground])].filter((g): g is number => g !== undefined && g > 1);
      for (const group of groups) {
        try {
          process.kill(-group, "SIGHUP");
        } catch {}
      }
      // 前面のコマンドが SIGHUP を無視して残っても、調べ続けないよう、上限が来たらやめる
      const others = groups.filter((g) => g !== proc.pid);
      let timedOut = false;
      const finished = (async () => {
        await proc.exited;
        while (!timedOut && others.some(groupExists)) await Bun.sleep(20);
      })();
      await Promise.race([finished, deadline]);
      timedOut = true;
    })();
    return this.hangingUp;
  }

  // 入出力のあとに間を置いて、前面のプロセスを調べる。調べる予定があるうちは重ねない。
  // 調べている最中の入出力は、調べ終えてから改めて予定を作る
  private scheduleDetect() {
    if (this.detecting) {
      this.detectAgain = true;
      return;
    }
    if (this.detectTimer || this.killed) return;
    this.detectTimer = setTimeout(() => {
      this.detectTimer = undefined;
      void this.detect();
    }, detectDelayMs);
  }

  private async detect() {
    const pid = this.proc?.pid;
    if (pid === undefined) return;
    this.detecting = true;
    this.detectAgain = false;
    let found: Awaited<ReturnType<typeof foregroundOf>>;
    try {
      found = await foregroundOf(pid, this.tty);
    } finally {
      this.detecting = false;
      if (this.detectAgain) this.scheduleDetect();
    }
    if (this.killed || !found) return;
    this.tty = found.tty;
    const previous = this.foreground;
    const next = found.foreground;
    this.foreground = next;
    if (!next.agent) {
      // エージェントが前面でなくなったら、未確認も消す（docs/adr/74-unseen-done.md）
      this.unseen = false;
      if (previous?.agent) this.onStatus();
      return;
    }
    // エージェントが前面になった（別のエージェントに替わった）ら、そこから判定を始める。
    // ただし起動時のコマンドがエージェントとみなす名前で、そのプロセスグループ（番号は pid と同じ）が前面なら、
    // シェルへの Enter で起動したものではないので、それまでの入出力を忘れない。見分ける前に出した最初の指示も数える。
    // シェルで exec claude と打ったときも pid は同じだが、起動時のコマンドはシェルなので忘れる（docs/adr/90-startup-agent.md）
    if (!previous?.agent || previous.pgid !== next.pgid) {
      if (!this.startedAsAgent || next.pgid !== pid) {
        this.activity.reset();
        this.unseen = false;
      }
      this.onStatus();
    }
  }

  // 向きごとに、一番小さい参加者に収まる大きさを、下限まで広げる。ただし一番大きい参加者に収まる大きさは超えない。
  // 下限は参加者ごとに列数・行数に直したもののうち一番小さいものを使う。下限を送らない参加者は、下限の計算から外す。
  // 誰も送っていなければ、下限なし（docs/adr/99-smallest-size.md）
  private fitToSmallest() {
    const requested = [...this.requestedSizes.values()];
    if (requested.length === 0) return;
    const fit = (key: keyof Size) => {
      const fits = requested.map((r) => r.fits[key]);
      const mins = requested.flatMap((r) => (r.min ? [r.min[key]] : []));
      const min = mins.length > 0 ? Math.min(...mins) : 0;
      return Math.min(Math.max(...fits), Math.max(Math.min(...fits), min));
    };
    const size = clampSize({ cols: fit("cols"), rows: fit("rows") });
    if (size.cols === this.size.cols && size.rows === this.size.rows) return;
    this.size = size;
    this.screen.resize(size.cols, size.rows);
    this.proc?.terminal?.resize(size.cols, size.rows);
    this.broadcast({ type: "resize", size });
  }

  private broadcast(message: Message) {
    this.listeners.forEach((l) => l(message));
  }
}

// タイトルとして出す長さの上限（文字数）。超えた部分は切り詰め、末尾に … を付ける
const maxTitleLength = 256;

// コマンドが設定したタイトルを、バーに出せる 1 行の文字列に整える。
// C0・C1 の制御文字はサーバー側の端末が OSC を読むときに取り除くが、念のためここでも取り除く。
// 双方向テキストの制御文字は表示を偽装できるので取り除き、改行にあたる文字は空白にする
export function sanitizeTitle(title: string) {
  const chars = [...singleLine(title)];
  return chars.length > maxTitleLength ? `${chars.slice(0, maxTitleLength - 1).join("")}…` : chars.join("");
}

// 改行にあたる文字を空白にし、制御文字と双方向テキストの制御文字を取り除く（参加者の名前にも使う）
export function singleLine(text: string) {
  return text
    .replace(/[\u2028\u2029\u0085]/g, " ")
    .replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
}
