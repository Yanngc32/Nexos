import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { nexoEntry, resolveNodeBin, resolveTsxCli, spawnNexoProcess } from "../daemon/scripts/resolve-tsx.mjs";

function isEpipe(err) {
  return Boolean(err && (err.code === "EPIPE" || /EPIPE/.test(String(err.message ?? ""))));
}

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err) => {
    if (!isEpipe(err)) throw err;
  });
}

process.on("uncaughtException", (err) => {
  if (isEpipe(err)) return;
  console.error(err);
});

process.on("unhandledRejection", (err) => {
  if (isEpipe(err)) return;
  console.error(err);
});

const here = dirname(fileURLToPath(import.meta.url));
const daemonRoot = join(here, "../daemon");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".next", "coverage", ".turbo", ".nexo-test"]);
const BIN_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|exe|dll|zip|gz|7z|rar|pdf|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|avi|node|wasm|bin|so|dylib|psd|sqlite3?)$/i;
const MAX_PREVIEW = 256 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

function nexoHome() {
  return process.env.NEXO_HOME ?? join(homedir(), ".nexo");
}

function tokenPath() {
  return join(nexoHome(), "daemon.token");
}

function configPath() {
  return join(nexoHome(), "config.json");
}

function readPort() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return Number(raw.port) || 7432;
  } catch {
    return 7432;
  }
}

function readAccentArg() {
  const argv = process.argv.slice(1);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--accent" && argv[i + 1]) return argv[i + 1];
    if (a.startsWith("--accent=")) return a.slice(9);
  }
  return "";
}

async function daemonInfo() {
  const port = readPort();
  const token = existsSync(tokenPath()) ? readFileSync(tokenPath(), "utf8").trim() : "";
  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    ok = res.ok;
  } catch {
    ok = false;
  }
  return { port, token, ok, home: nexoHome() };
}

/**
 * O motor roda no binário do Electron em modo Node (ELECTRON_RUN_AS_NODE).
 * Motivo: node.exe é console app e, com detached, o Windows abre um console vazio
 * (o windowsHide é ignorado nesse caso). O electron.exe é GUI, então não abre
 * console nenhum — e com detached o motor sobrevive ao fechar o app.
 */
