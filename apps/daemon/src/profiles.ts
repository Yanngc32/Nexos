import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountInfo, ApiProvider, EffortLevel, EngineKind, PermissionMode, Profile } from "@nexo/shared";
import { EFFORT_LEVELS, MODEL_RE, PERMISSION_MODES, TOOL_PATTERN_RE } from "@nexo/shared";
import { loadConfig, saveConfig } from "./config.ts";
import { assertSlug } from "./ids.ts";
import { ensureHome, profileDir } from "./home.ts";

export type AddProfileInput = {
  id: string;
  engine: EngineKind;
  api?: { provider: ApiProvider; model: string };
};

export type AddProfileOpts = {
  apiKey?: string;
  skipBinCheck?: boolean;
};

type ApiKeysFile = {
  provider: NonNullable<Profile["api"]>["provider"];
  apiKey: string;
  model: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function which(bin: string): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, [bin], { encoding: "utf8" });
  return r.status === 0;
}

function profileJsonPath(id: string, home: string): string {
  return join(profileDir(id, home), "profile.json");
}

export function addProfile(input: AddProfileInput, home: string, opts: AddProfileOpts = {}): Profile {
  ensureHome(home);
  const id = assertSlug(input.id);
  const dir = profileDir(id, home);
  if (existsSync(profileJsonPath(id, home))) {
    throw new Error(`perfil já existe: ${id}`);
  }
  if (!opts.skipBinCheck && (input.engine === "claude" || input.engine === "codex")) {
    if (!which(input.engine)) {
      throw new Error(`${input.engine} não tá no PATH`);
    }
  }

  // 0700: a pasta guarda credencial (keys.json, árvore do CLI). Outro usuário
  // da máquina não tem nada a fazer aqui. No Windows o mode é ignorado.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (input.engine === "claude") mkdirSync(join(dir, "claude"), { recursive: true, mode: 0o700 });
  if (input.engine === "codex") mkdirSync(join(dir, "codex"), { recursive: true, mode: 0o700 });

  let status: Profile["status"] = "unauthenticated";
  if (input.engine === "stub") status = "ready";
  if (input.engine === "api") {
    if (!input.api || !opts.apiKey) throw new Error("engine api precisa provider, model e apiKey");
    writeFileSync(
      join(dir, "keys.json"),
      JSON.stringify(
        { provider: input.api.provider, apiKey: opts.apiKey, model: input.api.model } satisfies ApiKeysFile,
        null,
        2,
      ),
      // Chave de API em claro: mesmo tratamento do daemon.token.
      { encoding: "utf8", mode: 0o600 },
    );
    status = "ready";
  }

  const profile: Profile = {
    id,
    engine: input.engine,
    createdAt: nowIso(),
    status,
    ...(input.api ? { api: input.api } : {}),
  };
  writeFileSync(profileJsonPath(id, home), JSON.stringify(profile, null, 2), "utf8");
  const cfg = loadConfig(home);
  if (!cfg.fallbackOrder.includes(id)) {
    saveConfig(home, { fallbackOrder: [...cfg.fallbackOrder, id] });
  }
  return profile;
}

export type ProfilePatch = {
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  allowedTools?: string[] | null;
};

