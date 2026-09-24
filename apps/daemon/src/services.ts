import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProbeResult, ServiceConflito, ServiceDef, ServiceStatus, ServicesReport } from "@nexos/shared";
import { loadConfig, saveConfig } from "./config.ts";
import { ensureHome, projectKey } from "./home.ts";
import { assertSlug } from "./ids.ts";
import { killByPort, killTree, nomeDoProcesso, portasEscutando } from "./kill-tree.ts";

/** Nome do arquivo que declara os serviços, na raiz do projeto. */
export const SERVICES_FILE = "nexos.json";

/**
 * Nome antigo (produto se chamava Nexos até a v0.1.0). Projeto que já tinha um `nexo.json`
 * antes do rename continua funcionando — sem isto, todo projeto existente perderia os
 * serviços declarados só por causa da atualização do app. Só leitura: nunca escrevemos
 * nem migramos automaticamente um arquivo do usuário dentro do repositório dele.
 */
const SERVICES_FILE_ANTIGO = "nexo.json";

/** Teto do log por serviço. Log de servidor é volátil: não vai pro disco. */
const LOG_CAP_BYTES = 64 * 1024;

const PROBE_TIMEOUT_MS = 1500;

/** Sonda só fala com loopback: fora isso o endpoint viraria proxy aberto. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export const servicesBus = new EventEmitter();

/** Servidor não lê stdin: spawn com stdin "ignore". */
type SvcChild = ChildProcessByStdio<null, Readable, Readable>;

type Live = {
  child: SvcChild;
  pid: number;
  startedAt: string;
  log: string;
  /** De onde veio: a lista de processos (processos.ts) mostra serviço de qualquer projeto. */
  projectPath: string;
  id: string;
  name: string;
  cmd: string;
  porta?: number;
  exitCode?: number;
  /**
   * Porta que a saída do processo revelou de verdade — ferramenta como o Vite cai pra
   * próxima porta livre sem avisar por outro canal quando a declarada já está ocupada
   * (processo zumbi de uma subida anterior). Sem isso, `killByPort` mira só na porta do
   * `nexos.json`, que pode não ser onde o processo ATUAL está escutando.
   */
  actualPort?: number;
};

/** "http://localhost:5174" ou "http://127.0.0.1:8004" na saída do processo. */
const PORT_NA_SAIDA_RE = /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/;

/** Chave de processo: o daemon é global, vários projetos podem estar abertos. */
function key(projectPath: string, id: string): string {
  return `${projectKey(projectPath)}::${id}`;
}

/** Nome do canal do bus pra este projeto: é por ele que o SSE escuta. */
export function servicesChannel(projectPath: string): string {
  return projectKey(projectPath);
}

const lives = new Map<string, Live>();

/** Porta ocupada na última tentativa de subir — o serviço ficou parado esperando a pessoa decidir. */
const conflitos = new Map<string, ServiceConflito>();

/**
 * Troca de porta feita pela interface, por serviço (`key`). Mora no home do Nexos e não no
 * `nexos.json`: o arquivo é do repositório da pessoa e o Nexos não escreve nele.
 */
function trocasPath(home: string): string {
  return join(home, "servicos-portas.json");
}

