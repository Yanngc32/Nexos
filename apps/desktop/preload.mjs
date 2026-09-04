import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("nexo", {
  daemonInfo: () => ipcRenderer.invoke("daemon:info"),
  startDaemon: () => ipcRenderer.invoke("daemon:start"),
  stopDaemon: () => ipcRenderer.invoke("daemon:stop"),
  openLogin: (id) => ipcRenderer.invoke("profile:login", id),
  openExternal: (url) => ipcRenderer.invoke("shell:external", url),
  clearBrowserCache: (url) => ipcRenderer.invoke("browser:clear-cache", url),
  pickFolder: () => ipcRenderer.invoke("folder:pick"),
  setProject: (path) => ipcRenderer.invoke("project:set", path),
  cwd: () => ipcRenderer.invoke("project:cwd"),
  listDir: (rel) => ipcRenderer.invoke("fs:list", rel),
  readFile: (rel) => ipcRenderer.invoke("fs:read", rel),
  runCommand: (command) => ipcRenderer.invoke("shell:run", command),
  saveFile: (name, content) => ipcRenderer.invoke("file:save", { name, content }),
  killCommand: () => ipcRenderer.invoke("shell:kill"),
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
