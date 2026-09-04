import { spawnSync } from "node:child_process";
import type { Profile } from "@nexo/shared";
import { engineSpawnEnv } from "./profiles.ts";

/** Recorte do `claude auth status --json`. É a verdade do CLI, não do arquivo. */
export type CliAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
};

function claudeBin(): string {
  return process.env.NEXO_CLAUDE_BIN ?? "claude";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Pergunta ao CLI se o perfil está logado. Custa um spawn (~1s), então só em
 * caminho frio: painel de conta e conferência pós-login — nunca por mensagem.
 */
export function cliAuthStatus(profile: Profile, home: string, timeoutMs = 10_000): CliAuthStatus | undefined {
  if (profile.engine !== "claude") return undefined;
  const bin = claudeBin();
  const args = ["auth", "status", "--json"];
  const isNode = /\.(mjs|cjs|js|ts)$/i.test(bin.split(/[\/]/).pop() ?? "");
  const res = isNode
    ? spawnSync(process.execPath, [bin, ...args], {
        env: engineSpawnEnv(profile, home),
        encoding: "utf8",
        timeout: timeoutMs,
      })
    : spawnSync(bin, args, {
        env: engineSpawnEnv(profile, home),
        encoding: "utf8",
        timeout: timeoutMs,
        shell: process.platform === "win32",
      });
  if (res.error || typeof res.stdout !== "string") return undefined;
  const start = res.stdout.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(res.stdout.slice(start)) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: str(parsed.authMethod),
      email: str(parsed.email),
      orgName: str(parsed.orgName),
      subscriptionType: str(parsed.subscriptionType),
    };
  } catch {
    return undefined;
  }
}