/** Modelo, esforço e modo de permissão vão como argv do CLI: valida em vez de confiar. */
export function updateProfile(id: string, home: string, patch: ProfilePatch): Profile {
  const p = getProfile(id, home);
  if (!p) throw new Error(`perfil não existe: ${id}`);
  const next: Profile = { ...p };
  if (patch.model !== undefined) {
    const model = (patch.model ?? "").trim();
    if (!model) delete next.model;
    else if (!MODEL_RE.test(model)) throw new Error(`modelo inválido: ${model}`);
    else next.model = model;
  }
  if (patch.effort !== undefined) {
    const effort = (patch.effort ?? "").trim();
    if (!effort) delete next.effort;
    else if (!EFFORT_LEVELS.includes(effort as EffortLevel)) throw new Error(`esforço inválido: ${effort}`);
    else next.effort = effort as EffortLevel;
  }
  if (patch.permissionMode !== undefined) {
    const mode = (patch.permissionMode ?? "").trim();
    if (!mode) delete next.permissionMode;
    else if (!PERMISSION_MODES.includes(mode as PermissionMode)) throw new Error(`modo inválido: ${mode}`);
    else next.permissionMode = mode as PermissionMode;
  }
  if (patch.allowedTools !== undefined) {
    const lista = (patch.allowedTools ?? []).map((t) => String(t).trim()).filter(Boolean);
    for (const padrao of lista) {
      if (!TOOL_PATTERN_RE.test(padrao)) throw new Error(`ferramenta inválida: ${padrao}`);
    }
    if (!lista.length) delete next.allowedTools;
    else next.allowedTools = [...new Set(lista)].slice(0, 40);
  }
  writeFileSync(profileJsonPath(id, home), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function getProfile(id: string, home: string): Profile | undefined {
  const path = profileJsonPath(id, home);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Profile;
}

export function listProfiles(home: string): Profile[] {
  ensureHome(home);
  const root = join(home, "profiles");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => getProfile(d.name, home))
    .filter((p): p is Profile => Boolean(p))
    .map((p) => applyLoginResult(p.id, home));
}

function setStatus(id: string, home: string, status: Profile["status"], authFailedAt?: string): Profile {
  const p = getProfile(id, home);
  if (!p) throw new Error(`perfil não existe: ${id}`);
  const next: Profile = { ...p, status };
  if (authFailedAt) next.authFailedAt = authFailedAt;
  else delete next.authFailedAt;
  if (p.status === next.status && p.authFailedAt === next.authFailedAt) return p;
  writeFileSync(profileJsonPath(id, home), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function markReady(id: string, home: string): Profile {
  return setStatus(id, home, "ready");
}

export function markUnauthenticated(id: string, home: string): Profile {
  return setStatus(id, home, "unauthenticated");
}

/**
 * Recusa do servidor (token revogado): o arquivo continua parecendo válido, então
 * carimba a hora da falha — só volta a ready com credencial gravada depois disso.
 */
export function markAuthFailed(id: string, home: string): Profile {
  return setStatus(id, home, "unauthenticated", nowIso());
}

const CRED_FILES = [
  "logged-in",
  ".credentials.json",
  "credentials.json",
  ".claude.json",
  "auth.json",
  "session.json",
];

function isCredFile(name: string): boolean {
  return CRED_FILES.includes(name) || /\.credentials\.json$/i.test(name);
}

/** "live" = credencial usável, "dead" = token vencido/vazio, "none" = sem login. */
export type CredVerdict = "live" | "dead" | "none";

type OauthBlock = {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  refreshTokenExpiresAt?: unknown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Só reconhece o formato OAuth do Claude; outros formatos ficam como "desconhecido". */
function oauthBlock(raw: string): OauthBlock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  const inner = o.claudeAiOauth;
  const block = (inner && typeof inner === "object" ? inner : o) as OauthBlock;
  return "accessToken" in block ? block : undefined;
}

export function oauthLive(block: OauthBlock, now = Date.now()): boolean {
  if (!str(block.accessToken)) return false;
  if (num(block.expiresAt) > now) return true;
  if (!str(block.refreshToken)) return false;
  const refreshExp = num(block.refreshTokenExpiresAt);
  return refreshExp === 0 || refreshExp > now;
}

type CredScan = { live: boolean; dead: boolean; unknown: boolean; newest: number };

function scanCreds(dir: string, depth = 0): CredScan {
  const scan: CredScan = { live: false, dead: false, unknown: false, newest: 0 };
  if (!dir || !existsSync(dir) || depth > 2) return scan;
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isFile() && isCredFile(ent.name)) {
        let block: OauthBlock | undefined;
        try {
          block = oauthBlock(readFileSync(full, "utf8"));
          scan.newest = Math.max(scan.newest, statSync(full).mtimeMs);
        } catch {
          block = undefined;
        }
        if (!block) scan.unknown = true;
        else if (oauthLive(block)) scan.live = true;
        else scan.dead = true;
        continue;
      }
      if (ent.isDirectory() && ent.name !== "node_modules") {
        const sub = scanCreds(full, depth + 1);
        scan.live ||= sub.live;
        scan.dead ||= sub.dead;
        scan.unknown ||= sub.unknown;
        scan.newest = Math.max(scan.newest, sub.newest);
      }
    }
  } catch {
    return scan;
  }
  return scan;
}

