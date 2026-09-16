import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeSessionPath } from "./home.ts";

export type SessaoClaude = { profileId: string; sessionId: string };

/** Id que o CLI aceita em `--resume`. Recusar o resto evita argv injetado. */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function sessaoIdValido(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function lerSessaoClaude(threadId: string, home: string): SessaoClaude | undefined {
  const path = claudeSessionPath(threadId, home);
  if (!existsSync(path)) return undefined;
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as Partial<SessaoClaude>;
    if (typeof d.profileId !== "string" || typeof d.sessionId !== "string") return undefined;
    if (!sessaoIdValido(d.sessionId)) return undefined;
    return { profileId: d.profileId, sessionId: d.sessionId };
  } catch {
    return undefined;
  }
}

export function gravarSessaoClaude(threadId: string, profileId: string, sessionId: string, home: string): void {
  if (!sessaoIdValido(sessionId)) return;
  const path = claudeSessionPath(threadId, home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ profileId, sessionId }), { encoding: "utf8", mode: 0o600 });
}

export function apagarSessaoClaude(threadId: string, home: string): void {
  const path = claudeSessionPath(threadId, home);
  if (!existsSync(path)) return;
  try {
    rmSync(path);
  } catch {
    /* ignore */
  }
}
