// ターミナルで動いているエージェントの状態。判定の規則は docs/adr/28-agent-status.md
export type AgentStatus = "working" | "idle";

// 入力からこの時間内の出力は、入力の表示（エコー）とみなして数えない
const echoMs = 200;
// 数える出力がこの時間続いたら作業中
const workingAfterMs = 1000;
// 出力がこの時間途切れたら入力待ち
const idleAfterMs = 2000;

// PTY の入出力の続き方から、エージェントが作業中か入力待ちかを判定する
export class ActivityMonitor {
  status: AgentStatus = "idle";
  private lastInput = 0;
  // 参加者が入力してから、出力が途切れるまでの間だけ判定する
  private armed = false;
  private burstStart: number | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private onChange: (status: AgentStatus) => void) {}

  input() {
    this.lastInput = Date.now();
    this.armed = true;
  }

  output() {
    const now = Date.now();
    if (!this.armed || now - this.lastInput < echoMs) return;
    this.burstStart ??= now;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.settle(), idleAfterMs);
    if (this.status === "idle" && now - this.burstStart >= workingAfterMs) this.set("working");
  }

  dispose() {
    clearTimeout(this.idleTimer);
  }

  private settle() {
    this.armed = false;
    this.burstStart = undefined;
    this.set("idle");
  }

  private set(status: AgentStatus) {
    if (this.status === status) return;
    this.status = status;
    this.onChange(status);
  }
}
