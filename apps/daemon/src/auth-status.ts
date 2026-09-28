import { spawnSync } from "node:child_process";
import type { Profile } from "@nexos/shared";
import { log } from "./log.ts";
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
  return process.env.NEXOS_CLAUDE_BIN ?? "claude";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Resposta do `claude auth status` ou o motivo de não ter resposta. `falha` = o CLI nem respondeu
 * (binário ausente, timeout, saída sem JSON): não quer dizer "deslogado". Antes isso sumia num
 * `undefined` e o login mostrava "o código não foi aceito" quando o problema era o CLI não rodar.
 */
export type ConsultaDeAuth = { status?: CliAuthStatus; falha?: string };

/** Igual a `cliAuthStatusDetalhado`, só com a resposta (quem não precisa do motivo). */
export function cliAuthStatus(profile: Profile, home: string, timeoutMs = 10_000): CliAuthStatus | undefined {
  return cliAuthStatusDetalhado(profile, home, timeoutMs).status;
}

function falhou(profile: Profile, falha: string, dados: Record<string, unknown> = {}): ConsultaDeAuth {
  log.aviso("login", `"claude auth status" do perfil ${profile.id} sem resposta: ${falha}`, dados);
  return { falha };
}

/**
 * Pergunta ao CLI se o perfil está logado. Custa um spawn (~1s), então só em
 * caminho frio: painel de conta e conferência pós-login — nunca por mensagem.
 */
export function cliAuthStatusDetalhado(profile: Profile, home: string, timeoutMs = 10_000): ConsultaDeAuth {
  if (profile.engine !== "claude") return {};
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
  const stderr = typeof res.stderr === "string" ? res.stderr.trim().slice(0, 300) : "";
  if (res.error) {
    const codigo = (res.error as NodeJS.ErrnoException).code;
    const falha = codigo === "ETIMEDOUT" ? "o CLI não respondeu no tempo" : codigo === "ENOENT" ? `${bin} não foi encontrado` : res.error.message;
    return falhou(profile, falha, { bin, erro: res.error.message, stderr });
  }
  if (typeof res.stdout !== "string") return falhou(profile, "o CLI não devolveu nada", { bin, status: res.status, stderr });
  const start = res.stdout.indexOf("{");
  if (start === -1) {
    return falhou(profile, stderr.split(/\r?\n/)[0] || `o CLI saiu com código ${res.status} sem JSON`, { bin, status: res.status, stderr });
  }
  try {
    const parsed = JSON.parse(res.stdout.slice(start)) as Record<string, unknown>;
    return {
      status: {
        loggedIn: parsed.loggedIn === true,
        authMethod: str(parsed.authMethod),
        email: str(parsed.email),
        orgName: str(parsed.orgName),
        subscriptionType: str(parsed.subscriptionType),
      },
    };
  } catch (e) {
    return falhou(profile, "a resposta do CLI não é JSON válido", { bin, erro: (e as Error).message, saida: res.stdout.slice(0, 300) });
  }
}
