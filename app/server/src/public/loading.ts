// 開いてから使えるようになるまでの読み込み中の表示と、サーバーとの接続が切れたときの表示（docs/adr/111-loading.md）。
// 読み込み中の表示は、JS を読み込む前から出せるよう HTML に置いてある
const loading = document.getElementById("loading");

// 読み込み中の表示を消す。一度消したら、もう出さない
export function finishLoading() {
  loading?.remove();
}

// 接続が切れたことを出す。切れる前の画面はそのまま見られるよう、画面の上に帯で出す。
// つなぎ直しは、そのページを開いている人が再読み込みして行う（自動では開き直さない）
export function showDisconnected() {
  finishLoading();
  if (document.getElementById("disconnected")) return;
  const notice = document.createElement("div");
  notice.id = "disconnected";
  notice.setAttribute("role", "alert");
  notice.textContent = "Accompany との接続が切れました";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "再読み込み";
  reload.addEventListener("click", () => location.reload());
  notice.append(reload);
  document.body.append(notice);
}