/**
 * Arquivo de credencial OAuth manda no veredito: se existe um e o token está morto,
 * `.claude.json` presente na mesma pasta não vale como login.
 */
function verdictOfScan(scan: CredScan): CredVerdict {
  if (scan.live) return "live";
  if (scan.dead) return "dead";
  return scan.unknown ? "live" : "none";
}

function credDir(profile: Profile, home: string): string {
  const extra = engineEnv(profile, home);
  return extra.CLAUDE_CONFIG_DIR ?? extra.CODEX_HOME ?? "";
}

/** Credencial gravada depois da recusa do servidor = login novo, pode reabilitar. */
function credRenewedAfterFailure(profile: Profile, home: string): boolean {
  if (!profile.authFailedAt) return true;
  const failedAt = Date.parse(profile.authFailedAt);
  if (Number.isNaN(failedAt)) return true;
  return scanCreds(credDir(profile, home)).newest > failedAt;
}

function copyCredTree(src: string, dest: string, depth = 0): number {
  if (!src || !existsSync(src) || depth > 2) return 0;
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  try {
    for (const ent of readdirSync(src, { withFileTypes: true })) {
      if (ent.isFile() && isCredFile(ent.name)) {
        copyFileSync(join(src, ent.name), join(dest, ent.name));
        copied += 1;
        continue;
      }
      if (ent.isDirectory() && ent.name !== "node_modules") {
        copied += copyCredTree(join(src, ent.name), join(dest, ent.name), depth + 1);
      }
    }
  } catch {
    return copied;
  }
  return copied;
}

export function credentialVerdict(profile: Profile, home: string): CredVerdict {
  if (profile.engine === "stub") return "live";
  if (profile.engine === "api") return readApiKey(profile.id, home) ? "live" : "none";
  const verdict = verdictOfScan(scanCreds(credDir(profile, home)));
  if (verdict === "live" && !credRenewedAfterFailure(profile, home)) return "dead";
  return verdict;
}

export function credentialPresent(profile: Profile, home: string): boolean {
  return credentialVerdict(profile, home) === "live";
}

