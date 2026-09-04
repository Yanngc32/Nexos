import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadEvent } from "@nexo/shared";
import { ensureHome, threadPath } from "./home.ts";
import { newThreadId } from "./ids.ts";
import { getProfile } from "./profiles.ts";

function nowIso(): string {
  return new Date().toISOString();
}

export type CreatedThread = { id: string };

export function createThread(
  input: { projectPath: string; profileId: string; title?: string; agentId?: string },
  home: string,
): CreatedThread {
  ensureHome(home);
  const profile = getProfile(input.profileId, home);
  if (!profile) throw new Error(`perfil não existe: ${input.profileId}`);
  const id = newThreadId();
  const meta: ThreadEvent = {
    ts: nowIso(),
    type: "thread_meta",
    threadId: id,
    projectPath: input.projectPath,
    profileId: input.profileId,
    ...(input.title ? { title: input.title } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  };
  appendEvent(meta, home);
  return { id };
}

export function appendEvent(event: ThreadEvent, home: string): void {
  const path = threadPath(event.threadId, home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
}

export function removeThread(id: string, home: string): void {
  const path = threadPath(id, home);
  if (!existsSync(path)) throw new Error(`thread não existe: ${id}`);
  rmSync(path);
}

export function readThread(id: string, home: string): ThreadEvent[] {
  const path = threadPath(id, home);
  if (!existsSync(path)) throw new Error(`thread não existe: ${id}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ThreadEvent);
}

export type ThreadHead = {
  id: string;
  projectPath: string;
  profileId: string;
  preview: string;
  updatedAt: string;
  /** Agente personalizado da conversa, quando ela nasceu de um. */
  agentId?: string;
};

/** Cabeçalho de uma conversa só. `undefined` = arquivo ilegível ou sem meta. */
export function threadHead(id: string, home: string): ThreadHead | undefined {
  let events: ThreadEvent[];
  try {
    events = readThread(id, home);
  } catch {
    return undefined;
  }
  const meta = events.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") return undefined;
  const firstUser = events.find((e) => e.type === "user");
  const last = events.at(-1);
  return {
    id,
    projectPath: meta.projectPath,
    profileId: activeProfileId(events),
    preview:
      firstUser && firstUser.type === "user" ? firstUser.text.replace(/\s+/g, " ").slice(0, 72) : "Conversa nova",
    updatedAt: last?.ts ?? meta.ts,
    ...(meta.agentId ? { agentId: meta.agentId } : {}),
  };
}

export function listThreads(projectPath: string, home: string): ThreadHead[] {
  ensureHome(home);
  const threadsDir = dirname(threadPath("placeholder", home));
  if (!existsSync(threadsDir)) return [];
  const out: ThreadHead[] = [];
  for (const file of readdirSync(threadsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const head = threadHead(file.slice(0, -".jsonl".length), home);
    if (!head || head.projectPath !== projectPath) continue;
    out.push(head);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export type ThreadUsage = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number;
  costUsd: number;
  /** Do último turno: é isso que ocupa a janela de contexto agora. */
  contextTokens: number;
  model?: string;
};

/** Soma os eventos usage do JSONL: total da conversa + foto do último turno. */
export function threadUsage(id: string, home: string): ThreadUsage {
  const totals: ThreadUsage = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    thinking: 0,
    costUsd: 0,
    contextTokens: 0,
  };
  for (const e of readThread(id, home)) {
    if (e.type !== "usage") continue;
    totals.turns += 1;
    totals.input += e.input;
    totals.output += e.output;
    totals.cacheRead += e.cacheRead;
    totals.cacheCreate += e.cacheCreate;
    totals.thinking += e.thinking ?? 0;
    totals.costUsd += e.costUsd ?? 0;
    totals.contextTokens = e.contextTokens;
    if (e.model) totals.model = e.model;
  }
  return totals;
}

/**
 * Pastas que aparecem nas conversas do disco. É a rede de segurança da lista de
 * projetos: mesmo que o app perca o cache local, as conversas sabem onde moram.
 */
export function projectsFromThreads(home: string): string[] {
  ensureHome(home);
  const dir = dirname(threadPath("placeholder", home));
  if (!existsSync(dir)) return [];
  const vistos = new Map<string, { path: string; ts: string }>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    let events: ThreadEvent[];
    try {
      events = readThread(file.slice(0, -".jsonl".length), home);
    } catch {
      continue;
    }
    const meta = events.find((e) => e.type === "thread_meta");
    if (!meta || meta.type !== "thread_meta" || !meta.projectPath) continue;
    const chave = meta.projectPath.replace(/[\u005c]/g, "/").replace(/\/+$/, "").toLowerCase();
    const ts = events.at(-1)?.ts ?? meta.ts;
    const atual = vistos.get(chave);
    if (!atual || atual.ts < ts) vistos.set(chave, { path: meta.projectPath, ts });
  }
  return [...vistos.values()]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .map((v) => v.path);
}

export function activeProfileId(events: ThreadEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "switched") return e.toProfileId;
    if (e?.type === "thread_meta") return e.profileId;
  }
  throw new Error("thread sem profileId");
}