function spawnNexo(args) {
  return spawnNexoProcess(args, {
    daemonRoot,
    nodeBin: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
}

function spawnNexoLogin(id) {
  const slug = String(id ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, error: "perfil inválido" };
  try {
    const node = resolveNodeBin();
    const tsx = resolveTsxCli(daemonRoot);
    const entry = nexoEntry(daemonRoot);
    if (process.platform === "win32") {
      const bat = join(tmpdir(), `nexo-login-${slug}.cmd`);
      writeFileSync(
        bat,
        [
          "@echo off",
          `cd /d "${daemonRoot}"`,
          `echo Nexo login  ${slug}`,
          `echo.`,
          `"${node}" "${tsx}" "${entry}" login ${slug}`,
          "if errorlevel 1 (",
          "  echo.",
          "  echo Login falhou. Le o erro acima.",
          "  pause",
          "  exit /b 1",
          ")",
          "echo.",
          "echo Pronto. Fecha esta janela e volta pro Nexo.",
          "pause",
        ].join("\r\n"),
        "utf8",
      );
      const child = spawn("cmd.exe", ["/c", "start", "Nexo login", bat], {
        cwd: daemonRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      return { ok: true };
    }
    spawnNexoProcess(["login", slug], { daemonRoot, detached: true, stdio: "inherit" }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

let win;
let tray;
let widget;
let projectRoot = "";
let shellChild = null;

function normPath(p) {
  return resolve(p).replace(/[/\\]+$/, "");
}

function insideProject(full) {
  if (!projectRoot) return false;
  const root = normPath(projectRoot).toLowerCase();
  const f = normPath(full).toLowerCase();
  return f === root || f.startsWith(root + sep) || f.startsWith(root + "/");
}

function boundPath(rel = ".") {
  if (!projectRoot) {
    const err = new Error("Sem projeto");
    err.code = "NO_PROJECT";
    throw err;
  }
  const root = existsSync(projectRoot) ? realpathSync(projectRoot) : resolve(projectRoot);
  const cleaned = String(rel ?? ".").replaceAll("\\", "/");
  if (!cleaned || cleaned === ".") {
    if (!insideProject(root)) throw new Error("Fora do projeto");
    return root;
  }
  const candidate = /^([a-zA-Z]:|\/)/.test(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  if (!insideProject(candidate)) throw new Error("Fora do projeto");
  if (!existsSync(candidate)) return candidate;
  const real = realpathSync(candidate);
  if (!insideProject(real)) throw new Error("Fora do projeto");
  return real;
}

function setProject(p) {
  projectRoot = p ? resolve(p) : "";
  if (shellChild) {
    shellChild.kill();
    shellChild = null;
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function toRel(full) {
  const root = normPath(projectRoot);
  const f = normPath(full);
  const rl = root.toLowerCase();
  const fl = f.toLowerCase();
  if (fl === rl) return ".";
  if (!fl.startsWith(rl + sep) && !fl.startsWith(rl + "/")) return ".";
  return f.slice(root.length).replace(/^[/\\]/, "").replaceAll("\\", "/");
}

/**
 * Modo screenshot (só dev): NEXO_SHOT=caminho.png abre a janela escondida,
 * espera NEXO_SHOT_WAIT ms, salva a imagem e sai. NEXO_SHOT_SIZE=1280x800 muda
 * o tamanho; NEXO_SHOT_JS=arquivo.js roda esse script no renderer antes do clique.
 */
/**
 * Identidade fixa do app. O package.json chama "@nexo/desktop", e o Electron
 * usava isso como pasta de userData ("Roaming\@nexo/desktop") — nome com barra,
 * caminho instável entre formas de abrir o app. Quando mudava, o localStorage
 * ia embora e o app parecia ter esquecido projetos e conversas.
 */
function fixAppIdentity() {
  const alvo = join(app.getPath("appData"), "Nexo");
  const antigos = [
    join(app.getPath("appData"), "@nexo", "desktop"),
    join(app.getPath("appData"), "Electron"),
  ];
  app.setName("Nexo");
  if (!existsSync(join(alvo, "Local Storage"))) {
    // primeira vez com o nome novo: puxa o estado do diretório antigo
    for (const velho of antigos) {
      if (!existsSync(join(velho, "Local Storage"))) continue;
      // copia arquivo por arquivo: se o perfil antigo estiver aberto, o LOCK
      // falha e o resto (o que interessa) ainda vai
      let copiados = 0;
      for (const rel of ["Local Storage", "Local Storage/leveldb"]) {
        const de = join(velho, rel);
        if (!existsSync(de)) continue;
        mkdirSync(join(alvo, rel), { recursive: true });
        for (const f of readdirSync(de, { withFileTypes: true })) {
          if (!f.isFile()) continue;
          try {
            cpSync(join(de, f.name), join(alvo, rel, f.name));
            copiados += 1;
          } catch {
            /* arquivo travado pelo app antigo: segue */
          }
        }
      }
      console.log("[nexo] userData migrado de", velho, "| arquivos:", copiados);
      break;
    }
  }
  app.setPath("userData", alvo);
}

fixAppIdentity();

const SHOT = process.env.NEXO_SHOT ?? "";

// silencia o ruído do Chromium (INFO/WARNING/"Hit debug scenario") no stderr
if (!process.env.NEXO_VERBOSE) app.commandLine.appendSwitch("log-level", "3");

/** Sobe o motor sem janela se ele não estiver de pé. */
async function ensureDaemon(timeoutMs = 15_000) {
  const info = await daemonInfo();
  if (info.ok) return true;
  spawnNexo(["up"]).unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if ((await daemonInfo()).ok) return true;
  }
  return false;
}

function shotSize() {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(process.env.NEXO_SHOT_SIZE ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
}

async function runShot(target) {
  console.log("[shot] appName:", app.getName(), "| userData:", app.getPath("userData"));
  const waitMs = Number(process.env.NEXO_SHOT_WAIT ?? 2000);
  await new Promise((r) => setTimeout(r, waitMs));
  const jsFile = process.env.NEXO_SHOT_JS ?? "";
  if (jsFile && existsSync(jsFile)) {
    try {
      const out = await win.webContents.executeJavaScript(readFileSync(jsFile, "utf8"), true);
      // { __files: { "nome.png": "data:image/png;base64,..." } } vira arquivo no disco
      if (out && typeof out === "object" && out.__files) {
        for (const [nome, dataUrl] of Object.entries(out.__files)) {
          const b64 = String(dataUrl).split(",")[1] ?? "";
          const alvo = join(dirname(target), nome);
          writeFileSync(alvo, Buffer.from(b64, "base64"));
          console.log("[shot] arquivo:", alvo, Buffer.from(b64, "base64").length, "bytes");
        }
      } else if (out !== undefined) {
        console.log("[shot] js =>", JSON.stringify(out));
      }
    } catch (err) {
      console.error("[shot] js falhou:", err.message);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.NEXO_SHOT_JS_WAIT ?? 1200)));
  }
  // NEXO_SHOT_ALVO=widget (dev): fotografa o painel flutuante em vez da janela
  // principal — ele é outra BrowserWindow e não sai na foto da primeira.
  const alvoWc =
    process.env.NEXO_SHOT_ALVO === "widget" && widget && !widget.isDestroyed() ? widget.webContents : win.webContents;
  const img = await alvoWc.capturePage();
  writeFileSync(target, img.toPNG());
  console.log("[shot]", target);
  app.exit(0);
}

function createWindow() {
  const accent = readAccentArg();
  const size = shotSize();
  win = new BrowserWindow({
    show: !SHOT,
    width: size.width,
    height: size.height,
    minWidth: SHOT ? 0 : 900,
    minHeight: SHOT ? 0 : 560,
    backgroundColor: "#181818",
    title: "Nexo",
    webPreferences: {
      preload: join(here, "preload.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const query = HEX.test(accent) ? { accent } : {};
  // NEXO_SHOT_URL (dev): captura uma página local em vez do app — serve pra
  // revisar mockup de UI com o CSS de verdade.
  const shotUrl = process.env.NEXO_SHOT_URL ?? "";
  if (SHOT && /^http:\/\/127\.0\.0\.1:\d+\//.test(shotUrl)) win.loadURL(shotUrl);
  else win.loadFile(join(here, "index.html"), { query });
  if (SHOT) {
    win.webContents.once("did-finish-load", () => void runShot(SHOT));
    return;
  }
  /*
   * Iframe que falha em carregar não desenha página de erro nenhuma no Chromium:
   * dá branco puro. Isso repassa a falha pro renderer explicar o motivo.
   * Pega inclusive o caso que a sonda HTTP não vê: servidor que responde bem mas
   * recusa ser embutido (X-Frame-Options / frame-ancestors).
   */
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame || win.isDestroyed()) return;
    win.webContents.send("frame:fail", { code, desc, url });
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    if (!ctrl) return;
    const k = input.key.toLowerCase();
    if (k === "r" && !input.shift && !input.alt) {
      event.preventDefault();
      win.reload();
      return;
    }
    let mod = "";
    if (k === "p" && !input.shift && !input.alt) mod = "palette";
    else if (k === "g" && !input.shift && !input.alt) mod = "file";
    else if (k === "j" && !input.shift && !input.alt) mod = "terminal";
    else if (k === "b" && input.shift) mod = "browser";
    else if (k === "s" && input.shift) mod = "side-chat";
    else if (k === "w" && input.shift) {
      event.preventDefault();
      toggleWidget();
      return;
    }
    if (!mod) return;
    event.preventDefault();
    if (!win.webContents.isDestroyed()) win.webContents.send("nexo:mod", mod);
  });
}

/*
 * Painel flutuante: janela própria, sem moldura, sempre por cima.
 *
 * Janela separada e não um canto da principal porque o ponto dele é aparecer
 * quando o Nexo NÃO está na frente — um time roda por minutos enquanto você
 * está no editor. Painel embutido some junto com a janela e não resolveria
 * nada.
 *
 * Ela não entra na barra de tarefas nem no Alt+Tab: é um enfeite de canto de
 * tela, não uma janela pra alternar.
 */

const WIDGET_W = 264;
const WIDGET_H_INICIAL = 150;
/** Não deixa um conteúdo estranho esticar o painel até virar uma segunda janela. */
const WIDGET_H_MAX = 420;

function widgetStatePath() {
  return join(app.getPath("userData"), "widget.json");
}

/** Onde o painel estava e se estava aberto. Some junto com o userData, e tudo bem. */
function readWidgetState() {
  try {
    const raw = JSON.parse(readFileSync(widgetStatePath(), "utf8"));
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return { x: num(raw?.x), y: num(raw?.y), aberto: raw?.aberto === true };
  } catch {
    return { aberto: false };
  }
}

function saveWidgetState(patch) {
  try {
    writeFileSync(widgetStatePath(), JSON.stringify({ ...readWidgetState(), ...patch }), "utf8");
  } catch {
    // posição é conveniência: não poder gravar não é motivo pra derrubar nada
  }
}

function createWidget() {
  if (widget && !widget.isDestroyed()) return widget;
  const salvo = readWidgetState();
  widget = new BrowserWindow({
    width: WIDGET_W,
    height: WIDGET_H_INICIAL,
    ...(salvo.x === undefined || salvo.y === undefined ? {} : { x: salvo.x, y: salvo.y }),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: "Nexo — painel",
    webPreferences: {
      preload: join(here, "preload.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // "floating" mantém acima de janela normal sem cobrir menu do sistema
  widget.setAlwaysOnTop(true, "floating");
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widget.loadFile(join(here, "widget.html"));
  widget.on("moved", () => {
    if (widget?.isDestroyed()) return;
    const [x, y] = widget.getPosition();
    saveWidgetState({ x, y });
  });
  widget.on("closed", () => {
    widget = null;
  });
  return widget;
}

function showWidget() {
  const w = createWidget();
  // showInactive: o painel não rouba o foco de quem está digitando em outro app
  w.showInactive();
  saveWidgetState({ aberto: true });
}

function hideWidget() {
  if (widget && !widget.isDestroyed()) widget.hide();
  saveWidgetState({ aberto: false });
}

function toggleWidget() {
  if (widget && !widget.isDestroyed() && widget.isVisible()) hideWidget();
  else showWidget();
}

function createTray() {
  const img = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAMUlEQVRYR+3QQREAIAwDsf+hdQoYgQxs7k0qZWb2z+wHAQIECBAgQIAAAQIECBAg8G/gAGbDAQGPYNqTAAAAAElFTkSuQmCC",
  );
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("Nexo");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: () => win?.show() },
      { label: "Painel flutuante", click: () => toggleWidget() },
      { label: "Ligar motor", click: () => spawnNexo(["up"]).unref() },
      { label: "Desligar motor", click: () => spawnNexo(["down"]).unref() },
      { type: "separator" },
      { label: "Sair", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => win?.show());
}

function killShell() {
  if (!shellChild) return;
  shellChild.kill();
  shellChild = null;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender.isDestroyed()) return null;
    try {
      const result = await fn(event, ...args);
      if (event.sender.isDestroyed()) return null;
      return result;
    } catch (err) {
      if (event.sender.isDestroyed()) return null;
      throw err;
    }
  });
}

app.whenReady().then(() => {
  handle("daemon:info", () => daemonInfo());
  handle("daemon:start", () => {
    spawnNexo(["up"]).unref();
    return { ok: true };
  });
  handle("daemon:stop", () => {
    spawnNexo(["down"]).unref();
    return { ok: true };
  });
  handle("profile:login", (_e, id) => spawnNexoLogin(id));
  handle("widget:toggle", () => {
    toggleWidget();
    return { ok: true };
  });
  handle("widget:hide", () => {
    hideWidget();
    return { ok: true };
  });
  /**
   * O painel mede o próprio conteúdo e pede a altura. Sem isso ele teria altura
   * fixa: sobraria vazio com um run só, ou cortaria linha com quatro contas.
   */
  handle("widget:resize", (event, altura) => {
    const alvo = Math.round(Number(altura));
    if (!widget || widget.isDestroyed()) return { ok: false };
    if (event.sender !== widget.webContents) return { ok: false };
    if (!Number.isFinite(alvo) || alvo <= 0) return { ok: false };
    widget.setSize(WIDGET_W, Math.min(WIDGET_H_MAX, alvo));
    return { ok: true };
  });
  /**
   * Limpa o cache HTTP da sessão e, quando a URL é de um site, também o
   * service worker e o Cache Storage daquela origem — é o que segura preview
   * velho de servidor de dev. Cookie e localStorage ficam: "limpar cache" não
   * deve deslogar o usuário dos sites abertos.
   */
  handle("browser:clear-cache", async (event, raw) => {
    const ses = event.sender.session;
    await ses.clearCache();
    let origin = "";
    try {
      const u = new URL(String(raw ?? ""));
      if (u.protocol === "http:" || u.protocol === "https:") origin = u.origin;
    } catch {
      /* about:blank e afins: só o cache global */
    }
    if (origin) await ses.clearStorageData({ origin, storages: ["cachestorage", "serviceworkers"] });
    return { ok: true, origin };
  });
  handle("shell:external", async (_e, raw) => {
    const url = String(raw ?? "");
    // só https: nada de file:, javascript: ou cmd disfarçado de link
    if (!/^https:\/\//i.test(url)) throw new Error("URL inválida");
    await shell.openExternal(url);
    return { ok: true };
  });
  handle("folder:pick", async () => {
    const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    if (r.canceled) return null;
    setProject(r.filePaths[0]);
    return r.filePaths[0];
  });
  handle("project:set", (_e, p) => {
    setProject(typeof p === "string" ? p : "");
    return { ok: true, path: projectRoot };
  });
  handle("project:cwd", () => projectRoot || "");
  handle("file:save", async (_e, { name, content }) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: name });
    if (r.canceled || !r.filePath) return { ok: false };
    writeFileSync(r.filePath, content, "utf8");
    return { ok: true, path: r.filePath };
  });
  handle("fs:list", async (_e, rel = ".") => {
    const dir = boundPath(rel);
    const st = await stat(dir);
    if (!st.isDirectory()) throw new Error("Não é pasta");
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const isDir = ent.isDirectory();
      out.push({
        name: ent.name,
        dir: isDir,
        path: toRel(join(dir, ent.name)),
      });
      if (out.length >= 400) break;
    }
    out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "pt"));
    return { path: toRel(dir), entries: out, truncated: entries.length > out.length + SKIP_DIRS.size };
  });
  handle("fs:read", async (_e, rel) => {
    const full = boundPath(rel);
    const st = await stat(full);
    if (st.isDirectory()) return { dir: true, path: toRel(full) };
    if (st.size > MAX_PREVIEW) {
      return { path: toRel(full), tooBig: true, size: st.size };
    }
    if (BIN_EXT.test(full)) {
      return { path: toRel(full), binary: true, size: st.size };
    }
    const buf = await readFile(full);
    if (looksBinary(buf)) return { path: toRel(full), binary: true, size: st.size };
    return { path: toRel(full), text: buf.toString("utf8"), size: st.size };
  });
  handle("shell:run", async (event, command) => {
    if (!projectRoot) return { ok: false, error: "Sem projeto" };
    const trimmed = String(command ?? "").trim();
    if (!trimmed) return { ok: false, error: "Comando vazio" };
    killShell();
    const cwd = boundPath(".");
    const win32 = process.platform === "win32";
    const proc = win32
      ? spawn("powershell.exe", ["-NoLogo", "-NonInteractive", "-Command", trimmed], {
          cwd,
          windowsHide: true,
        })
      : spawn("/bin/bash", ["-lc", trimmed], { cwd });
    shellChild = proc;
    const sender = event.sender;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      if (!sender.isDestroyed()) sender.send("shell:data", d);
    });
    proc.stderr.on("data", (d) => {
      if (!sender.isDestroyed()) sender.send("shell:data", d);
    });
    proc.on("error", (err) => {
      if (!sender.isDestroyed()) sender.send("shell:data", String(err.message) + "\n");
    });
    proc.on("close", (code) => {
      if (shellChild === proc) shellChild = null;
      if (!sender.isDestroyed()) sender.send("shell:exit", code ?? 1);
    });
    return { ok: true, cwd, pid: proc.pid };
  });
  handle("shell:kill", () => {
    killShell();
    return { ok: true };
  });
  void ensureDaemon();
  createWindow();
  createTray();
  // reabre onde estava: painel que some a cada reinício não serve de painel
  if (!SHOT && readWidgetState().aberto) showWidget();
});

app.on("before-quit", () => killShell());
app.on("window-all-closed", () => {
  killShell();
  if (process.platform !== "darwin") app.quit();
});
