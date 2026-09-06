import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSlug } from "./ids.ts";

export function nexoHome(): string {
  return process.env.NEXO_HOME ?? join(homedir(), ".nexo");
}

export function ensureHome(root = nexoHome()): string {
  for (const dir of [
    root,
    join(root, "profiles"),
    join(root, "threads"),
    join(root, "run"),
    join(root, "attachments"),
    join(root, "runs"),
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