/** Autoritativo nos dois sentidos: promove a ready e também rebaixa token morto. */
export function applyLoginResult(id: string, home: string): Profile {
  const p = getProfile(id, home);
  if (!p) throw new Error(`perfil não existe: ${id}`);
  if (p.engine === "stub" || p.engine === "api") return markReady(id, home);
  if (verdictOfScan(scanCreds(credDir(p, home))) !== "live") return markUnauthenticated(id, home);
  // Arquivo parece bom, mas o servidor já recusou: mantém o carimbo até login novo.
  if (!credRenewedAfterFailure(p, home)) return setStatus(id, home, "unauthenticated", p.authFailedAt);
  return markReady(id, home);
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isoOrUndefined(v: unknown): string | undefined {
  const ms = num(v);
  return ms > 0 ? new Date(ms).toISOString() : undefined;
}

/** Só campos de identificação/validade — accessToken e refreshToken nunca saem daqui. */
export function accountInfo(profile: Profile, home: string): AccountInfo {
  const info: AccountInfo = {
    id: profile.id,
    engine: profile.engine,
    status: profile.status,
    credential: credentialVerdict(profile, home),
    ...(profile.authFailedAt ? { authFailedAt: profile.authFailedAt } : {}),
    ...(profile.api ? { provider: profile.api.provider, model: profile.api.model } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.effort ? { effort: profile.effort } : {}),
    ...(profile.permissionMode ? { permissionMode: profile.permissionMode } : {}),
  };
  if (profile.engine === "stub" || profile.engine === "api") return info;

  const dir = credDir(profile, home);
  if (dir) info.configDir = dir;

  const credRaw = readJson(join(dir, ".credentials.json"));
  const cred = (credRaw?.claudeAiOauth ?? credRaw) as Record<string, unknown> | undefined;
  if (cred) {
    const sub = str(cred.subscriptionType);
    const tier = str(cred.rateLimitTier);
    if (sub) info.subscription = sub;
    if (tier) info.rateLimitTier = tier;
    if (Array.isArray(cred.scopes)) info.scopes = cred.scopes.filter((s): s is string => typeof s === "string");
    const exp = isoOrUndefined(cred.expiresAt);
    const refresh = isoOrUndefined(cred.refreshTokenExpiresAt);
    if (exp) info.expiresAt = exp;
    if (refresh) info.refreshExpiresAt = refresh;
  }

  const account = readJson(join(dir, ".claude.json"))?.oauthAccount as Record<string, unknown> | undefined;
  if (account) {
    const email = str(account.emailAddress);
    const name = str(account.fullName);
    const org = str(account.organizationName);
    const seat = str(account.seatTier);
    if (email) info.email = email;
    if (name) info.fullName = name;
    if (org) info.organization = org;
    if (seat) info.seatTier = seat;
    if (!info.rateLimitTier) {
      const tier = str(account.userRateLimitTier) || str(account.organizationRateLimitTier);
      if (tier) info.rateLimitTier = tier;
    }
  }
  return info;
}

export const IMPORT_WARNING =
  "aviso: credencial copiada é foto da sessão do ~/.claude — o refresh token rotaciona, então a cópia morre no primeiro refresh do login global. Para durar, use: nexo login <perfil>";

export function globalClaudeDir(): string {
  return process.env.NEXO_CLAUDE_GLOBAL ?? join(homedir(), ".claude");
}

export function importGlobalCredentials(id: string, home: string): Profile {
  const p = getProfile(id, home);
  if (!p) throw new Error(`perfil não existe: ${id}`);
  if (p.engine !== "claude") throw new Error("import só vale pra engine claude");
  const dest = engineEnv(p, home).CLAUDE_CONFIG_DIR;
  if (!dest) throw new Error("pasta claude ausente");
  mkdirSync(dest, { recursive: true });
  let copied = copyCredTree(globalClaudeDir(), dest);
  const homeJson = process.env.NEXO_CLAUDE_GLOBAL_JSON ?? join(homedir(), ".claude.json");
  if (existsSync(homeJson)) {
    copyFileSync(homeJson, join(dest, ".claude.json"));
    copied += 1;
  }
  if (!copied) throw new Error("não achei login do Claude neste PC");
  const after = applyLoginResult(id, home);
  if (after.status !== "ready") {
    throw new Error(`credencial copiada está vencida ou vazia — rode: nexo login ${id}`);
  }
  return after;
}

export function removeProfile(id: string, home: string): void {
  const slug = assertSlug(id);
  if (!existsSync(profileJsonPath(slug, home))) throw new Error(`perfil não existe: ${slug}`);
  rmSync(profileDir(slug, home), { recursive: true, force: true });
  const cfg = loadConfig(home);
  saveConfig(home, { fallbackOrder: cfg.fallbackOrder.filter((x) => x !== slug) });
}

export function readApiKey(id: string, home: string): string | undefined {
  const path = join(profileDir(id, home), "keys.json");
  if (!existsSync(path)) return undefined;
  const keys = JSON.parse(readFileSync(path, "utf8")) as ApiKeysFile;
  return keys.apiKey;
}

export function engineEnv(profile: Profile, home: string): Record<string, string> {
  const dir = profileDir(profile.id, home);
  if (profile.engine === "claude") return { CLAUDE_CONFIG_DIR: join(dir, "claude") };
  if (profile.engine === "codex") return { CODEX_HOME: join(dir, "codex") };
  return {};
}

/**
 * Env do processo filho: o do daemon mais o do perfil, com a variável do outro
 * motor removida. Sem isso o filho herda o `CLAUDE_CONFIG_DIR` (ou `CODEX_HOME`)
 * da máquina de quem subiu o daemon e escreve fora do perfil — furando o
 * isolamento de conta que o perfil existe pra garantir.
 */
export function engineSpawnEnv(profile: Profile, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...engineEnv(profile, home) };
  if (profile.engine !== "claude") delete env.CLAUDE_CONFIG_DIR;
  if (profile.engine !== "codex") delete env.CODEX_HOME;
  return env;
}
