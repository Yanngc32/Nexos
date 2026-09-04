import { EventEmitter } from "node:events";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProbeResult, ServiceDef, ServiceStatus, ServicesReport } from "@nexo/shared";
import { loadConfig, saveConfig } from "./config.ts";
import { ensureHome } from "./home.ts";
import { assertSlug } from "./ids.ts";
import { killTree } from "./kill-tree.ts";

/** Nome do arquivo que declara os serviços, na raiz do projeto. */
export const SERVICES_FILE = "nexo.json";

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
  exitCode?: number;
};

/** Chave de processo: o daemon é global, vários projetos podem estar abertos. */
function key(projectPath: string, id: string): string {
  return `${projectKey(projectPath)}::${id}`;
}

function projectKey(projectPath: string): string {
  return resolve(projectPath).replace(/[\u005c]/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Nome do canal do bus pra este projeto: é por ele que o SSE escuta. */
export function servicesChannel(projectPath: string): string {
  return projectKey(projectPath);
}

const lives = new Map<string, Live>();

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

/** Lê e valida o nexo.json. Lança com motivo legível; nunca devolve serviço meio válido. */
export function readServiceDefs(projectPath: string): ServiceDef[] {
  const path = join(resolve(projectPath), SERVICES_FILE);
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

function statusOf(def: ServiceDef, projectPath: string): ServiceStatus {
  const live = lives.get(key(projectPath, def.id));
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
  };
  if (!live) return base;
  if (live.exitCode !== undefined) {
    return { ...base, proc: "exited", exitCode: live.exitCode };
  }
  return { ...base, proc: "running", pid: live.pid, startedAt: live.startedAt };
}

export function listServices(projectPath: string, home: string): ServicesReport {
  const trusted = isTrusted(projectPath, home);
  try {
    const defs = readServiceDefs(projectPath);
    return { projectPath: resolve(projectPath), trusted, services: defs.map((d) => statusOf(d, projectPath)) };
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

function emitStatus(projectPath: string, id: string): void {
  let status: ServiceStatus | undefined;
  try {
    status = statusOf(findDef(projectPath, id), projectPath);
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

export function startService(projectPath: string, id: string, home: string): ServiceStatus {
  ensureHome(home);
  const def = findDef(projectPath, id);
  const k = key(projectPath, id);
  const atual = lives.get(k);
  // idempotente: já rodando não spawna segundo processo
  if (atual && atual.exitCode === undefined) return statusOf(def, projectPath);

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

  const live: Live = { child, pid: child.pid ?? 0, startedAt: new Date().toISOString(), log: "" };
  lives.set(k, live);
  if (child.pid) writeFileSync(pidPath(projectPath, id, home), String(child.pid), "utf8");

  child.stdout.on("data", (b: Buffer) => appendLog(projectPath, id, b.toString("utf8")));
  child.stderr.on("data", (b: Buffer) => appendLog(projectPath, id, b.toString("utf8")));
  child.on("error", (err) => {
    appendLog(projectPath, id, `\n[nexo] falha ao rodar: ${err.message}\n`);
    live.exitCode = -1;
    emitStatus(projectPath, id);
  });
  child.on("close", (code) => {
    live.exitCode = code ?? 0;
    clearPid(projectPath, id, home);
    appendLog(projectPath, id, `\n[nexo] saiu com código ${live.exitCode}\n`);
    emitStatus(projectPath, id);
  });

  emitStatus(projectPath, id);
  return statusOf(def, projectPath);
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
  const def = findDef(projectPath, id);
  const k = key(projectPath, id);
  const live = lives.get(k);
  if (live && live.exitCode === undefined) {
    if (live.pid) killTree(live.pid);
    else if (!live.child.killed) live.child.kill();
    live.exitCode = live.exitCode ?? 0;
  }
  clearPid(projectPath, id, home);
  emitStatus(projectPath, id);
  return statusOf(def, projectPath);
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
}
