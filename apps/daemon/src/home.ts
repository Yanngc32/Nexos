import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return root;
}

export function profileDir(id: string, root = nexoHome()): string {
  return join(root, "profiles", id);
}

export function threadPath(id: string, root = nexoHome()): string {
  return join(root, "threads", `${id}.jsonl`);
}

export function attachmentsDir(threadId: string, root = nexoHome()): string {
  return join(root, "attachments", threadId);
}

export function configPath(root = nexoHome()): string {
  return join(root, "config.json");
}

export function agentsPath(root = nexoHome()): string {
  return join(root, "agents.json");
}

export function enginePidPath(threadId: string, root = nexoHome()): string {
  return join(root, "run", `engine-${threadId}.pid`);
}

export function tokenPath(root = nexoHome()): string {
  return join(root, "daemon.token");
}