function lerTrocas(home: string): Record<string, number> {
  try {
    const o = JSON.parse(readFileSync(trocasPath(home), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter((e): e is [string, number] => Number.isInteger(e[1])));
  } catch {
    return {};
  }
}

function gravarTroca(home: string, k: string, porta: number | undefined): void {
  const trocas = lerTrocas(home);
  if (porta === undefined) delete trocas[k];
  else trocas[k] = porta;
  writeFileSync(trocasPath(home), JSON.stringify(trocas, null, 2), "utf8");
}

/**
 * O `cmd` rodando em outra porta, ou `null` se não dá pra saber onde a porta entra.
 * - A porta antiga aparece no comando (`--port 8004`, `:8004`): troca ali.
 * - `npm/pnpm/yarn/bun <script>` sem porta (o `npm run dev` do Vite): repassa `--port` pro script.
 * - Qualquer outra coisa (ex.: `docker compose up`): não dá — a porta mora em outro arquivo.
 */
export function comandoNaPorta(cmd: string, antiga: number, nova: number): string | null {
  const naLinha = new RegExp(`(?<![\\d.])${antiga}(?!\\d)`, "g");
  if (naLinha.test(cmd)) return cmd.replace(naLinha, String(nova));
  if (/^\s*npm\s/i.test(cmd)) return /\s--(\s|$)/.test(cmd) ? `${cmd} --port ${nova}` : `${cmd} -- --port ${nova}`;
  if (/^\s*(pnpm|yarn|bun)\s/i.test(cmd)) return `${cmd} --port ${nova}`;
  return null;
}

function urlNaPorta(url: string, porta: number): string {
  try {
    const u = new URL(url);
    u.port = String(porta);
    return u.href;
  } catch {
    return url;
  }
}

/** O serviço como vai rodar: com a troca de porta aplicada (cmd, url e `PORT`), se houver. */
function comTroca(def: ServiceDef, projectPath: string, home: string): { def: ServiceDef; trocada: boolean } {
  const nova = lerTrocas(home)[key(projectPath, def.id)];
  const antiga = portOf(def.url);
  if (nova === undefined || antiga === undefined || nova === antiga) return { def, trocada: false };
  const cmd = comandoNaPorta(def.cmd, antiga, nova);
  if (cmd === null) return { def, trocada: false };
  return {
    def: { ...def, cmd, url: urlNaPorta(def.url as string, nova), env: { ...(def.env ?? {}), PORT: String(nova) } },
    trocada: true,
  };
}

/** Primeira porta livre depois de `porta`, olhando uma foto só do netstat. */
function proximaLivre(porta: number, ocupadas: Map<number, number[]>): number | undefined {
  for (let p = porta + 1; p <= Math.min(porta + 100, 65535); p++) if (!ocupadas.has(p)) return p;
  return undefined;
}

function pidPath(projectPath: string, id: string, home: string): string {
  const hash = createHash("sha1").update(projectKey(projectPath)).digest("hex").slice(0, 10);
  return join(home, "run", `svc-${hash}-${id}.pid`);
}

export function isTrusted(projectPath: string, home: string): boolean {
  const alvo = projectKey(projectPath);
  return loadConfig(home).trustedProjects.some((p) => projectKey(p) === alvo);
}

export function trustProject(projectPath: string, home: string): string[] {
  const cfg = loadConfig(home);
  if (isTrusted(projectPath, home)) return cfg.trustedProjects;
  return saveConfig(home, { trustedProjects: [...cfg.trustedProjects, resolve(projectPath)] }).trustedProjects;
}

/** Lê e valida o nexos.json (ou o `nexo.json` antigo, se só ele existir). Lança com motivo legível; nunca devolve serviço meio válido. */
export function readServiceDefs(projectPath: string): ServiceDef[] {
  const raiz = resolve(projectPath);
  const path = existsSync(join(raiz, SERVICES_FILE)) ? join(raiz, SERVICES_FILE) : join(raiz, SERVICES_FILE_ANTIGO);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${SERVICES_FILE} inválido: ${(e as Error).message}`);
  }
  const list = (raw as { services?: unknown })?.services;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${SERVICES_FILE}: "services" precisa ser lista`);
  const vistos = new Set<string>();
  const out: ServiceDef[] = [];
  for (const item of list) {
    const def = validateDef(item, projectPath);
    if (vistos.has(def.id)) throw new Error(`${SERVICES_FILE}: id repetido "${def.id}"`);
    vistos.add(def.id);
    out.push(def);
  }
  return out;
}

