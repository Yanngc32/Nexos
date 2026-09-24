const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nexo", {
  daemonInfo: () => ipcRenderer.invoke("daemon:info"),
  startDaemon: () => ipcRenderer.invoke("daemon:start"),
  stopDaemon: () => ipcRenderer.invoke("daemon:stop"),
  // motor travado: reinicia (PID confirmado) ou, com `forcar`, mata o PID na mão
  destravarMotor: (opts) => ipcRenderer.invoke("daemon:destravar", opts),
  openLogin: (id) => ipcRenderer.invoke("profile:login", id),
  toggleWidget: () => ipcRenderer.invoke("widget:toggle"),
  // painel de borda (painel.js) e as Configurações dele (renderer.js)
  painelPrefs: () => ipcRenderer.invoke("painel:prefs"),
  setPainelPrefs: (patch) => ipcRenderer.invoke("painel:prefs:set", patch),
  painelMonitores: () => ipcRenderer.invoke("painel:monitores"),
  painelAreas: (areas) => ipcRenderer.invoke("painel:areas", areas),
  painelArrastar: (on) => ipcRenderer.invoke("painel:arrastar", on),
  painelAbrir: (alvo) => ipcRenderer.invoke("painel:abrir", alvo),
  painelConfig: () => ipcRenderer.invoke("painel:config"),
  painelNotificar: (n) => ipcRenderer.invoke("painel:notificar", n),
  threadVista: (threadId) => ipcRenderer.invoke("thread:vista", threadId),
  /** Eventos do main pro painel/janela: painel:hover, painel:lugar, painel:prefs, painel:vista, painel:abrir, nexo:config. */
  onPainel: (canal, fn) => {
    if (!/^(painel:(hover|lugar|prefs|vista|abrir)|nexo:config)$/.test(canal)) return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(canal, h);
    return () => ipcRenderer.removeListener(canal, h);
  },
  openExternal: (url) => ipcRenderer.invoke("shell:external", url),
  revealPath: (path) => ipcRenderer.invoke("shell:reveal", path),
  clearBrowserCache: (url) => ipcRenderer.invoke("browser:clear-cache", url),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  setProject: (path) => ipcRenderer.invoke("project:set", path),
  cwd: () => ipcRenderer.invoke("project:cwd"),
  listDir: (rel) => ipcRenderer.invoke("fs:list", rel),
  readFile: (rel) => ipcRenderer.invoke("fs:read", rel),
  runCommand: (command) => ipcRenderer.invoke("shell:run", command),
  saveFile: (name, content) => ipcRenderer.invoke("file:save", { name, content }),
  pickZipBase64: () => ipcRenderer.invoke("file:pickZipBase64"),
  pickImageBase64: () => ipcRenderer.invoke("file:pickImageBase64"),
  printDoDs: (args) => ipcRenderer.invoke("ds:print", args),
  killCommand: () => ipcRenderer.invoke("shell:kill"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  updateReady: () => ipcRenderer.invoke("update:status"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  appVersion: () => ipcRenderer.invoke("app:version"),
  appChangelog: () => ipcRenderer.invoke("app:changelog"),
  onUpdateStatus: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on("update:status", h);
    return () => ipcRenderer.removeListener("update:status", h);
  },
  onShellData: (fn) => {
    const h = (_e, text) => fn(text);
    ipcRenderer.on("shell:data", h);
    return () => ipcRenderer.removeListener("shell:data", h);
  },
  onShellExit: (fn) => {
    const h = (_e, code) => fn(code);
    ipcRenderer.on("shell:exit", h);
    return () => ipcRenderer.removeListener("shell:exit", h);
  },
  onFrameFail: (fn) => {
    const h = (_e, info) => fn(info);
    ipcRenderer.on("frame:fail", h);
    return () => ipcRenderer.removeListener("frame:fail", h);
  },
  onMod: (fn) => {
    const h = (_e, id) => fn(id);
    ipcRenderer.on("nexo:mod", h);
    return () => ipcRenderer.removeListener("nexo:mod", h);
  },
});
