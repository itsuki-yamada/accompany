// ターミナルで動いているエージェントの状態。判定の規則は docs/adr/28-agent-status.md。
// エージェントが前面にいるときだけ判定する（docs/adr/70-agent-detection.md）
export type AgentStatus = "working" | "idle";

// 入力からこの時間内の出力は、入力の表示（エコー）とみなして数えない
const echoMs = 200;
// 数える出力がこの時間続いたら作業中
const workingAfterMs = 1000;
// 出力がこの時間途切れたら指示待ち。入力からこの時間内に出力が出始めなければ、その入力では判定しない
const idleAfterMs = 2000;

// 端末の制御シーケンス。ブラウザの端末が問い合わせに自動で返す応答（OSC 11、DA など）や、
// フォーカス（CSI I / O）・マウスの報告は、このどれかだけでできている
// - X10 形式のマウスの報告（CSI M のあとに 3 バイトの座標が続く）
// - CSI
// - SS3（アプリケーションカーソルモードの矢印キー ESC O A、F1〜F4 の ESC O P など）
// - OSC・DCS・APC・PM・SOS（BEL か ST で終わる）
const controlSequences = /\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -\/]*[@-~]|\x1bO[\s\S]|\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)/g;

// 参加者が打ったものか。表示できる文字か CR を含むものだけを数える
function isTyped(data: string) {
  return /[\r\x20-\x7e\u00a0-\uffff]/.test(data.replace(controlSequences, ""));
}

// PTY の入出力の続き方から、エージェントが作業中か指示待ちかを判定する
export class ActivityMonitor {
  status: AgentStatus = "idle";
  private lastInput = 0;
  // 数える出力が出始めた時刻。出力が途切れたら消す
  private burstStart: number | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  // ターミナルを閉じたあとに届いた出力で、タイマーを作り直さない
  private disposed = false;

  constructor(private onChange: (status: AgentStatus) => void) {}

  input(data: string) {
    if (!isTyped(data)) return;
    this.lastInput = Date.now();
  }

  output() {
    const now = Date.now();
    if (this.disposed || now - this.lastInput < echoMs) return;
    // 参加者の入力のあとに出始めた出力だけを数える。起動直後の描画や、入力と関係なく出る出力は数えない
    if (this.burstStart === undefined && now - this.lastInput > idleAfterMs) return;
    this.burstStart ??= now;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.settle(), idleAfterMs);
    if (this.status === "idle" && now - this.burstStart >= workingAfterMs) this.set("working");
  }

  // エージェントが前面になったときに、それまでの入出力を忘れて指示待ちから判定し直す。
  // シェルから起動したときの、起動の描画（とそのきっかけの Enter）を作業と数えないため。状態の変化は知らせない
  reset() {
    clearTimeout(this.idleTimer);
    this.lastInput = 0;
    this.burstStart = undefined;
    this.status = "idle";
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.idleTimer);
  }

  private settle() {
    this.burstStart = undefined;
    this.set("idle");
  }

  private set(status: AgentStatus) {
    if (this.status === status) return;
    this.status = status;
    this.onChange(status);
  }
}
