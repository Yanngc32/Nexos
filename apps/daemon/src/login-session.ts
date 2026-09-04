import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Profile } from "@nexo/shared";
import { cliAuthStatus } from "./auth-status.ts";
import { killTree } from "./kill-tree.ts";
import { applyLoginResult, engineEnv, engineSpawnEnv, getProfile } from "./profiles.ts";
import { spawnBin } from "./spawn-bin.ts";

/** Só a URL de autorização sai daqui: o stdout cru pode conter token. */
const AUTHORIZE_RE = /https:\/\/[^\s"']*\/oauth\/authorize[^\s"']*/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
/** Código do callback: sem espaço e sem quebra, pra não injetar linha no stdin. */
const CODE_RE = /^[\x21-\x7e]{8,1024}$/;

const URL_TIMEOUT = 30_000;
const CODE_TIMEOUT = 90_000;
const SESSION_TTL = 5 * 60 * 1000;
const WATCH_INTERVAL = 1000;

export type LoginState = "waiting" | "done" | "failed";
export type LoginStatus = { state: LoginState; message?: string; profile?: Profile };

type Session = {
  id: string;
  profileId: string;
  home: string;
  url: string;
  child: ChildProcess;
  closed: boolean;
  state: LoginState;
  message?: string;
  watch: NodeJS.Timeout | null;
  ttl: NodeJS.Timeout;
};

const sessions = new Map<string, Session>();

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function claudeBin(): string {
  return process.env.NEXO_CLAUDE_BIN ?? "claude";
}

function requireClaude(profileId: string, home: string): Profile {
  const p = getProfile(profileId, home);
  if (!p) {
    const err = new Error(`perfil não existe: ${profileId}`) as Error & { status: number };
    err.status = 404;
    throw err;
  }
  if (p.engine !== "claude") throw badRequest(`login no app só vale pra engine claude (${profileId} é ${p.engine})`);
  return p;
}

function stopWatch(session: Session): void {
  if (session.watch) clearInterval(session.watch);
  session.watch = null;
}

function drop(id: string, kill: boolean): void {
  const s = sessions.get(id);
  if (!s) return;
  stopWatch(s);
  clearTimeout(s.ttl);
  sessions.delete(id);
  if (kill && !s.closed && s.child.pid) killTree(s.child.pid);
}

/** Login concluído: encerra o processo, que fica pendurado no prompt do código. */
function settle(session: Session, state: LoginState, message?: string): void {
  if (session.state !== "waiting") return;
  session.state = state;
  session.message = message;
  stopWatch(session);
  if (!session.closed && session.child.pid) killTree(session.child.pid);
}

export function cancelLogin(loginId: string): void {
  drop(loginId, true);
}

export function loginSessionCount(): number {
  return sessions.size;
}

/** Usado no encerramento e nos testes: não deixa processo de login órfão. */
export function cancelAllLogins(): void {
  for (const id of [...sessions.keys()]) drop(id, true);
}

/**
 * O CLI às vezes fecha o fluxo sozinho pelo callback do navegador e nunca pede
 * código — mas continua vivo no prompt. Então a verdade é a credencial no disco.
 */
export function loginStatus(loginId: string, home: string): LoginStatus {
  const session = sessions.get(loginId);
  if (!session) throw badRequest("sessão de login expirou — comece de novo");
  if (session.state === "waiting") {
    const profile = applyLoginResult(session.profileId, home);
    if (profile.status === "ready") settle(session, "done");
    else return { state: "waiting" };
  }
  const out: LoginStatus = { state: session.state, ...(session.message ? { message: session.message } : {}) };
  const profile = getProfile(session.profileId, home);
  if (profile) out.profile = profile;
  drop(loginId, true);
  return out;
}

export async function startLogin(
  profileId: string,
  home: string,
  opts: { email?: string } = {},
): Promise<{ loginId: string; url: string }> {
  const profile = requireClaude(profileId, home);
  if (opts.email && !EMAIL_RE.test(opts.email)) throw badRequest("e-mail inválido");

  for (const [id, s] of sessions) if (s.profileId === profileId) drop(id, true);

  const extra = engineEnv(profile, home);
  if (extra.CLAUDE_CONFIG_DIR) mkdirSync(extra.CLAUDE_CONFIG_DIR, { recursive: true });

  const args = ["auth", "login", "--claudeai", ...(opts.email ? ["--email", opts.email] : [])];
  const child = spawnBin(claudeBin(), args, {
    env: engineSpawnEnv(profile, home),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const id = randomBytes(8).toString("hex");
  const session: Session = {
    id,
    profileId,
    home,
    url: "",
    child,
    closed: false,
    state: "waiting",
    watch: null,
    ttl: setTimeout(() => drop(id, true), SESSION_TTL),
  };

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid) killTree(child.pid);
      reject(new Error("o CLI não devolveu a URL de login"));
    }, URL_TIMEOUT);
    const scan = (chunk: Buffer): void => {
      const found = AUTHORIZE_RE.exec(chunk.toString("utf8"));
      if (!found || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found[0]);
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      session.closed = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`login terminou antes da URL (exit ${code})`));
        return;
      }
      if (session.state !== "waiting") return;
      const ready = applyLoginResult(session.profileId, session.home).status === "ready";
      settle(session, ready ? "done" : "failed", ready ? undefined : `login terminou sem credencial (exit ${code})`);
    });
  });

  session.url = url;
  session.watch = setInterval(() => {
    if (session.state !== "waiting") return;
    if (applyLoginResult(session.profileId, session.home).status === "ready") settle(session, "done");
  }, WATCH_INTERVAL);
  sessions.set(id, session);
  return { loginId: id, url };
}

/** Caminho manual: a página mostrou um código e o usuário colou no app. */
export async function submitCode(
  loginId: string,
  code: string,
  home: string,
): Promise<{ ok: boolean; profile: Profile; message?: string }> {
  const session = sessions.get(loginId);
  if (!session) throw badRequest("sessão de login expirou — comece de novo");
  const trimmed = code.trim();
  if (!CODE_RE.test(trimmed)) throw badRequest("código inválido");

  if (session.state === "done") {
    const profile = applyLoginResult(session.profileId, home);
    drop(loginId, true);
    return { ok: true, profile };
  }
  if (session.closed) {
    const profile = applyLoginResult(session.profileId, home);
    drop(loginId, false);
    if (profile.status === "ready") return { ok: true, profile };
    throw badRequest("o login já tinha terminado — comece de novo");
  }

  const done = new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), CODE_TIMEOUT);
    session.child.once("close", (c) => {
      clearTimeout(timer);
      resolve(c ?? null);
    });
  });
  session.child.stdin?.write(`${trimmed}\n`);
  const exit = await done;
  const profile = applyLoginResult(session.profileId, home);
  drop(loginId, exit === null);

  if (profile.status === "ready") return { ok: true, profile };

  const status = cliAuthStatus(profile, home);
  const message =
    exit === null
      ? "o CLI não respondeu no tempo — tenta de novo"
      : status?.loggedIn
        ? "o CLI logou mas a credencial não apareceu na pasta do perfil"
        : "o código não foi aceito";
  return { ok: false, profile, message };
}
