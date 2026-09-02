import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function nexoHome(): string {
  return process.env.NEXO_HOME ?? join(homedir(), ".nexo");
}

export function ensureHome(root = nexoHome()): string {
  for (const dir of [root, join(root, "profiles"), join(root, "threads"), join(root, "run")]) {
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

export function configPath(root = nexoHome()): string {
  return join(root, "config.json");
}

export function tokenPath(root = nexoHome()): string {
  return join(root, "daemon.token");
}
