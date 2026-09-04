import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AGENTS_MAX,
  AGENT_DESC_MAX,
  AGENT_ID_RE,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_NAME_MAX,
  EFFORT_LEVELS,
  MODEL_RE,
  PERMISSION_MODES,
  type AgentDef,
  type EffortLevel,
  type EngineOverrides,
  type PermissionMode,
} from "@nexo/shared";
import { agentsPath, ensureHome } from "./home.ts";
import { getProfile } from "./profiles.ts";

/** O que o cliente manda: id só na criação, o resto é opcional. */
export type AgentInput = {
  id?: string;
  name?: string;
  description?: string;
  profileId?: string;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  instructions?: string | null;
  color?: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function readAll(home: string): AgentDef[] {
  ensureHome(home);
  const path = agentsPath(home);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Arquivo corrompido não pode derrubar o daemon: sem agente é melhor que 500.
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) return [];
  return list.filter((a): a is AgentDef => typeof a?.id === "string" && AGENT_ID_RE.test(a.id));
}

function writeAll(list: AgentDef[], home: string): void {
  ensureHome(home);
  writeFileSync(agentsPath(home), JSON.stringify({ agents: list }, null, 2), "utf8");
}

export function listAgents(home: string): AgentDef[] {
  return readAll(home).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function getAgent(id: string, home: string): AgentDef | undefined {
  return readAll(home).find((a) => a.id === id);
}

/** Ajustes que o agente sobrepõe na conta. Agente inexistente = nada a sobrepor. */
export function agentOverrides(id: string | undefined, home: string): EngineOverrides {
  const def = id ? getAgent(id, home) : undefined;
  if (!def) return {};
  return {
    ...(def.model ? { model: def.model } : {}),
    ...(def.effort ? { effort: def.effort } : {}),
    ...(def.permissionMode ? { permissionMode: def.permissionMode } : {}),
  };
}

function texto(value: unknown, campo: string, max: number): string {
  if (typeof value !== "string") throw badRequest(`${campo} inválido`);
  const t = value.trim();
  if (t.length > max) throw badRequest(`${campo} passa de ${max} caracteres`);
  return t;
}

function opcional<T>(value: unknown, parse: (v: string) => T): T | undefined {
  // null e "" apagam o campo; undefined mantém o que já estava.
  if (value === null || value === "") return undefined;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest("valor inválido");
  return parse(value);
}

function limparModelo(v: string): string {
  if (!MODEL_RE.test(v)) throw badRequest(`modelo inválido: ${v}`);
  return v;
}

function limparEffort(v: string): EffortLevel {
  if (!(EFFORT_LEVELS as string[]).includes(v)) throw badRequest(`esforço inválido: ${v}`);
  return v as EffortLevel;
}

function limparModo(v: string): PermissionMode {
  if (!(PERMISSION_MODES as string[]).includes(v)) throw badRequest(`modo inválido: ${v}`);
  return v as PermissionMode;
}

function limparCor(v: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw badRequest(`cor inválida: ${v}`);
  return v.toLowerCase();
}

/**
 * Cria ou atualiza. O `id` é imutável: renomear é criar outro, senão as
 * conversas gravadas apontariam pra um agente que não existe mais.
 */
export function saveAgent(input: AgentInput, home: string): AgentDef {
  const id = texto(input.id ?? "", "id", 40).toLowerCase();
  if (!AGENT_ID_RE.test(id)) throw badRequest("id inválido: use minúsculas, números, - e _");
  const list = readAll(home);
  const atual = list.find((a) => a.id === id);
  if (!atual && list.length >= AGENTS_MAX) throw badRequest(`teto de ${AGENTS_MAX} agentes`);

  const name = input.name === undefined ? atual?.name : texto(input.name, "nome", AGENT_NAME_MAX);
  if (!name) throw badRequest("nome obrigatório");

  const profileId = input.profileId === undefined ? atual?.profileId : texto(input.profileId, "conta", 40);
  if (!profileId) throw badRequest("conta obrigatória");
  if (!getProfile(profileId, home)) throw badRequest(`perfil não existe: ${profileId}`);

  const campo = <T>(patch: unknown, anterior: T | undefined, parse: (v: string) => T): T | undefined =>
    patch === undefined ? anterior : opcional(patch, parse);

  const def: AgentDef = {
    id,
    name,
    profileId,
    createdAt: atual?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  const description =
    input.description === undefined ? atual?.description : texto(input.description, "descrição", AGENT_DESC_MAX);
  if (description) def.description = description;
  const instructions =
    input.instructions === undefined
      ? atual?.instructions
      : texto(input.instructions ?? "", "instruções", AGENT_INSTRUCTIONS_MAX);
  if (instructions) def.instructions = instructions;
  const model = campo(input.model, atual?.model, limparModelo);
  if (model) def.model = model;
  const effort = campo(input.effort, atual?.effort, limparEffort);
  if (effort) def.effort = effort;
  const permissionMode = campo(input.permissionMode, atual?.permissionMode, limparModo);
  if (permissionMode) def.permissionMode = permissionMode;
  const color = campo(input.color, atual?.color, limparCor);
  if (color) def.color = color;

  const next = atual ? list.map((a) => (a.id === id ? def : a)) : [...list, def];
  writeAll(next, home);
  return def;
}

export function removeAgent(id: string, home: string): void {
  const list = readAll(home);
  if (!list.some((a) => a.id === id)) {
    const err = new Error(`agente não existe: ${id}`) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  writeAll(
    list.filter((a) => a.id !== id),
    home,
  );
}
