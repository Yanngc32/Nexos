import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  TEAMS_MAX,
  TEAM_DESC_MAX,
  TEAM_ID_RE,
  TEAM_MEMBERS_MAX,
  TEAM_NAME_MAX,
  TEAM_PAPEL_MAX,
  TEAM_CANAIS,
  TEAM_TOPOLOGIES,
  type TeamCanal,
  type TeamDef,
  type TeamMember,
  type TeamTopology,
} from "@nexo/shared";
import { getAgent } from "./agents.ts";
import { ensureHome, teamsPath } from "./home.ts";

/** O que o cliente manda. Mesmo formato do agents: id só na criação. */
export type TeamInput = {
  id?: string;
  name?: string;
  description?: string;
  topology?: string;
  canal?: string;
  members?: Array<{ agentId?: string; papel?: string }>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function readAll(home: string): TeamDef[] {
  ensureHome(home);
  const path = teamsPath(home);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Mesma escolha do agents.ts: arquivo corrompido não derruba o daemon.
    return [];
  }
  const list = (raw as { teams?: unknown })?.teams;
  if (!Array.isArray(list)) return [];
  return list.filter((t): t is TeamDef => typeof t?.id === "string" && TEAM_ID_RE.test(t.id));
}

function writeAll(list: TeamDef[], home: string): void {
  ensureHome(home);
  writeFileSync(teamsPath(home), JSON.stringify({ teams: list }, null, 2), "utf8");
}

export function listTeams(home: string): TeamDef[] {
  return readAll(home).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function getTeam(id: string, home: string): TeamDef | undefined {
  return readAll(home).find((t) => t.id === id);
}

function texto(value: unknown, campo: string, max: number): string {
  if (typeof value !== "string") throw badRequest(`${campo} inválido`);
  const t = value.trim();
  if (t.length > max) throw badRequest(`${campo} passa de ${max} caracteres`);
  return t;
}

function limparTopologia(v: unknown): TeamTopology {
  if (typeof v !== "string" || !(TEAM_TOPOLOGIES as string[]).includes(v)) {
    throw badRequest(`topologia inválida: ${String(v)}`);
  }
  return v as TeamTopology;
}

function limparCanal(v: unknown): TeamCanal {
  if (typeof v !== "string" || !(TEAM_CANAIS as string[]).includes(v)) {
    throw badRequest(`canal inválido: ${String(v)}`);
  }
  return v as TeamCanal;
}

/**
 * Membros na ORDEM em que trabalham — no pipeline a posição é a semântica.
 * O agente precisa existir: um membro apontando pra agente apagado quebraria o
 * run no meio, depois de já ter gasto quota nos passos anteriores.
 */
function limparMembros(value: unknown, home: string): TeamMember[] {
  if (!Array.isArray(value)) throw badRequest("membros precisa ser lista");
  if (!value.length) throw badRequest("time precisa de pelo menos um membro");
  if (value.length > TEAM_MEMBERS_MAX) throw badRequest(`teto de ${TEAM_MEMBERS_MAX} membros`);
  return value.map((item, i) => {
    const agentId = texto((item as { agentId?: unknown })?.agentId ?? "", `membro ${i + 1}`, 40);
    if (!agentId) throw badRequest(`membro ${i + 1} sem agente`);
    if (!getAgent(agentId, home)) throw badRequest(`agente não existe: ${agentId}`);
    const papel = texto((item as { papel?: unknown })?.papel ?? "", `papel do membro ${i + 1}`, TEAM_PAPEL_MAX);
    return papel ? { agentId, papel } : { agentId };
  });
}

/** Cria ou atualiza. `id` é imutável, pelo mesmo motivo do agente: runs gravados apontam pra ele. */
export function saveTeam(input: TeamInput, home: string): TeamDef {
  const id = texto(input.id ?? "", "id", 40).toLowerCase();
  if (!TEAM_ID_RE.test(id)) throw badRequest("id inválido: use minúsculas, números, - e _");
  const list = readAll(home);
  const atual = list.find((t) => t.id === id);
  if (!atual && list.length >= TEAMS_MAX) throw badRequest(`teto de ${TEAMS_MAX} times`);

  const name = input.name === undefined ? atual?.name : texto(input.name, "nome", TEAM_NAME_MAX);
  if (!name) throw badRequest("nome obrigatório");

  const topology = input.topology === undefined ? (atual?.topology ?? "pipeline") : limparTopologia(input.topology);
  const members = input.members === undefined ? atual?.members : limparMembros(input.members, home);
  if (!members?.length) throw badRequest("time precisa de pelo menos um membro");
  // O supervisor não trabalha, chama: sozinho ele não teria ninguém pra chamar
  // e o run morreria no primeiro turno, depois de já ter gasto ele.
  if (topology === "supervisor" && members.length < 2) {
    throw badRequest("supervisor precisa de pelo menos um membro além dele");
  }

  const canal = input.canal === undefined ? atual?.canal : limparCanal(input.canal);

  const def: TeamDef = {
    id,
    name,
    topology,
    // canal só existe pro supervisor: guardá-lo nas outras topologias criaria um
    // ajuste que a tela mostra e que não muda nada
    ...(topology === "supervisor" && canal ? { canal } : {}),
    members,
    createdAt: atual?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  const description =
    input.description === undefined ? atual?.description : texto(input.description, "descrição", TEAM_DESC_MAX);
  if (description) def.description = description;

  writeAll(atual ? list.map((t) => (t.id === id ? def : t)) : [...list, def], home);
  return def;
}

export function removeTeam(id: string, home: string): void {
  const list = readAll(home);
  if (!list.some((t) => t.id === id)) {
    const err = new Error(`time não existe: ${id}`) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  writeAll(
    list.filter((t) => t.id !== id),
    home,
  );
}
