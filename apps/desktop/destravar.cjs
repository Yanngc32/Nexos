/**
 * Motor travado: aceita a conexão e não responde (event loop parado). Antes, o `nexos up` via a
 * porta ocupada, dizia "já ligado", e a tela ficava "Desligado" até alguém matar o processo na mão.
 *
 * Quem destrava é o app, porque só ele consegue: o motor travado não atende nem o `/health`, e o
 * `up` novo não pode sair matando (ver `startDaemon` no daemon). Três peças, todas testáveis
 * sem Electron:
 *
 * - `criarVigia`: conta há quanto tempo o motor está `sem_resposta` e avisa quando passa de 15 s.
 * - `confirmarPid`: o PID de `run/daemon.pid` é mesmo o nosso motor? Só assim o app mata sozinho.
 * - `destravar`: mata, espera a porta liberar (com teto) e devolve — quem sobe o motor novo é o
 *   `subirMotor` do main.
 *
 * **Quando matar sem perguntar (decisão C, híbrido):** o turno em voo já está perdido de qualquer
 * jeito (a saída do CLI não é lida, e o motor novo roda `reapRunPids`). Então só pergunta quando
 * há perda real: algum `run/*.pid` vivo além do `daemon.pid`. Dá pra saber disso sem falar com o
 * motor travado — perguntar `turno-ativo` pra ele não teria resposta.
 */
const { spawnSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { connect } = require("node:net");
const { join } = require("node:path");

/** Tempo seguido em `sem_resposta` antes de destravar. Folga pra uma pausa longa legítima. */
const LIMITE_TRAVADO_MS = 15_000;
/** Teto pra porta liberar depois do kill. */
const TETO_PORTA_MS = 10_000;
/** Folga entre o processo nascer e o `.pid` ser gravado (mesma regra de `processos.ts`). */
const FOLGA_PID_MS = 10_000;

function pidPath(home) {
  return join(home, "run", "daemon.pid");
}

/** `{ pid, gravado }` de `run/daemon.pid`, ou `null` se não há arquivo legível. */
function lerPidDoMotor(home) {
  try {
    const caminho = pidPath(home);
    const pid = Number(readFileSync(caminho, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, gravado: statSync(caminho).mtimeMs };
  } catch {
    return null;
  }
}

function vivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Linha de comando e hora de criação (epoch ms) do processo; `null` se não existe. Só Windows. */
function infoProcesso(pid) {
  if (process.platform !== "win32") {
    if (!vivo(pid)) return null;
    const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? { comando: r.stdout.trim(), criado: undefined } : null;
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'`,
    "if ($p) { [pscustomobject]@{ c = $p.CommandLine; t = [int64]($p.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } | ConvertTo-Json -Compress }",
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { comando: String(j.c ?? ""), criado: Number(j.t) || undefined };
  } catch {
    return null;
  }
}

/**
 * O ponto de entrada do motor, empacotado ou em dev:
 * - instalador: `<resources>/daemon/dist/nexos.mjs up`
 * - dev pelo app: `electron.exe --require …tsx… --import …tsx/loader… apps/daemon/src/index.ts up`
 *   (quem grava o `daemon.pid` é o filho do tsx, com o loader na linha)
 * - dev pelo terminal: `scripts/nexo.mjs up`
 * Conferir só `nexos.mjs` recusaria todo motor de dev.
 */
const ENTRADAS = [/[\\/]dist[\\/]nexos\.mjs\b/i, /[\\/]scripts[\\/]nexo\.mjs\b/i, /[\\/]daemon[\\/]src[\\/]index\.ts\b/i];

/**
 * `{ ok: true }` só se o PID é o nosso motor: linha de comando com `up` e o ponto de entrada, e
 * nascido antes de gravar o `.pid` (senão é PID reusado por outro processo).
 */
function confirmarPid(pid, gravado, info) {
  if (!info) return { ok: false, motivo: "processo não existe" };
  const cmd = info.comando || "";
  if (!ENTRADAS.some((re) => re.test(cmd))) return { ok: false, motivo: "não é o motor do Nexos" };
  if (!/\sup(\s|"|$)/.test(cmd)) return { ok: false, motivo: "linha de comando sem `up`" };
  if (info.criado !== undefined && gravado !== undefined && info.criado > gravado + FOLGA_PID_MS) {
    return { ok: false, motivo: "PID reusado (processo nasceu depois do daemon.pid)" };
  }
  return { ok: true };
}

/** `run/*.pid` vivos, menos o `daemon.pid`: agente ou serviço que o reinício derrubaria. */
function agentesVivos(home, estaVivo = vivo) {
  const dir = join(home, "run");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const arquivo of readdirSync(dir)) {
    if (!arquivo.endsWith(".pid") || arquivo === "daemon.pid") continue;
    try {
      const pid = Number(readFileSync(join(dir, arquivo), "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && estaVivo(pid)) out.push({ arquivo, pid });
    } catch {
      /* sumiu no meio */
    }
  }
  return out;
}

/** Árvore inteira: em dev o motor é filho do tsx, e o tsx sai sozinho quando o filho morre. */
function matarArvore(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* já morreu */
  }
}

const HEALTH_TIMEOUT_MS = 3000;

/**
 * `ok` | `fechado` (ninguém escuta, ou não é um motor saudável) | `sem_resposta` (estourou o
 * prazo: motor travado). Os dois últimos eram o mesmo "desligado", e a tela convidava a clicar
 * em Ligar — que também não adiantava.
 */
async function saudeDoMotor(port, { checagem = "health", log, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const inicio = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    log?.debug("saude", `checagem ${checagem}: ${res.status}`, { ms: Date.now() - inicio });
    return res.ok ? "ok" : "fechado";
  } catch (err) {
    if (err?.name !== "TimeoutError" && err?.name !== "AbortError") return "fechado";
    log?.debug("saude", `checagem ${checagem} estourou o prazo`, { checagem, ms: Date.now() - inicio });
    return "sem_resposta";
  }
}

/** A porta está livre quando conectar é recusado. */
function portaLivre(port) {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const fim = (livre) => {
      s.destroy();
      resolve(livre);
    };
    s.once("connect", () => fim(false));
    s.once("error", () => fim(true));
    s.setTimeout(1000, () => fim(false));
  });
}

/**
 * Conta o tempo seguido em `sem_resposta`. Cada `registrar(estado)` devolve o que fazer:
 * `"destravar"` uma vez só, quando passa do limite (volta a armar depois que o motor responde ou
 * fecha). Loga mudança de estado (info) e o 1º timeout de uma sequência (aviso).
 */
function criarVigia({ log, agora = () => Date.now(), limiteMs = LIMITE_TRAVADO_MS } = {}) {
  let estado = "";
  let desde = 0;
  let disparou = false;
  return {
    registrar(novo) {
      const t = agora();
      if (novo !== estado) {
        if (estado) log?.info("saude", `motor: ${estado} → ${novo}`);
        if (novo === "sem_resposta") log?.aviso("saude", "motor não respondeu ao /health", { checagem: "daemonInfo" });
        estado = novo;
        desde = t;
        disparou = false;
      }
      if (novo === "sem_resposta" && !disparou && t - desde >= limiteMs) {
        disparou = true;
        log?.aviso("app", `motor sem resposta há ${Math.round((t - desde) / 1000)} s`, { ms: t - desde });
        return "destravar";
      }
      return "nada";
    },
    /** Epoch ms de quando entrou em `sem_resposta` (0 se não está). */
    travadoDesde: () => (estado === "sem_resposta" ? desde : 0),
    estado: () => estado,
  };
}

/**
 * Mata o motor travado e espera a porta liberar. Não sobe o novo (quem sobe é o main).
 *
 * `forcar`: a pessoa pediu pra matar na mão um PID que não passou na confirmação — mesmo fluxo
 * de "porta ocupada" dos serviços. Sem isso, PID não confirmado NUNCA morre.
 *
 * Devolve `{ ok, pid, motivo?, recusado?, ms? }`.
 */
async function destravar({
  home,
  port,
  log,
  forcar = false,
  deps = {},
}) {
  const d = {
    lerPid: lerPidDoMotor,
    info: infoProcesso,
    matar: matarArvore,
    portaLivre,
    agora: () => Date.now(),
    esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
    tetoPortaMs: TETO_PORTA_MS,
    ...deps,
  };
  const lido = d.lerPid(home);
  if (!lido) {
    log?.aviso("app", "daemon.pid ausente, não sei quem segura a porta", { porta: port });
    return { ok: false, pid: null, recusado: true, motivo: "sem daemon.pid" };
  }
  const { pid, gravado } = lido;
  const info = d.info(pid);
  const conf = confirmarPid(pid, gravado, info);
  if (conf.ok) log?.info("app", `PID ${pid} confirmado como o motor`, { pid });
  else log?.aviso("app", `PID ${pid} recusado: ${conf.motivo}`, { pid, motivo: conf.motivo, comando: info?.comando ?? "" });
  if (!conf.ok && !forcar) return { ok: false, pid, recusado: true, motivo: conf.motivo };
  if (!conf.ok) log?.aviso("app", `matando PID ${pid} a pedido, sem confirmação`, { pid });

  const inicio = d.agora();
  d.matar(pid);
  log?.info("app", `kill enviado pro PID ${pid}`, { pid });
  while (d.agora() - inicio < d.tetoPortaMs) {
    if (await d.portaLivre(port)) {
      const ms = d.agora() - inicio;
      log?.info("app", `porta ${port} liberada em ${ms} ms`, { pid, porta: port, ms });
      return { ok: true, pid, ms };
    }
    await d.esperar(200);
  }
  log?.erro("app", `porta ${port} não liberou em ${d.tetoPortaMs} ms depois do kill`, { pid, porta: port });
  return { ok: false, pid, motivo: "porta não liberou" };
}

module.exports = {
  HEALTH_TIMEOUT_MS,
  LIMITE_TRAVADO_MS,
  agentesVivos,
  confirmarPid,
  criarVigia,
  destravar,
  infoProcesso,
  lerPidDoMotor,
  portaLivre,
  saudeDoMotor,
};
