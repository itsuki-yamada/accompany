// 開始画面（file://）だけに、ホストで始める・ゲストで開くための呼び出しを渡す。
// 開いた Accompany のページ（http://）には何も渡さない
import { contextBridge, ipcRenderer } from "electron";

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("accompany", {
    chooseFolder: (): Promise<string | undefined> => ipcRenderer.invoke("choose-folder"),
    startHost: (folder: string, port?: number): Promise<{ error?: string }> =>
      ipcRenderer.invoke("start-host", folder, port),
    openGuest: (url: string): Promise<{ error?: string }> => ipcRenderer.invoke("open-guest", url),
  });
}
