// エージェントの作業が終わったことを、ブラウザの通知で知らせる。条件は docs/adr/28-agent-status.md

const supported = () => "Notification" in window;

// ページを開いただけでは許可を求めず、最初に操作したとき（クリックやキー入力）に 1 回だけ求める
export function requestPermissionOnFirstInteraction() {
  if (!supported() || Notification.permission !== "default") return;
  const events = ["pointerdown", "keydown"] as const;
  const ask = () => {
    events.forEach((type) => window.removeEventListener(type, ask, true));
    void Notification.requestPermission();
  };
  events.forEach((type) => window.addEventListener(type, ask, true));
}

// 許可されていなければ何もしない。クリックされたら onClick を呼ぶ
export function notifyDone(title: string, onClick: () => void) {
  if (!supported() || Notification.permission !== "granted") return;
  const notification = new Notification(title, { body: "エージェントの作業が終わりました" });
  notification.onclick = () => {
    window.focus();
    onClick();
    notification.close();
  };
}