function validateDef(item: unknown, projectPath: string): ServiceDef {
  if (!item || typeof item !== "object") throw new Error(`${SERVICES_FILE}: serviço precisa ser objeto`);
  const o = item as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) throw new Error(`${SERVICES_FILE}: serviço sem "id"`);
  try {
    assertSlug(id);
  } catch {
    throw new Error(`${SERVICES_FILE}: id inválido "${id}" (use a-z, 0-9 e hífen)`);
  }
  const cmd = typeof o.cmd === "string" ? o.cmd.trim() : "";
  if (!cmd) throw new Error(`${SERVICES_FILE}: serviço "${id}" sem "cmd"`);
  const cwd = typeof o.cwd === "string" && o.cwd.trim() ? o.cwd.trim() : ".";
  assertInsideProject(cwd, projectPath, id);
  const url = typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined;
  const env: Record<string, string> = {};
  if (o.env && typeof o.env === "object") {
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  return {
    id,
    ...(typeof o.name === "string" && o.name.trim() ? { name: o.name.trim() } : {}),
    cmd,
    cwd,
    ...(url ? { url } : {}),
    autostart: o.autostart === true,
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** Mesma regra do boundPath do desktop: serviço não roda fora da pasta do projeto. */
function assertInsideProject(cwd: string, projectPath: string, id: string): void {
  const root = resolve(projectPath);
  const alvo = isAbsolute(cwd) ? resolve(cwd) : resolve(root, cwd);
  const rel = relative(root, alvo);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${SERVICES_FILE}: cwd de "${id}" escapa da pasta do projeto`);
  }
}

export function portOf(url?: string): number | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

function statusOf(declarado: ServiceDef, projectPath: string, home: string): ServiceStatus {
  const { def, trocada } = comTroca(declarado, projectPath, home);
  const k = key(projectPath, def.id);
  const live = lives.get(k);
  const antiga = portOf(declarado.url);
  const conflito = conflitos.get(k);
  const base: ServiceStatus = {
    id: def.id,
    name: def.name ?? def.id,
    cmd: def.cmd,
    cwd: def.cwd ?? ".",
    ...(def.url ? { url: def.url } : {}),
    autostart: def.autostart === true,
    proc: "off",
    port: "unknown",
    ...(portOf(def.url) !== undefined ? { portNumber: portOf(def.url) } : {}),
    ...(trocada ? { portaTrocada: true } : {}),
    ...(antiga !== undefined && comandoNaPorta(declarado.cmd, antiga, antiga + 1) !== null ? { podeTrocarPorta: true } : {}),
    ...(conflito ? { conflito } : {}),
  };
  if (!live) return base;
  if (live.exitCode !== undefined) {
    return { ...base, proc: "exited", exitCode: live.exitCode };
  }
  const real = live.actualPort && live.actualPort !== base.portNumber ? { portaReal: live.actualPort } : {};
  return { ...base, ...real, proc: "running", pid: live.pid, startedAt: live.startedAt };
}

export function listServices(projectPath: string, home: string): ServicesReport {
  const trusted = isTrusted(projectPath, home);
  try {
    const defs = readServiceDefs(projectPath);
    return { projectPath: resolve(projectPath), trusted, services: defs.map((d) => statusOf(d, projectPath, home)) };
  } catch (e) {
    return { projectPath: resolve(projectPath), trusted, error: (e as Error).message, services: [] };
  }
}

function findDef(projectPath: string, id: string): ServiceDef {
  const def = readServiceDefs(projectPath).find((d) => d.id === id);
  if (!def) {
    const err = new Error(`serviço não declarado: ${id}`);
    (err as Error & { status: number }).status = 404;
    throw err;
  }
  return def;
}

function emitStatus(projectPath: string, id: string, home: string): void {
  let status: ServiceStatus | undefined;
  try {
    status = statusOf(findDef(projectPath, id), projectPath, home);
  } catch {
    return;
  }
  servicesBus.emit(projectKey(projectPath), { type: "status", service: status });
}

function appendLog(projectPath: string, id: string, chunk: string): void {
  const live = lives.get(key(projectPath, id));
  if (!live) return;
  live.log = (live.log + chunk).slice(-LOG_CAP_BYTES);
  servicesBus.emit(projectKey(projectPath), { type: "log", id, chunk });
}

export type StartOpts = {
  /** Porta ocupada: mata quem está nela e sobe. */
  matar?: boolean;
  /** Sobe sem olhar a porta — Docker, por ex., segura a própria porta e sobe por cima. */
  ignorarPorta?: boolean;
};

export function startService(projectPath: string, id: string, home: string, opts: StartOpts = {}): ServiceStatus {
  ensureHome(home);
  const declarado = findDef(projectPath, id);
  const k = key(projectPath, id);
  const atual = lives.get(k);
  // idempotente: já rodando não spawna segundo processo
  if (atual && atual.exitCode === undefined) return statusOf(declarado, projectPath, home);
  const { def } = comTroca(declarado, projectPath, home);

  /*
   * Porta ocupada ANTES de subir: sem isto o Vite pulava pra próxima porta calado, o uvicorn
   * morria com "address already in use" e o painel mostrava a porta errada. Agora o serviço
   * fica parado com o conflito dito (quem segura, e uma porta livre) e a pessoa decide.
   */
  const porta = portOf(def.url);
  conflitos.delete(k);
  let aviso = "";
  if (porta !== undefined && !opts.ignorarPorta) {
    const { portas } = portasEscutando();
    const pids = portas.get(porta) ?? [];
    if (pids.length && opts.matar) {
      const r = killByPort(porta);
      aviso = `[nexo] porta ${porta} liberada: matei ${r.pids.join(", ") || "nada"}\n`;
    } else if (pids.length) {
      const livre = proximaLivre(porta, portas);
      conflitos.set(k, {
        porta,
        processos: pids.map((pid) => ({ pid, nome: nomeDoProcesso(pid) })),
        ...(livre !== undefined ? { livre } : {}),
      });
      emitStatus(projectPath, id, home);
      return statusOf(declarado, projectPath, home);
    }
  }

  const cwd = resolve(projectPath, def.cwd ?? ".");
  /*
   * `shell: true` de propósito: `cmd` é linha de comando escrita por quem
   * declarou o serviço (tem pipe, &&, aspas) e o Node cuida das aspas por
   * plataforma — montar `cmd.exe /d /s /c` na mão quebra caminho com espaço.
   * O controle de quem pode executar isso é o gate de confiança do projeto.
   */
  const child = spawn(def.cmd, {
    cwd,
    env: { ...process.env, ...(def.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  }) as SvcChild;

  const live: Live = {
    child,
    pid: child.pid ?? 0,
    startedAt: new Date().toISOString(),
    log: aviso,
    projectPath: resolve(projectPath),
    id,
    name: def.name ?? def.id,
    cmd: def.cmd,
    ...(porta !== undefined ? { porta } : {}),
  };
  lives.set(k, live);
  if (child.pid) writeFileSync(pidPath(projectPath, id, home), String(child.pid), "utf8");

  function lerPortaDaSaida(chunk: string): void {
    const m = PORT_NA_SAIDA_RE.exec(chunk);
    if (m) live.actualPort = Number(m[1]);
  }
  child.stdout.on("data", (b: Buffer) => {
    const chunk = b.toString("utf8");
    lerPortaDaSaida(chunk);
    appendLog(projectPath, id, chunk);
  });
  child.stderr.on("data", (b: Buffer) => {
    const chunk = b.toString("utf8");
    lerPortaDaSaida(chunk);
    appendLog(projectPath, id, chunk);
  });
  child.on("error", (err) => {
    appendLog(projectPath, id, `\n[nexo] falha ao rodar: ${err.message}\n`);
    live.exitCode = -1;
    emitStatus(projectPath, id, home);
  });
  child.on("close", (code) => {
    live.exitCode = code ?? 0;
    clearPid(projectPath, id, home);
    appendLog(projectPath, id, `\n[nexo] saiu com código ${live.exitCode}\n`);
    emitStatus(projectPath, id, home);
  });

  emitStatus(projectPath, id, home);
  return statusOf(declarado, projectPath, home);
}

function clearPid(projectPath: string, id: string, home: string): void {
  const path = pidPath(projectPath, id, home);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export function stopService(projectPath: string, id: string, home: string): ServiceStatus {
  const declarado = findDef(projectPath, id);
  const { def } = comTroca(declarado, projectPath, home);
  const k = key(projectPath, id);
  conflitos.delete(k);
  const live = lives.get(k);
  if (live && live.exitCode === undefined) {
    if (live.pid) killTree(live.pid);
    else if (!live.child.killed) live.child.kill();
    live.exitCode = live.exitCode ?? 0;
  }
  // reforço: `npm run <script>` empilha processo no Windows, e o que de fato escuta a
  // porta às vezes sobrevive ao killTree (ver kill-tree.ts). Ir direto na porta fecha esse
  // buraco sem depender de a árvore de PID estar intacta. Tenta a porta DECLARADA (pega
  // zumbi de uma subida antiga, que é o que empurrou o processo atual pra outra porta) e a
  // porta REAL que a saída revelou (Vite cai pra próxima porta livre sem outro aviso).
  const portas = new Set([portOf(def.url), live?.actualPort].filter((p): p is number => Boolean(p)));
  for (const porta of portas) {
    const r = killByPort(porta);
    // temporário, pra diagnosticar ao vivo: some assim que confirmarmos que funciona
    appendLog(
      projectPath,
      id,
      `\n[nexo] killByPort(${porta}): ${r.erro ?? `pids encontrados: ${r.pids.join(", ") || "nenhum"}`}\n`,
    );
  }
  clearPid(projectPath, id, home);
  emitStatus(projectPath, id, home);
  return statusOf(declarado, projectPath, home);
}

/**
 * Troca a porta do serviço (ver `comTroca`). A porta do `nexos.json` desfaz a troca. Rodando,
 * reinicia na porta nova; parado, só grava e vale na próxima subida.
 */
export async function trocarPorta(projectPath: string, id: string, porta: number, home: string): Promise<ServiceStatus> {
  const def = findDef(projectPath, id);
  const erro = (msg: string): Error => Object.assign(new Error(msg), { status: 400 });
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) throw erro("porta inválida (1–65535)");
  const antiga = portOf(def.url);
  if (antiga === undefined) throw erro(`"${id}" não tem url com porta no ${SERVICES_FILE}`);
  if (porta !== antiga && comandoNaPorta(def.cmd, antiga, porta) === null) {
    throw erro(`não sei onde a porta entra em "${def.cmd}" — ajuste a porta no ${SERVICES_FILE} ou no arquivo que o comando lê`);
  }
  const k = key(projectPath, id);
  gravarTroca(home, k, porta === antiga ? undefined : porta);
  conflitos.delete(k);
  const live = lives.get(k);
  if (live && live.exitCode === undefined) return restartService(projectPath, id, home);
  emitStatus(projectPath, id, home);
  return statusOf(def, projectPath, home);
}

export async function restartService(projectPath: string, id: string, home: string): Promise<ServiceStatus> {
  stopService(projectPath, id, home);
  lives.delete(key(projectPath, id));
  // dá um tick pro SO liberar a porta antes de subir de novo
  await new Promise((r) => setTimeout(r, 150));
  return startService(projectPath, id, home);
}

export function serviceLogs(projectPath: string, id: string): string {
  return lives.get(key(projectPath, id))?.log ?? "";
}

/** Sobe o que está marcado com autostart — só em projeto confiável. */
export function autostartServices(projectPath: string, home: string): ServiceStatus[] {
  if (!isTrusted(projectPath, home)) return [];
  const out: ServiceStatus[] = [];
  for (const def of readServiceDefs(projectPath)) {
    if (def.autostart !== true) continue;
    out.push(startService(projectPath, def.id, home));
  }
  return out;
}

/** Serviços de pé agora, de todo projeto — base da lista de processos (processos.ts). */
export function servicosRodando(): {
  projectPath: string;
  id: string;
  name: string;
  cmd: string;
  pid: number;
  startedAt: string;
  porta?: number;
}[] {
  return [...lives.values()]
    .filter((l) => l.exitCode === undefined && l.pid > 0)
    .map((l) => ({
      projectPath: l.projectPath,
      id: l.id,
      name: l.name,
      cmd: l.cmd,
      pid: l.pid,
      startedAt: l.startedAt,
      ...(l.actualPort ?? l.porta ? { porta: l.actualPort ?? l.porta } : {}),
    }));
}

/** Derruba tudo: chamado no shutdown do daemon. */
export function stopAllServices(): void {
  for (const live of lives.values()) {
    if (live.exitCode !== undefined) continue;
    if (live.pid) killTree(live.pid);
    else if (!live.child.killed) live.child.kill();
    live.exitCode = 0;
  }
}

export function probeUrl(raw: string): Promise<ProbeResult> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    const err = new Error("url inválida");
    (err as Error & { status: number }).status = 400;
    return Promise.reject(err);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    const err = new Error("só http/https");
    (err as Error & { status: number }).status = 400;
    return Promise.reject(err);
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    const err = new Error("sonda só em loopback");
    (err as Error & { status: number }).status = 400;
    return Promise.reject(err);
  }
  // "localhost"/"0.0.0.0" deixa a resolução de DNS do Node escolher — em algumas
  // máquinas ela pega ::1 primeiro, e se o servidor de dev só escuta IPv4 a sonda
  // dá ECONNREFUSED enquanto o Chrome (happy eyeballs) abre normal. Já validamos
  // acima que é loopback, então força IPv4 direto.
  if (parsed.hostname === "localhost" || parsed.hostname === "0.0.0.0") parsed.hostname = "127.0.0.1";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  return fetch(parsed.href, { method: "GET", signal: ctrl.signal, redirect: "manual" })
    .then((res) => ({ ok: true, status: res.status }))
    .catch((e: Error) => ({ ok: false, error: e.name === "AbortError" ? "timeout" : e.message }))
    .finally(() => clearTimeout(timer));
}

/** Só pra teste: zera o estado em memória entre casos. */
export function resetServicesForTest(): void {
  lives.clear();
  conflitos.clear();
}
