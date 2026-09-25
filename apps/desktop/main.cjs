const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, screen, shell } = require("electron");
const { BORDAS, bordaMaisProxima, retanguloNaBorda } = require("./painel-borda.cjs");
const atualizador = require("./atualizador.cjs");
const { criarLog } = require("./log.cjs");
const { HEALTH_TIMEOUT_MS, agentesVivos, criarVigia, destravar, lerPidDoMotor, saudeDoMotor } = require("./destravar.cjs");
const { autoUpdater } = require("electron-updater");
const { execFile, spawn } = require("node:child_process");
const {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { readdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const { dirname, join, resolve, sep } = require("node:path");
const { motorArgs, resolveNodeBin, spawnNexoProcess } = require("../daemon/scripts/resolve-tsx.cjs");
// guest-relayout.js é ESM (precisa ser, pro <script type="module"> do renderer
// conseguir importá-lo de volta — ver o comentário no topo daquele arquivo).
// main.cjs é CJS, então entra por import() dinâmico em vez de require().
let JS_RELAYOUT_GUEST = "";
let uaChromeAPartirDe = (ua) => String(ua || "");
const guestRelayoutReady = import("./guest-relayout.js").then((m) => {
  JS_RELAYOUT_GUEST = m.JS_RELAYOUT_GUEST;
  uaChromeAPartirDe = m.uaChromeAPartirDe;
});

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

/*
 * Sem isto, cada clique no atalho (ou cada `nexo` que sobe o Electron junto)
 * abre um processo novo — janela nova, painel novo, e um ícone de bandeja a
 * mais por cima do outro. `requestSingleInstanceLock` faz a segunda tentativa
 * só acordar a primeira e sair; quem já está aberto que responde.
 */
/*
 * Modo de teste (`run.bat dev`, só fora do empacotado): roda ISOLADO do Nexos instalado — motor
 * próprio (`~/.nexos-dev`, porta 7433) e userData próprio ("Nexos Dev"). Sem isso o app de dev
 * falaria com o motor instalado (versão velha, sem as rotas novas) e brigaria pelo mesmo
 * localStorage. Tem que vir ANTES do lock de instância única, que usa o userData da hora da chamada.
 */
const DEV = !app.isPackaged && process.env.NEXOS_DEV === "1";
if (DEV) {
  if (!process.env.NEXOS_HOME) process.env.NEXOS_HOME = join(homedir(), ".nexos-dev");
  const cfg = join(process.env.NEXOS_HOME, "config.json");
  if (!existsSync(cfg)) {
    mkdirSync(process.env.NEXOS_HOME, { recursive: true });
    writeFileSync(cfg, JSON.stringify({ port: 7433 }, null, 2), "utf8");
  }
  app.setName("Nexos Dev");
  app.setPath("userData", join(app.getPath("appData"), "Nexos Dev"));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Notificação nativa no Windows só aparece com o mesmo AppUserModelId do atalho que o NSIS cria
// (= `appId` do electron-builder.yml). Sem isto o aviso de "instalando atualização" não sai.
if (process.platform === "win32") app.setAppUserModelId("br.com.2dconsultores.nexos");

const here = __dirname;
/**
 * Em dev, o daemon é a pasta do monorepo (`apps/daemon`), com `@nexos/shared` linkado pelo pnpm
 * workspace. Empacotado, essa pasta não existe na máquina de quem instala — o daemon vira
 * `daemon-dist` (gerado por `pnpm run deploy:daemon`, ver electron-builder.yml) e vai junto do
 * `.exe` como `extraResources`, com `@nexos/shared` já copiado de verdade pra dentro dele.
 */
const daemonRoot = app.isPackaged ? join(process.resourcesPath, "daemon") : join(here, "../daemon");
const repoRoot = app.isPackaged ? daemonRoot : resolve(daemonRoot, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", ".next", "coverage", ".turbo", ".nexo-test"]);
const BIN_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|exe|dll|zip|gz|7z|rar|pdf|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|avi|node|wasm|bin|so|dylib|psd|sqlite3?)$/i;
const MAX_PREVIEW = 256 * 1024;
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A pasta de dados chamava `.nexo` (nome do produto até a v0.1.0) e migra sozinha pra
 * `.nexos` — mesma lógica de `home.ts` do daemon, duplicada aqui porque o Electron lê
 * tema/config ANTES de o daemon subir (ver `readTema`/`daemonInfo` abaixo), então não dá
 * pra esperar o processo filho migrar primeiro.
 */
function migrarHomeAntigo(novo) {
  if (existsSync(novo)) return;
  const antigo = join(homedir(), ".nexo"); // NUNCA mudar pra ".nexos" — é o nome ANTIGO
  if (!existsSync(antigo)) return;
  try {
    renameSync(antigo, novo);
  } catch {
    cpSync(antigo, novo, { recursive: true });
    try {
      rmSync(antigo, { recursive: true, force: true });
    } catch {
      /* best-effort: a cópia já está de pé */
    }
  }
}

function nexoHome() {
  if (process.env.NEXOS_HOME) return process.env.NEXOS_HOME;
  const novo = join(homedir(), ".nexos");
  migrarHomeAntigo(novo);
  return novo;
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

/**
 * Cor de fundo da janela ANTES de o renderer pintar. Sem ler o tema aqui, abrir
 * o app no tema preto pisca um retângulo grafite a cada inicialização.
 */
const TEMA_BG = { grafite: "#141417", preto: "#000000" };

function readTema() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return raw.tema in TEMA_BG ? raw.tema : "grafite";
  } catch {
    return "grafite";
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

/** Mesmo `daemon.log` do motor, origem `app`/`saude` (ver log.cjs). */
const logApp = criarLog({ home: () => nexoHome() });

/** Toda checagem de /health tem prazo: motor travado aceita a conexão e nunca responde. */
function comPrazo() {
  return AbortSignal.timeout(HEALTH_TIMEOUT_MS);
}

/** Conta o tempo seguido sem resposta; aos 15 s dispara `aoTravar`. */
const vigiaDoMotor = criarVigia({ log: logApp });

async function daemonInfo() {
  const port = readPort();
  const token = existsSync(tokenPath()) ? readFileSync(tokenPath(), "utf8").trim() : "";
  const estado = await saudeDoMotor(port, { checagem: "daemonInfo", log: logApp });
  const ok = estado === "ok";
  if (ok) {
    motorErro = "";
    motorTravado = null;
  }
  if (vigiaDoMotor.registrar(estado) === "destravar") void aoTravar();
  return {
    port,
    token,
    ok,
    estado,
    home: nexoHome(),
    starting: motorSubindo !== null || motorDestravando !== null,
    erro: ok ? "" : motorErro,
    travado:
      estado === "sem_resposta"
        ? { desde: vigiaDoMotor.travadoDesde(), destravando: motorDestravando !== null, ...(motorTravado ?? {}) }
        : null,
  };
}

/**
 * Existe turno de agente em voo agora, em qualquer conversa? Usado só pra decidir
 * se dá pra aplicar update baixado (ver setupAutoUpdater) — daemon fora do ar
 * conta como "sem turno" (não tem o que proteger).
 */
async function turnoAtivo() {
  try {
    const info = await daemonInfo();
    if (!info.ok) return false;
    // rota autenticada: sem o token dava 401 e isto respondia "sem turno" sempre — o gate do
    // update instalava com agente no meio do trabalho
    const res = await fetch(`http://127.0.0.1:${info.port}/v1/status/turno-ativo`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: comPrazo(),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return Boolean(json.ativo);
  } catch {
    return false;
  }
}

/**
 * O motor roda no binário do Electron em modo Node (ELECTRON_RUN_AS_NODE).
 * Motivo: node.exe é console app e, com detached, o Windows abre um console vazio
 * (o windowsHide é ignorado nesse caso). O electron.exe é GUI, então não abre
 * console nenhum — e com detached o motor sobrevive ao fechar o app.
 */
function spawnNexo(args, extra = {}) {
  return spawnNexoProcess(args, {
    daemonRoot,
    nodeBin: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NEXOS_APP_VERSION: app.getVersion() },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...extra,
  });
}

function daemonLogPath() {
  return join(nexoHome(), "daemon.log");
}

/**
 * stdout+stderr do `nexos up`: crash de import, stack que o logger não pegou. Arquivo à parte do
 * `daemon.log` porque o fd é aberto AQUI e herdado pelo motor — renomear com o motor ligado não
 * adiantaria (ele continuaria escrevendo no renomeado). Então este rotaciona só na subida, e o
 * `daemon.log` fica com o logger do motor, que é dono do próprio arquivo e rotaciona sozinho.
 */
function daemonSaidaPath() {
  return join(nexoHome(), "daemon-saida.log");
}

const SAIDA_MAX_BYTES = 1024 * 1024;

function rotacionarSaida(path) {
  try {
    if (statSync(path).size > SAIDA_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    /* não existe ainda, ou preso: segue no mesmo */
  }
}

function readLogTail(path, maxChars = 4000) {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return "";
  }
}

/** Fim dos dois logs: o do motor e a saída crua do processo. */
function tailDosLogs() {
  const motor = readLogTail(daemonLogPath(), 2000).trim();
  const saida = readLogTail(daemonSaidaPath(), 2000).trim();
  return [motor && `— daemon.log —\n${motor}`, saida && `— daemon-saida.log —\n${saida}`].filter(Boolean).join("\n");
}

/**
 * `pnpm install --frozen-lockfile` antes de subir o motor: sem rede e ~1s quando já está tudo
 * instalado, e conserta sozinho o caso de puxar um commit que adiciona dependência nova sem
 * ninguém rodar `pnpm install` depois — isso derrubava o motor com um crash de import ANTES de
 * qualquer código nosso rodar (nem log sobrava, `stdio` do processo era "ignore").
 * `corepack` (não `pnpm` direto) porque é quem lê o `packageManager` do package.json e já
 * vem com o Node — não depende do usuário ter pnpm instalado à parte.
 */
function ensureDepsInstalled() {
  // Empacotado, `daemon-dist` já sai instalado do `pnpm deploy` (ver electron-builder.yml) — não
  // tem lockfile/workspace pra reinstalar, e rodar `pnpm install` ali só daria erro ou tentaria
  // escrever na pasta de instalação do app, que não é gravável fora de admin.
  if (app.isPackaged) return Promise.resolve({ ok: true });
  return new Promise((resolvePromise) => {
    execFile(
      "corepack",
      ["pnpm", "install", "--frozen-lockfile"],
      { cwd: repoRoot, timeout: 120_000, windowsHide: true, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
        if (err) resolvePromise({ ok: false, log: `${stdout || ""}${stderr || ""}`.trim() || err.message });
        else resolvePromise({ ok: true });
      },
    );
  });
}

function spawnNexoLogin(id) {
  const slug = String(id ?? "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, error: "perfil inválido" };
  try {
    // Empacotado, sem Node garantido na máquina: usa o binário do Electron em modo Node, igual o
    // daemon principal (`spawnNexo`) — só que aqui precisa de um console de VERDADE (o login
    // mostra URL/código pra pessoa copiar), então o `.cmd` seta ELECTRON_RUN_AS_NODE antes de
    // chamar, em vez de passar env só pro `spawn` (que aqui é do `cmd.exe`, não do node/electron).
    const node = app.isPackaged ? process.execPath : resolveNodeBin();
    const motor = motorArgs(daemonRoot).map((a) => `"${a}"`).join(" ");
    if (process.platform === "win32") {
      const bat = join(tmpdir(), `nexo-login-${slug}.cmd`);
      writeFileSync(
        bat,
        [
          "@echo off",
          ...(app.isPackaged ? ["set ELECTRON_RUN_AS_NODE=1"] : []),
          `cd /d "${daemonRoot}"`,
          `echo Nexos login  ${slug}`,
          `echo.`,
          `"${node}" ${motor} login ${slug}`,
          "if errorlevel 1 (",
          "  echo.",
          "  echo Login falhou. Le o erro acima.",
          "  pause",
          "  exit /b 1",
          ")",
          "echo.",
          "echo Pronto. Fecha esta janela e volta pro Nexos.",
          "pause",
        ].join("\r\n"),
        "utf8",
      );
      const child = spawn("cmd.exe", ["/c", "start", "Nexos login", bat], {
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
let painel;
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
 * Modo screenshot (só dev): NEXOS_SHOT=caminho.png abre a janela escondida,
 * espera NEXOS_SHOT_WAIT ms, salva a imagem e sai. NEXOS_SHOT_SIZE=1280x800 muda
 * o tamanho; NEXOS_SHOT_JS=arquivo.js roda esse script no renderer antes do clique.
 */
/**
 * Identidade fixa do app. O package.json chama "@nexos/desktop", e o Electron
 * usava isso como pasta de userData ("Roaming\@nexos\desktop") — nome com barra,
 * caminho instável entre formas de abrir o app. Quando mudava, o localStorage
 * ia embora e o app parecia ter esquecido projetos e conversas.
 *
 * "Nexos" (produto até a v0.1.0) entra na lista de pastas antigas pelo mesmo motivo:
 * o rename pro nome novo não pode fazer ninguém "perder" projeto/conversa aberta.
 */
function fixAppIdentity() {
  if (DEV) return; // identidade própria, definida lá em cima
  const alvo = join(app.getPath("appData"), "Nexos");
  const antigos = [
    join(app.getPath("appData"), "Nexos"),
    join(app.getPath("appData"), "@nexo", "desktop"),
    join(app.getPath("appData"), "Electron"),
  ];
  app.setName("Nexos");
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
      console.log("[nexos] userData migrado de", velho, "| arquivos:", copiados);
      break;
    }
  }
  app.setPath("userData", alvo);
}

fixAppIdentity();

const SHOT = process.env.NEXOS_SHOT ?? "";

// silencia o ruído do Chromium (INFO/WARNING/"Hit debug scenario") no stderr
if (!process.env.NEXOS_VERBOSE) app.commandLine.appendSwitch("log-level", "3");

/**
 * Bug conhecido do Chromium no Windows 11: a detecção de "janela ocluída" (native window
 * occlusion) erra o cálculo com alguma frequência e trava a pintura de superfícies extras —
 * <webview>/BrowserView renderizam preto sólido, mesmo com a janela em primeiro plano e
 * visível. Só afeta Windows; nas outras plataformas a flag não existe e o switch é ignorado.
 * https://github.com/electron/electron/issues (vários relatos do mesmo sintoma, mesma causa).
 */
if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

/** Espera um processo filho sair, com teto — `nexo down` que trava não pode travar a recarga. */
function esperarSair(child, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

let motorReiniciando = null;

/**
 * Derruba o motor e espera ele sair de verdade (`nexo down` só manda o sinal). O instalador não
 * troca arquivo de processo vivo: com o motor de pé, a atualização falhava calada e o app voltava
 * na versão velha — era preciso "reiniciar duas vezes".
 */
async function pararMotor(ms = 8000) {
  logApp.info("app", "parando o motor");
  await esperarSair(spawnNexo(["down"]), 5000);
  const ate = Date.now() + ms;
  while (Date.now() < ate && (await daemonInfo()).ok) await new Promise((r) => setTimeout(r, 250));
}

/** Versão do app que subiu o motor de pé ("" = motor de antes desta checagem). */
async function versaoDoMotor() {
  try {
    const res = await fetch(`http://127.0.0.1:${readPort()}/health`, { signal: comPrazo() });
    const json = await res.json();
    return typeof json?.app === "string" ? json.app : "";
  } catch {
    return "";
  }
}

/** Só em dev: derruba e sobe o motor pra pegar o código novo do daemon. */
function reiniciarMotorDev() {
  if (motorReiniciando) return motorReiniciando;
  motorReiniciando = (async () => {
    try {
      await esperarSair(spawnNexo(["down"]), 10_000);
      const { ok } = await subirMotor({ timeoutMs: 20_000 });
      console.log(ok ? "[dev] motor reiniciado" : "[dev] motor não voltou — veja ~/.nexos-dev/logs");
    } finally {
      motorReiniciando = null;
    }
  })();
  return motorReiniciando;
}

/**
 * Só em dev: recarrega sozinho ao salvar. Front (js/css/html do desktop) → recarrega a janela;
 * `.cjs` do main/preload → reabre o app (não dá pra trocar o main com ele rodando); daemon ou
 * `@nexos/shared` → reinicia o motor e depois recarrega a janela.
 */
function ligarRecargaDev() {
  const { watch } = require("node:fs");
  const ignorar = /(^|[\\/])(node_modules|dist|daemon-dist|test)([\\/]|$)|\.test\.|~$|\.tmp$/;
  let timer = 0;
  let acao = "";
  const peso = { janela: 1, motor: 2, app: 3 };
  const agendar = (tipo, arquivo) => {
    if (!acao || peso[tipo] > peso[acao]) acao = tipo;
    console.log(`[dev] mudou ${arquivo} → ${acao}`);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const a = acao;
      acao = "";
      if (a === "app") {
        app.relaunch();
        app.exit(0);
        return;
      }
      if (a === "motor") await reiniciarMotorDev();
      if (win && !win.isDestroyed()) win.reload();
    }, 300);
  };
  // No Windows o fs.watch também dispara quando o arquivo só é LIDO (o motor subindo lê o src
  // inteiro) — sem conferir o mtime, cada reinício do motor dispararia outro, em loop.
  const inicio = Date.now();
  const mtimes = new Map();
  const mudouDeVerdade = (caminho) => {
    let m;
    try {
      m = require("node:fs").statSync(caminho).mtimeMs;
    } catch {
      return true; // apagado ou renomeado: é mudança
    }
    const antes = mtimes.get(caminho) ?? inicio;
    mtimes.set(caminho, Math.max(m, antes));
    return m > antes;
  };
  const vigiar = (pasta, classificar) => {
    try {
      watch(pasta, { recursive: true }, (_ev, nome) => {
        const arquivo = String(nome || "");
        if (!arquivo || ignorar.test(arquivo)) return;
        const tipo = classificar(arquivo);
        if (tipo && mudouDeVerdade(join(pasta, arquivo))) agendar(tipo, arquivo);
      });
    } catch (e) {
      console.log(`[dev] não consegui vigiar ${pasta}: ${e.message}`);
    }
  };
  vigiar(here, (f) => (/\.cjs$/.test(f) ? "app" : /\.(js|css|html)$/.test(f) ? "janela" : ""));
  vigiar(join(daemonRoot, "src"), (f) => (/\.ts$/.test(f) ? "motor" : ""));
  vigiar(join(repoRoot, "packages", "shared", "src"), (f) => (/\.ts$/.test(f) ? "motor" : ""));
  console.log(`[dev] recarga automática ligada | motor: ${nexoHome()} porta ${readPort()}`);
}

/**
 * Subida em voo (boot, botão ou bandeja), compartilhada: dois `up` ao mesmo tempo disputam a
 * porta. Enquanto ela existe o `daemon:info` responde `starting`, e o renderer mostra "Ligando"
 * em vez de "Desligado" — no primeiro boot depois de instalar a subida demora (antivírus
 * varrendo o node_modules recém-copiado) e a tela parada convidava a clicar em Ligar.
 */
let motorSubindo = null;
/** Último erro de subida; some quando o /health responde. */
let motorErro = "";
/** Destrave em voo (kill + subir de novo). */
let motorDestravando = null;
/**
 * O que a tela precisa pra decidir o banner do motor travado: `{ pid, agentes }` quando há agente
 * vivo (pergunta antes), `{ pid, recusado, motivo }` quando o PID não é confirmadamente nosso
 * (oferece matar na mão). `null` enquanto ainda é só "travado há X s".
 */
let motorTravado = null;

/** `nexos up` sai com isto quando a porta tem um motor travado (ver CODIGO_TRAVADO no daemon). */
const SAIDA_TRAVADO = 3;

/**
 * 15 s seguidos sem resposta (ou clique em Ligar com o motor travado). Decisão C: sem agente vivo
 * em `run/`, mata e sobe sozinho; com agente, pergunta — o turno em curso se perde.
 */
async function aoTravar() {
  if (motorDestravando || motorSubindo) return;
  const home = nexoHome();
  const agentes = agentesVivos(home);
  logApp.info("app", `${agentes.length} agente(s) vivo(s) em run/`, { agentes });
  if (agentes.length) {
    motorTravado = { pid: lerPidDoMotor(home)?.pid ?? null, agentes: agentes.length };
    logApp.info("app", "banner: reiniciar o motor travado? (tem agente vivo)");
    return;
  }
  logApp.info("app", "reinício automático (nenhum agente vivo)");
  const r = await reiniciarTravado({ automatico: true });
  if (r.ok) avisarDoUpdate("Nexos", "Motor travado, reiniciado.");
}

/**
 * Mata o motor travado (PID confirmado, ou `forcar` quando a pessoa pediu) e sobe um novo.
 * Nunca mata PID que não passou na confirmação sem `forcar`.
 */
function reiniciarTravado({ forcar = false, automatico = false } = {}) {
  if (motorDestravando) return motorDestravando;
  motorDestravando = (async () => {
    const inicio = Date.now();
    const r = await destravar({ home: nexoHome(), port: readPort(), log: logApp, forcar });
    if (!r.ok) {
      motorTravado = { pid: r.pid, recusado: Boolean(r.recusado), motivo: r.motivo || "" };
      return { ok: false, travado: true, error: `Motor travado (PID ${r.pid ?? "?"}): ${r.motivo || "não consegui matar"}` };
    }
    motorTravado = null;
    const sub = await subirMotor();
    if (sub.ok) {
      const s = Math.round((Date.now() - inicio) / 100) / 10;
      logApp.info("app", `motor novo respondendo em ${s} s`, { automatico });
    } else {
      logApp.erro("app", "motor novo não subiu depois de destravar", { erro: String(sub.error || "").slice(-500) });
    }
    return sub;
  })().finally(() => {
    motorDestravando = null;
  });
  return motorDestravando;
}

function subirMotor({ timeoutMs = 60_000, deps = false } = {}) {
  if (motorSubindo) return motorSubindo;
  motorSubindo = (async () => {
    const antes = await daemonInfo();
    // travado não é "sem motor": subir outro por cima só daria "já ligado" (ver aoTravar)
    if (antes.estado === "sem_resposta") return { ok: false, travado: true, error: "Motor travado: não responde" };
    if (antes.ok) {
      /*
       * O motor sobrevive ao fechamento do app. Depois de atualizar, o que responde pode ser o da
       * versão anterior — o app novo conversaria com o motor velho até alguém reiniciar de novo.
       * Troca, a não ser que tenha agente trabalhando (aí fica pro próximo boot).
       */
      if (!app.isPackaged || (await versaoDoMotor()) === app.getVersion() || (await turnoAtivo())) return { ok: true };
      console.log("[motor] de outra versão do app — reiniciando");
      await pararMotor();
    }
    if (deps) {
      const r = await ensureDepsInstalled();
      if (!r.ok) return { ok: false, error: `Não consegui instalar dependências:\n${r.log}`.trim() };
    }
    const logPath = daemonSaidaPath();
    mkdirSync(nexoHome(), { recursive: true });
    rotacionarSaida(logPath);
    logApp.info("app", "subindo o motor", { versao: app.getVersion() });
    let logFd;
    try {
      logFd = openSync(logPath, "a");
    } catch {
      logFd = undefined;
    }
    let child;
    try {
      child = spawnNexo(["up"], logFd === undefined ? {} : { stdio: ["ignore", logFd, logFd] });
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    child.unref();

    // Poll em vez de esperar o processo "terminar": ele é pra ficar de pé (server ouvindo),
    // então sucesso aqui é o /health responder, não o child sair.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if ((await daemonInfo()).ok) return { ok: true };
      if (child.exitCode !== null || child.signalCode) break;
    }
    // Saiu com "already up" (outro `up` ganhou a corrida) ainda conta como ligado.
    if ((await daemonInfo()).ok) return { ok: true };
    if (child.exitCode === SAIDA_TRAVADO) {
      logApp.aviso("app", `nexos up saiu com ${SAIDA_TRAVADO}: motor travado na porta`);
      return { ok: false, travado: true, error: "Motor travado: não responde" };
    }
    logApp.erro("app", "motor não subiu", { codigo: child.exitCode, sinal: child.signalCode });
    const tail = tailDosLogs();
    const motivo = child.exitCode === null && !child.signalCode ? `motor não respondeu em ${timeoutMs / 1000}s` : "";
    return { ok: false, error: [tail, motivo].filter(Boolean).join("\n") || "motor não respondeu" };
  })()
    .then((r) => {
      motorErro = r.ok ? "" : r.error;
      return r;
    })
    .finally(() => {
      motorSubindo = null;
    });
  return motorSubindo;
}

function shotSize() {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(process.env.NEXOS_SHOT_SIZE ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 800 };
}

async function runShot(target) {
  console.log("[shot] appName:", app.getName(), "| userData:", app.getPath("userData"));
  const waitMs = Number(process.env.NEXOS_SHOT_WAIT ?? 2000);
  await new Promise((r) => setTimeout(r, waitMs));
  const jsFile = process.env.NEXOS_SHOT_JS ?? "";
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
    await new Promise((r) => setTimeout(r, Number(process.env.NEXOS_SHOT_JS_WAIT ?? 1200)));
  }
  // NEXOS_SHOT_ALVO=painel (dev): fotografa o painel de borda em vez da janela
  // principal — ele é outra BrowserWindow e não sai na foto da primeira.
  const alvoWc =
    process.env.NEXOS_SHOT_ALVO === "painel" && painel && !painel.isDestroyed() ? painel.webContents : win.webContents;
  const img = await alvoWc.capturePage();
  writeFileSync(target, img.toPNG());
  console.log("[shot]", target);
  app.exit(0);
}

function createWindow() {
  const accent = readAccentArg();
  const tema = readTema();
  const size = shotSize();
  win = new BrowserWindow({
    show: !SHOT,
    width: size.width,
    height: size.height,
    minWidth: SHOT ? 0 : 900,
    minHeight: SHOT ? 0 : 560,
    backgroundColor: TEMA_BG[tema],
    title: "Nexos",
    icon: join(here, "icons", "app.png"),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // <webview> do painel Browser: é a única forma de o Nexos controlar (destacar,
      // selecionar) o conteúdo carregado dentro, já que ele vive numa origem
      // diferente (http://127.0.0.1:porta vs file://) e a Same-Origin Policy bloqueia
      // acesso direto de fora. Ver browser-inspector-preload.cjs.
      webviewTag: true,
      // Sem isso, o Chromium throttla os timers do renderer (poll do motor,
      // setTimeout do stream) pra ~1/min quando a janela perde o foco — dava a
      // impressão de resposta "travada" até o usuário focar a janela de novo.
      backgroundThrottling: false,
    },
  });
  /*
   * Trava as webPreferences de qualquer <webview> anexado nos valores esperados, em vez
   * de confiar no que o HTML pediu — recomendação padrão do Electron pra webviewTag: sem
   * isso, uma página comprometida poderia anexar um <webview> com nodeIntegration ligado.
   * Só o painel Browser usa <webview>, e sempre com este preload — nenhum caso legítimo
   * precisa de outro.
   */
  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.preload = join(here, "browser-inspector-preload.cjs");
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
  });
  const query = { tema, ...(HEX.test(accent) ? { accent } : {}) };
  // NEXOS_SHOT_URL (dev): captura uma página local em vez do app — serve pra
  // revisar mockup de UI com o CSS de verdade.
  const shotUrl = process.env.NEXOS_SHOT_URL ?? "";
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

  /*
   * O <webview> do painel Browser é uma WebContents própria, separada da da janela —
   * o did-fail-load acima (preso a win.webContents) nunca dispara pra ele. did-attach-webview
   * entrega essa WebContents assim que ela nasce; sem este listener, a troca de <iframe>
   * pra <webview> regrediria silenciosamente a mensagem amigável de "preview não carregou".
   *
   * `isMainFrame` aqui é o INVERSO do check acima de propósito: no <iframe> antigo, o preview
   * era um SUBFRAME dentro da WebContents única da janela — por isso `if (isMainFrame) return`.
   * No <webview>, o preview É a WebContents inteira, e a página carregada dentro dele é o
   * frame principal DELA — por isso aqui é `if (!isMainFrame) return`.
   */
  win.webContents.on("did-attach-webview", async (_e, webContents) => {
    await guestRelayoutReady;
    if (webContents.isDestroyed()) return;
    webContents.setUserAgent(
      uaChromeAPartirDe(
        process.platform === "darwin"
          ? `Macintosh; Intel Mac OS X 10_15_7 Chrome/${process.versions.chrome}`
          : process.platform === "linux"
            ? `Linux Chrome/${process.versions.chrome}`
            : `Windows NT 10.0; Win64; x64 Chrome/${process.versions.chrome}`,
      ),
    );
    webContents.on("did-fail-load", (_ev, code, desc, url, isMainFrame) => {
      if (!isMainFrame || win.isDestroyed()) return;
      win.webContents.send("frame:fail", { code, desc, url });
    });
    webContents.on("did-finish-load", () => {
      if (webContents.isDestroyed()) return;
      webContents.executeJavaScript(JS_RELAYOUT_GUEST).catch(() => {});
    });
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
    // área de chats: Ctrl+1/2/3 foca o chat N, Ctrl+Shift+M minimiza, Ctrl+B mostra/recolhe a sidebar
    else if (["1", "2", "3"].includes(k) && !input.shift && !input.alt) mod = `chat-${k}`;
    else if (k === "m" && input.shift) mod = "chat-min";
    else if (k === "b" && !input.shift && !input.alt) mod = "sidebar";
    else if (k === "w" && input.shift) {
      event.preventDefault();
      alternarPainel();
      return;
    }
    if (!mod) return;
    event.preventDefault();
    if (!win.webContents.isDestroyed()) win.webContents.send("nexo:mod", mod);
  });
}

/**
 * Painel de borda (substitui o antigo painel flutuante; desenho vem do codenotch): uma pílula
 * grudada numa borda da tela que abre ao passar o mouse e mostra a atividade das conversas e o
 * uso das contas.
 *
 * A janela é transparente e maior que a pílula (cabe o card aberto) e fica parada: animar o
 * tamanho de uma janela transparente pisca. O que não é pílula/card deixa o clique passar
 * (`setIgnoreMouseEvents` com `forward`) — e quem decide é ESTE processo, olhando o cursor a cada
 * 40ms contra os retângulos que a página informa. `mouseleave` numa janela que ignora o mouse não
 * é confiável (o codenotch no Windows chegou na mesma conclusão).
 *
 * `focusable: false`: clicar no painel não tira o foco do editor de quem está digitando.
 */
const PAINEL_W = 340;
const PAINEL_H = 600;
const PAINEL_VIGIA_MS = 40;
/**
 * De quanto em quanto tempo o painel reafirma que fica por cima de tudo. O Windows às vezes tira a
 * janela da faixa "sempre no topo" (continua com o estilo, mas vai pra trás da janela do Nexos) e
 * a pílula some sem erro nenhum; o `setAlwaysOnTop` de quando o painel nasce não volta sozinho.
 */
const PAINEL_TOPO_MS = 2000;
/** Folga em volta dos retângulos quentes, em px da página (o cursor não acerta a borda exata). */
const PAINEL_FOLGA = 10;
const PAINEL_PADRAO = {
  /**
   * "dinamico": recolhido é só um traço; aparece ao aproximar o mouse e some ao afastar.
   * "fixo": sempre aberto. "desligado": não aparece.
   */
  mostrar: "dinamico",
  borda: "direita",
  /** Posição ao longo de CADA borda (0..1); 0,5 = meio. */
  aoLongo: {},
  /** id do monitor; "" = o principal. */
  monitor: "",
  /** Escala geral do painel (0,6 a 1,6). */
  tamanho: 1,
  /** "dois": anel de fora = semana, de dentro = 5 h. "um": só a janela mais apertada. */
  aneis: "dois",
  /** Opacidade do fundo (pílula e card), 0,3 a 1. A cor vem do tema de Aparência. */
  opacidade: 1,
  /** Segundos que o painel abre sozinho quando uma conversa termina/pede resposta (0 = não abre). */
  espiar: 5,
  somAoTerminar: true,
  somAoPedir: true,
  avisarLimite: true,
  avisarRenovou: true,
  atencao: 0.5,
  critico: 0.8,
};
const PAINEL_ESPIAR = [0, 3, 5, 10];

let painelAreas = { quentes: [], despertar: null };
let painelDentro = false;
/** `false` ou o lugar em que a pílula está sendo arrastada ({ display, borda, pos }). */
let painelArrastando = false;
let painelVigia = null;
let painelTopoEm = 0;

function painelPrefsPath() {
  return join(app.getPath("userData"), "painel.json");
}

function limparPrefsDoPainel(raw) {
  const p = { ...PAINEL_PADRAO, aoLongo: {} };
  if (!raw || typeof raw !== "object") return p;
  // nomes antigos (antes da 0.5.1) continuam valendo
  const mostrar = { hover: "dinamico", sempre: "fixo", oculto: "desligado" }[raw.mostrar] ?? raw.mostrar;
  if (["dinamico", "fixo", "desligado"].includes(mostrar)) p.mostrar = mostrar;
  if (BORDAS.includes(raw.borda)) p.borda = raw.borda;
  if (raw.aoLongo && typeof raw.aoLongo === "object") {
    for (const b of BORDAS) {
      const v = Number(raw.aoLongo[b]);
      if (raw.aoLongo[b] !== undefined && Number.isFinite(v)) p.aoLongo[b] = Math.min(1, Math.max(0, v));
    }
  }
  if (typeof raw.monitor === "string") p.monitor = raw.monitor;
  if (typeof raw.tamanho === "number" && raw.tamanho >= 0.6 && raw.tamanho <= 1.6) {
    p.tamanho = Math.round(raw.tamanho * 20) / 20;
  }
  if (raw.aneis === "um" || raw.aneis === "dois") p.aneis = raw.aneis;
  if (typeof raw.opacidade === "number" && raw.opacidade >= 0.3 && raw.opacidade <= 1) {
    p.opacidade = Math.round(raw.opacidade * 20) / 20;
  }
  if (PAINEL_ESPIAR.includes(raw.espiar)) p.espiar = raw.espiar;
  for (const k of ["somAoTerminar", "somAoPedir", "avisarLimite", "avisarRenovou"]) {
    if (typeof raw[k] === "boolean") p[k] = raw[k];
  }
  const fr = (v) => (typeof v === "number" && v > 0 && v < 1 ? Math.round(v * 100) / 100 : undefined);
  const atencao = fr(raw.atencao) ?? p.atencao;
  const critico = fr(raw.critico) ?? p.critico;
  // atenção sempre abaixo do crítico, senão a faixa amarela some ou inverte
  if (atencao < critico) Object.assign(p, { atencao, critico });
  return p;
}

function lerPainel() {
  try {
    return limparPrefsDoPainel(JSON.parse(readFileSync(painelPrefsPath(), "utf8")));
  } catch {
    return limparPrefsDoPainel(null);
  }
}

function gravarPainel(patch) {
  const atual = lerPainel();
  const aoLongo = patch?.aoLongo ? { ...atual.aoLongo, ...patch.aoLongo } : atual.aoLongo;
  const prox = limparPrefsDoPainel({ ...atual, ...patch, aoLongo });
  try {
    writeFileSync(painelPrefsPath(), JSON.stringify(prox, null, 2), "utf8");
  } catch {
    // preferência é conveniência: não gravar não derruba nada
  }
  aplicarPainel(prox);
  return prox;
}

function monitorDoPainel(p) {
  return screen.getAllDisplays().find((d) => String(d.id) === p.monitor) ?? screen.getPrimaryDisplay();
}

/** Coloca a janela na borda/posição salvas (ou nas do arraste) e conta pra página onde a pílula fica. */
function posicionarPainel(p = lerPainel(), lugar) {
  if (!painel || painel.isDestroyed()) return;
  const d = lugar?.display ?? monitorDoPainel(p);
  const borda = lugar?.borda ?? p.borda;
  const pos = lugar?.pos ?? p.aoLongo[borda] ?? 0.5;
  const area = d.workArea;
  const vertical = borda === "direita" || borda === "esquerda";
  const w = Math.round(PAINEL_W * p.tamanho);
  const h = Math.min(Math.round(PAINEL_H * p.tamanho), vertical ? area.height : area.width);
  const r = retanguloNaBorda(borda, pos, area, w, h);
  painel.setBounds(r);
  // onde, dentro da janela, fica o ponto da borda: perto do canto da tela a janela encosta no
  // limite, mas a pílula continua onde a pessoa soltou
  const ponto = vertical ? area.y + pos * area.height - r.y : area.x + pos * area.width - r.x;
  painel.webContents.send("painel:lugar", { borda, centro: ponto / p.tamanho });
}

function aplicarPainel(p = lerPainel()) {
  if (p.mostrar === "desligado") {
    if (painel && !painel.isDestroyed()) painel.hide();
    pararVigia();
  } else {
    const w = criarPainel();
    w.webContents.setZoomFactor(p.tamanho);
    posicionarPainel(p);
    if (!w.isVisible()) w.showInactive();
    reforcarTopo();
    ligarVigia();
  }
  if (painel && !painel.isDestroyed()) painel.webContents.send("painel:prefs", p);
}

function criarPainel() {
  if (painel && !painel.isDestroyed()) return painel;
  painel = new BrowserWindow({
    width: PAINEL_W,
    height: PAINEL_H,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    title: "Nexos — painel",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // o som de "terminou" toca sem clique nenhum antes
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  // "screen-saver" fica acima da barra de tarefas também (a pílula pode encostar embaixo)
  painel.setAlwaysOnTop(true, "screen-saver");
  painel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  painel.setIgnoreMouseEvents(true, { forward: true });
  painelDentro = false;
  painel.loadFile(join(here, "painel.html"));
  painel.webContents.on("did-finish-load", () => {
    const p = lerPainel();
    painel.webContents.setZoomFactor(p.tamanho);
    painel.webContents.send("painel:prefs", p);
    posicionarPainel(p);
  });
  painel.on("closed", () => {
    painel = null;
    pararVigia();
  });
  return painel;
}

function dentroDe(r, c, b, z, folga) {
  if (!r) return false;
  return (
    c.x >= b.x + (r.x - folga) * z &&
    c.x <= b.x + (r.x + r.w + folga) * z &&
    c.y >= b.y + (r.y - folga) * z &&
    c.y <= b.y + (r.y + r.h + folga) * z
  );
}

function vigiarPainel() {
  if (!painel || painel.isDestroyed() || !painel.isVisible()) return;
  const c = screen.getCursorScreenPoint();
  if (painelArrastando) {
    // arrastando: gruda na borda mais perto do cursor, no monitor em que ele está
    const d = screen.getDisplayNearestPoint(c);
    const { borda, pos } = bordaMaisProxima(c, d.workArea);
    painelArrastando = { display: d, borda, pos };
    posicionarPainel(lerPainel(), painelArrastando);
    return;
  }
  const agora = Date.now();
  if (agora - painelTopoEm >= PAINEL_TOPO_MS) {
    painelTopoEm = agora;
    reforcarTopo();
  }
  const b = painel.getBounds();
  const z = painel.webContents.getZoomFactor();
  const quente = painelAreas.quentes.some((r) => dentroDe(r, c, b, z, PAINEL_FOLGA));
  const dentro = quente || dentroDe(painelAreas.despertar, c, b, z, 0);
  // clique só é do painel onde há pílula/card; a faixa de despertar só abre, o clique ainda passa
  painel.setIgnoreMouseEvents(!quente, { forward: true });
  if (dentro !== painelDentro) {
    painelDentro = dentro;
    painel.webContents.send("painel:hover", dentro);
  }
}

/** Volta o painel pra faixa "sempre no topo" (SetWindowPos HWND_TOPMOST, sem roubar foco nem mexer no lugar). */
function reforcarTopo() {
  if (!painel || painel.isDestroyed()) return;
  painel.setAlwaysOnTop(true, "screen-saver");
}

function ligarVigia() {
  if (painelVigia) return;
  painelVigia = setInterval(vigiarPainel, PAINEL_VIGIA_MS);
}

function pararVigia() {
  clearInterval(painelVigia);
  painelVigia = null;
}

/** Botão do rodapé / bandeja / Ctrl+Shift+W: desliga, ou volta pro dinâmico. */
function alternarPainel() {
  gravarPainel({ mostrar: lerPainel().mostrar === "desligado" ? "dinamico" : "desligado" });
}

function mostrarNexos() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/*
 * Auto-update (Ticket G, Onda 2): electron-updater lê o feed do GitHub Releases
 * (via `app-update.yml`, gerado pelo electron-builder a partir de `publish:` no
 * electron-builder.yml — repo público, sem token) e baixa a versão nova em
 * background. A instalação (`quitAndInstall`) nunca dispara sozinha: fica
 * pendente até o app fechar com `turno-ativo: false` — ver o gate no listener
 * de "before-quit", mais abaixo. Onda 3 cobre a UI (banner/progresso/"Sobre");
 * aqui só o motor e a ponte de IPC pra ela consumir depois.
 */
let updateReady = false;
/** Versão baixada e esperando instalar — vai no aviso de "instalando". */
let updateVersao = "";
let quittingForUpdate = false;
/** Último evento do updater — a tela "Sobre" pergunta isto ao abrir (`update:status`),
    já que pode ter perdido o evento ao vivo (aberta antes ou depois de ele acontecer). */
let lastUpdateStatus = { state: "idle" };

function sendUpdateStatus(payload) {
  lastUpdateStatus = payload;
  if (win && !win.isDestroyed()) win.webContents.send("update:status", payload);
}

/** Intervalo da procura automática com o app aberto (além da procura na abertura). */
const UPDATE_INTERVALO_MS = 10 * 60 * 1000;
/** Versão que a troca de pasta está baixando agora — barra a segunda checagem de baixar de novo. */
let preparandoTroca = "";

function checarUpdate() {
  // já baixada (esperando reiniciar) ou baixando: procurar de novo só trocaria o aviso de "pronto"
  // por "procurando…" e, no meio do download, dispararia um segundo download da mesma versão
  if (updateReady || preparandoTroca) return Promise.resolve();
  return autoUpdater.checkForUpdates().catch((err) => {
    console.error("[update] check falhou:", err?.message ?? err);
  });
}

/**
 * Atualização por troca de pasta (atualizador.cjs) — o caminho principal quando a instalação é
 * gravável. O electron-updater segue checando a versão; o download do instalador só acontece se a
 * troca não der (Program Files, release sem zip, download corrompido, versão já recusada aqui).
 */
const INSTALACAO = dirname(process.execPath);
const RELEASES_URL = "https://github.com/Yanngc32/Nexos/releases/download";
let updateModoTroca = false;

async function prepararTroca(versao) {
  preparandoTroca = versao;
  try {
    await atualizador.prepararAtualizacao({
      instalacao: INSTALACAO,
      versao,
      baseUrl: RELEASES_URL,
      onProgresso: (percent) => sendUpdateStatus({ state: "downloading", percent, version: versao }),
    });
    updateReady = true;
    updateModoTroca = true;
    updateVersao = versao;
    sendUpdateStatus({ state: "downloaded", version: versao });
    avisarDoUpdate(`Nexos ${versao} pronto`, "Instala quando você reiniciar o Nexos — leva uns segundos.");
  } catch (err) {
    console.error("[update] troca de pasta não deu, indo pelo instalador:", err?.message ?? err);
    autoUpdater.downloadUpdate().catch((e) => console.error("[update] download do instalador falhou:", e?.message ?? e));
  } finally {
    preparandoTroca = "";
  }
}

function setupAutoUpdater() {
  // Sem app-update.yml em dev (só o build empacotado carrega esse recurso) —
  // checkForUpdates lançaria erro de configuração ausente.
  if (!app.isPackaged) return;
  const troca = atualizador.podeTrocar(INSTALACAO);
  // com troca de pasta, quem baixa é o atualizador (e o instalador só se ela falhar)
  autoUpdater.autoDownload = !troca;
  // Controlado na mão pelo gate de turno-ativo abaixo — sem isto o
  // electron-updater instalaria sozinho ao fechar o app, ignorando o gate.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => sendUpdateStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus({ state: "available", version: info.version });
    if (!troca || updateReady || preparandoTroca) return;
    if (atualizador.recusada(INSTALACAO, info.version)) {
      void autoUpdater.downloadUpdate().catch((e) => console.error("[update] download do instalador falhou:", e?.message ?? e));
      return;
    }
    void prepararTroca(info.version);
  });
  autoUpdater.on("update-not-available", () => sendUpdateStatus({ state: "not-available" }));
  autoUpdater.on("download-progress", (p) =>
    sendUpdateStatus({ state: "downloading", percent: p.percent, bytesPerSecond: p.bytesPerSecond }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    // a troca de pasta ficou pronta antes: ela ganha do instalador
    if (updateModoTroca) return;
    updateReady = true;
    updateVersao = info.version || "";
    sendUpdateStatus({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    console.error("[update] falhou:", err?.message ?? err);
    sendUpdateStatus({ state: "error", message: err?.message ?? String(err) });
  });

  void checarUpdate();
  // Cobre quem deixa o app aberto o dia todo sem reiniciar — sem isto, só o
  // check do boot rodaria e updates saídos depois nunca seriam vistos. 10 min: release nova
  // chega no mesmo dia (a checagem é um GET pequeno no feed do GitHub, sem token).
  setInterval(checarUpdate, UPDATE_INTERVALO_MS).unref();
}

function createTray() {
  // Era um PNG minúsculo embutido (praticamente em branco) — invisível na bandeja escura do
  // Windows. Agora é o maguinho (claro, contrasta com fundo escuro), recortado de
  // pets/nexo/mago/idle.png pelo bake.py e já salvo nos tamanhos certos em icons/.
  const img = nativeImage.createFromPath(join(here, "icons", "tray-32.png"));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("Nexos");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: () => win?.show() },
      { label: "Painel de borda", click: () => alternarPainel() },
      { label: "Ligar motor", click: () => void subirMotor() },
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

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

/**
 * Versão nova já extraída de uma sessão anterior (o app fechou com agente trabalhando, ou a
 * máquina desligou): aplica ANTES de subir janela e motor — o "se reiniciar, atualiza". Com turno
 * em voo no motor que ficou de pé, deixa pra depois: trocar a pasta mataria o agente.
 */
async function aplicarTrocaPendenteNoBoot() {
  if (!app.isPackaged || process.platform !== "win32") return false;
  const pronta = atualizador.atualizacaoPronta(INSTALACAO, app.getVersion());
  if (!pronta || atualizador.recusada(INSTALACAO, pronta.versao)) return false;
  if (await turnoAtivo()) return false;
  avisarDoUpdate(`Atualizando pra ${pronta.versao}`, "O Nexos abre em alguns segundos.");
  await pararMotor();
  atualizador.aplicar({ instalacao: INSTALACAO, versao: pronta.versao, versaoAntiga: app.getVersion() });
  quittingForUpdate = true;
  app.quit();
  return true;
}

app.whenReady().then(async () => {
  if (await aplicarTrocaPendenteNoBoot()) return;
  // Barra File/Edit/View/Window/Help é o menu padrão do Electron — o Nexos não usa nenhum item
  // dela (o menu de verdade é a UI própria), então só sobra como ruído acima da janela.
  Menu.setApplicationMenu(null);
  handle("daemon:info", () => daemonInfo());
  // Com `deps`: no botão vale o `pnpm install` (conserta dependência nova sem install); no boot, não.
  handle("daemon:start", async () => {
    const r = await subirMotor({ deps: true });
    // clicar em Ligar com o motor travado entra direto no destrave, sem esperar os 15 s
    if (r.travado) void aoTravar();
    return r;
  });
  handle("daemon:destravar", async (_e, opts) => {
    const forcar = Boolean(opts?.forcar);
    logApp.info("app", forcar ? "pessoa pediu pra matar o PID na mão e reiniciar" : "pessoa escolheu reiniciar o motor travado");
    return reiniciarTravado({ forcar });
  });
  handle("daemon:stop", () => {
    spawnNexo(["down"]).unref();
    return { ok: true };
  });
  handle("profile:login", (_e, id) => spawnNexoLogin(id));
  handle("widget:toggle", () => {
    alternarPainel();
    return { ok: true };
  });
  /* ---------- painel de borda ---------- */
  const doPainel = (event) => painel && !painel.isDestroyed() && event.sender === painel.webContents;
  handle("painel:prefs", () => lerPainel());
  /** Configurações (janela principal) mudando o painel; `aoLongo: null` recentraliza. */
  handle("painel:prefs:set", (_e, patch) => {
    const limpo = patch && typeof patch === "object" ? { ...patch } : {};
    if (limpo.aoLongo === null) {
      delete limpo.aoLongo;
      const p = lerPainel();
      gravarPainel({ ...limpo, aoLongo: { [limpo.borda ?? p.borda]: 0.5 } });
      return lerPainel();
    }
    return gravarPainel(limpo);
  });
  handle("painel:monitores", () => {
    const principal = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      nome: `${d.label || `Monitor ${i + 1}`} · ${d.size.width}×${d.size.height}${d.id === principal ? " (principal)" : ""}`,
    }));
  });
  /** Retângulos quentes (pílula, card) e a faixa que só desperta, em px da página. */
  handle("painel:areas", (event, areas) => {
    if (!doPainel(event)) return { ok: false };
    const ret = (r) =>
      r && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
    painelAreas = {
      quentes: (Array.isArray(areas?.quentes) ? areas.quentes : []).map(ret).filter(Boolean).slice(0, 8),
      despertar: ret(areas?.despertar),
    };
    return { ok: true };
  });
  handle("painel:arrastar", (event, on) => {
    if (!doPainel(event)) return { ok: false };
    if (on) {
      painelArrastando = painelArrastando || { pendente: true };
      return { ok: true };
    }
    const fim = painelArrastando;
    painelArrastando = false;
    if (fim?.display) {
      gravarPainel({ borda: fim.borda, monitor: String(fim.display.id), aoLongo: { [fim.borda]: fim.pos } });
    }
    return { ok: true };
  });
  /** Clique numa conversa do painel: traz o Nexos pra frente já nela. */
  handle("painel:abrir", (event, alvo) => {
    if (!doPainel(event)) return { ok: false };
    mostrarNexos();
    if (alvo && typeof alvo.threadId === "string" && win && !win.isDestroyed()) {
      win.webContents.send("painel:abrir", { threadId: alvo.threadId, projectPath: String(alvo.projectPath ?? "") });
    }
    return { ok: true };
  });
  handle("painel:config", (event) => {
    if (!doPainel(event)) return { ok: false };
    mostrarNexos();
    if (win && !win.isDestroyed()) win.webContents.send("nexo:config", "painel");
    return { ok: true };
  });
  handle("painel:notificar", (event, n) => {
    if (!doPainel(event) || !Notification.isSupported()) return { ok: false };
    const aviso = new Notification({ title: String(n?.titulo ?? "Nexos").slice(0, 120), body: String(n?.corpo ?? "").slice(0, 300), silent: true });
    aviso.on("click", () => {
      mostrarNexos();
      if (n?.threadId && win && !win.isDestroyed()) {
        win.webContents.send("painel:abrir", { threadId: String(n.threadId), projectPath: String(n.projectPath ?? "") });
      }
    });
    aviso.show();
    return { ok: true };
  });
  /** A janela principal abriu uma conversa: o "terminou" dela no painel já foi visto. */
  handle("thread:vista", (_e, threadId) => {
    if (painel && !painel.isDestroyed() && typeof threadId === "string") painel.webContents.send("painel:vista", threadId);
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
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error("URL inválida");
    }
    // https sempre; http só em loopback — é o servidor efêmero do próprio login OAuth
    // (RFC 8252), nunca um link de fora. Fora isso: nada de file:, javascript: ou cmd
    // disfarçado de link.
    const loopback = u.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(u.hostname);
    if (u.protocol !== "https:" && !loopback) throw new Error("URL inválida");
    await shell.openExternal(url);
    return { ok: true };
  });
  /**
   * Abre uma PASTA no gerenciador de arquivos do SO (menu de botão direito do
   * repositório). Só diretório que existe: arquivo solto abriria no programa
   * associado, que é executar conteúdo do disco por caminho vindo do renderer.
   */
  handle("shell:reveal", async (_e, raw) => {
    const alvo = String(raw ?? "");
    if (!alvo) throw new Error("Caminho vazio");
    const info = await stat(alvo).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Pasta inexistente");
    const erro = await shell.openPath(resolve(alvo));
    if (erro) throw new Error(erro);
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
  /**
   * Escolhe um .zip (export de outra ferramenta, ver POST /v1/import/zip) e devolve o
   * conteúdo já em base64 — o body de fetch é só JSON, sem multipart nesta API.
   */
  handle("file:pickZipBase64", async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const buf = await readFile(r.filePaths[0]);
    return { name: r.filePaths[0].split(sep).pop(), base64: buf.toString("base64") };
  });
  /** Imagem pro ícone do projeto (menu do projeto → "Escolher ícone…"), em base64 pro daemon guardar. */
  handle("file:pickImageBase64", async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Imagem", extensions: ["svg", "png", "ico", "webp", "jpg", "jpeg"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const buf = await readFile(r.filePaths[0]);
    return { name: r.filePaths[0].split(sep).pop(), base64: buf.toString("base64") };
  });
  /**
   * Print de um card do design system pro agente (`nexo_ds_print`): janela INVISÍVEL, sem node,
   * sandbox, e o documento já vem com CSP sem script. Vai por arquivo temporário (não data:) pra
   * `<base href="file:///projeto/">` achar o logo real do projeto.
   */
  handle("ds:print", async (_e, { html, largura }) => {
    const larg = Math.max(320, Math.min(1600, Number(largura) || 764));
    const arquivo = join(tmpdir(), `nexos-ds-print-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.html`);
    await writeFile(arquivo, String(html ?? ""), "utf8");
    const w = new BrowserWindow({
      show: false,
      width: larg,
      height: 600,
      useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await w.loadFile(arquivo);
      // fontes do Google chegam depois do load: espera elas (ou 3s, o que vier antes)
      await w.webContents.executeJavaScript("Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))]).then(() => 1)");
      const altura = await w.webContents.executeJavaScript("Math.ceil(document.body.getBoundingClientRect().height)");
      const alt = Math.max(40, Math.min(4000, Number(altura) || 600));
      w.setContentSize(larg, alt);
      await new Promise((r) => setTimeout(r, 150));
      const img = await w.webContents.capturePage();
      return { base64: img.toJPEG(85).toString("base64"), largura: larg, altura: alt };
    } finally {
      w.destroy();
      void rm(arquivo, { force: true }).catch(() => {});
    }
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
  handle("update:check", async () => {
    if (!app.isPackaged) return { ok: false, error: "Update só roda em build empacotado" };
    await checarUpdate();
    return { ok: true };
  });
  handle("update:status", () => ({ ready: updateReady, ...lastUpdateStatus }));
  handle("app:version", () => app.getVersion());
  // Empacotado, o CHANGELOG.md vai em extraResources (electron-builder.yml); em dev, o da raiz do repo.
  handle("app:changelog", () => {
    const path = app.isPackaged ? join(process.resourcesPath, "CHANGELOG.md") : join(here, "..", "..", "CHANGELOG.md");
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  });
  /**
   * "Reiniciar agora" (Onda 3): só um `app.quit()` — o gate de "before-quit" já
   * decide sozinho entre `quitAndInstall` (turno livre) e fechar normal (turno
   * ativo, update fica pendente pro próximo fechamento). Sem update pendente,
   * fecha o app como qualquer outro `app.quit()`.
   */
  handle("app:quit", () => {
    app.quit();
    return { ok: true };
  });
  // em dev o motor de pé pode ser de uma rodada anterior, com código velho: sobe de novo
  void (DEV ? reiniciarMotorDev() : subirMotor());
  // A vigia do motor não depende da janela: minimizada ou na bandeja, travou, destrava.
  setInterval(() => void daemonInfo(), 5000).unref();
  createWindow();
  if (app.isPackaged && process.platform === "win32") {
    // "subi de pé" pro script da troca poder apagar a versão antiga (sem isso ele volta a antiga)
    win?.webContents.once("did-finish-load", () => atualizador.confirmarBoot(INSTALACAO));
    setTimeout(() => atualizador.limparRestos(INSTALACAO), 60_000).unref();
  }
  if (DEV) ligarRecargaDev();
  createTray();
  setupAutoUpdater();
  if (!SHOT || process.env.NEXOS_SHOT_ALVO === "painel") {
    aplicarPainel();
    // monitor entrou, saiu ou mudou de resolução/escala: a pílula volta pra borda certa
    const reposicionar = () => aplicarPainel();
    screen.on("display-added", reposicionar);
    screen.on("display-removed", reposicionar);
    screen.on("display-metrics-changed", reposicionar);
  }
});

/**
 * Gate do auto-update: sem update pendente (`updateReady`), fecha normal — é o
 * caminho de sempre. Com update pendente, intercepta o primeiro `before-quit`
 * pra checar `turno-ativo` (assíncrono, por isso o `preventDefault`): turno
 * livre chama `quitAndInstall` (fecha, instala, reabre sozinho); turno ativo
 * só deixa fechar normal — update fica pendente e o próximo boot já reencontra
 * o instalador em cache (electron-updater não baixa de novo).
 * `quittingForUpdate` evita loop: o `app.quit()` do ramo "turno ativo" reemite
 * este mesmo evento, e da segunda vez ele precisa passar direto.
 */
/** Notificação nativa do Windows — continua na tela depois que o app fecha. */
function avisarDoUpdate(titulo, corpo) {
  try {
    if (Notification.isSupported()) new Notification({ title: titulo, body: corpo, silent: true }).show();
  } catch {
    // sem notificação (desligada no Windows): segue a atualização mesmo assim
  }
}

app.on("before-quit", (event) => {
  killShell();
  if (!updateReady || quittingForUpdate) return;
  event.preventDefault();
  quittingForUpdate = true;
  void (async () => {
    if (await turnoAtivo()) {
      avisarDoUpdate("Atualização adiada", "Tinha agente trabalhando, então o Nexos só fechou. A versão nova instala no próximo reinício.");
      app.quit();
      return;
    }
    if (updateModoTroca) {
      // O script espera este processo sair, troca as pastas e reabre. O motor sai antes: ele roda
      // do mesmo Nexos.exe e seguraria a pasta (o script ainda mata o que sobrar dela).
      avisarDoUpdate(`Atualizando pra ${updateVersao}`, "O Nexos volta em alguns segundos.");
      await pararMotor();
      atualizador.aplicar({ instalacao: INSTALACAO, versao: updateVersao, versaoAntiga: app.getVersion() });
      app.quit();
      return;
    }
    /*
     * Instalação silenciosa troca os arquivos sem janela nenhuma: sem este aviso parecia que o
     * app tinha morrido. A notificação fica no Windows depois que o app sai.
     */
    avisarDoUpdate(
      `Instalando o Nexos ${updateVersao}`.trim(),
      "Leva 1–2 minutos. O Nexos abre sozinho quando terminar — não precisa abrir de novo.",
    );
    // `quitAndInstall(isSilent, isForceRunAfter)`: sem os dois `true`, o NSIS abre o
    // instalador visível de novo (assistente completo, pede clique em "Concluir") em vez de
    // instalar quieto e reabrir sozinho — o oposto do que "atualização automática" promete.
    // O motor sai antes: com ele de pé o instalador não troca os arquivos dele (ver pararMotor).
    // O mínimo de 400ms deixa a notificação sair antes do processo morrer.
    await Promise.all([pararMotor(), new Promise((r) => setTimeout(r, 400))]);
    autoUpdater.quitAndInstall(true, true);
  })();
});
app.on("window-all-closed", () => {
  killShell();
  if (process.platform !== "darwin") app.quit();
});
