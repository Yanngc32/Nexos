import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertSlug } from "./ids.ts";

export function nexoHome(): string {
  return process.env.NEXO_HOME ?? join(homedir(), ".nexo");
}

/**
 * Normaliza um caminho de projeto pra comparação/chave estável: resolvido,
 * barra sempre `/` (Windows manda `\`), sem barra final, minúsculo (o mesmo
 * projeto aberto com capitalização diferente de unidade no Windows não pode
 * virar duas chaves). Base de `projectKey` em vários lugares — canal de SSE de
 * serviço (`services.ts`), pasta de memória de projeto (`memoria.ts`).
 */
export function projectKey(projectPath: string): string {
  return resolve(projectPath)
    .replace(/[\u005c]/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function ensureHome(root = nexoHome()): string {
  for (const dir of [
    root,
    join(root, "profiles"),
    join(root, "threads"),
    join(root, "run"),
    join(root, "attachments"),
    join(root, "runs"),
    join(root, "skills"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return root;
}

/*
 * Todo caminho derivado de um id passa por assertSlug aqui, e não só em quem
 * chama: id de perfil e de conversa vêm de parâmetro de rota, e um `..` no meio
 * escapava do NEXO_HOME. Validar no construtor do caminho fecha o furo uma vez
 * em vez de depender de cada chamador lembrar.
 */
export function profileDir(id: string, root = nexoHome()): string {
  return join(root, "profiles", assertSlug(id));
}

export function threadPath(id: string, root = nexoHome()): string {
  return join(root, "threads", `${assertSlug(id)}.jsonl`);
}

export function attachmentsDir(threadId: string, root = nexoHome()): string {
  return join(root, "attachments", assertSlug(threadId));
}

export function configPath(root = nexoHome()): string {
  return join(root, "config.json");
}

export function agentsPath(root = nexoHome()): string {
  return join(root, "agents.json");
}

export function teamsPath(root = nexoHome()): string {
  return join(root, "teams.json");
}

/** Pasta de um run: guarda a saída de cada passo como artefato. */
export function runDir(id: string, root = nexoHome()): string {
  return join(root, "runs", assertSlug(id));
}

export function runsRoot(root = nexoHome()): string {
  return join(root, "runs");
}

export function enginePidPath(threadId: string, root = nexoHome()): string {
  return join(root, "run", `engine-${assertSlug(threadId)}.pid`);
}

export function tokenPath(root = nexoHome()): string {
  return join(root, "daemon.token");
}

/** Config dos Nexo Hooks: lista de regras (escopo global ou de projeto, evento, branch, agente). Ver hooks.ts. */
export function hooksPath(root = nexoHome()): string {
  return join(root, "hooks.json");
}

/** Quadros Kanban por projeto + tarefas. Ver tarefas.ts. */
export function tarefasPath(root = nexoHome()): string {
  return join(root, "tarefas.json");
}

/**
 * Skills globais do Nexo: um SKILL.md aqui vale pra qualquer perfil/conta,
 * porque `engineSpawnEnv` isola `CLAUDE_CONFIG_DIR` por perfil e o motor só
 * lê skill de dentro dessa pasta (ou do `.claude/skills` do projeto aberto).
 * Ver `syncGlobalSkills` em engines/cli.ts, que copia daqui pra cada perfil
 * antes de nascer o processo.
 */
export function globalSkillsDir(root = nexoHome()): string {
  return join(root, "skills");
}
