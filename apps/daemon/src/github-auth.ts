import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ensureHome, githubAuthPath, githubLoginRunDir } from "./home.ts";
import { killTree } from "./kill-tree.ts";
import { spawnBin } from "./spawn-bin.ts";

/**
 * Conta única de GitHub, global (não por perfil): configurada uma vez em
 * Configurações e usada por todo agente. Ver `engineSpawnEnv` em profiles.ts,
 * que injeta o token daqui em todo processo de motor.
 *
 * O login roda `gh auth login --web` (device flow) apontando pra um
 * `GH_CONFIG_DIR` isolado e descartável — nunca pro `~/.config/gh` real da
 * máquina, então nunca troca a sessão pessoal de `gh` que a pessoa já tem no
 * terminal dela. Assim que o token sai (`gh auth token`), a pasta isolada é
 * apagada; o único registro que sobra é `github-auth.json`.
 */
const CODE_RE = /one-time code:\s*([A-Z0-9-]+)/i;
const URL_RE = /(https:\/\/\S+)/;

const CODE_TIMEOUT = 30_000;
const SESSION_TTL = 20 * 60 * 1000;

export type GithubLoginState = "waiting" | "done" | "failed";
export type GithubLoginStatus = {
  state: GithubLoginState;
  code?: string;
  url?: string;
  username?: string;
  message?: string;
};

type Session = {
  id: string;
  home: string;
  ghConfigDir: string;
  child: ChildProcess;
  closed: boolean;
  state: GithubLoginState;
  code?: string;
  url?: string;
  username?: string;
  message?: string;
  ttl: NodeJS.Timeout;
};

type GithubAuthStore = { token: string; username?: string; connectedAt: string };

const sessions = new Map<string, Session>();

function badRequest(message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function ghBin(): string {
  return process.env.NEXOS_GH_BIN ?? "gh";
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // melhor esforço: pasta descartável, não trava o fluxo se o SO ainda segurar um handle
  }
}

/** Roda um subcomando `gh` curto (harvest de token/usuário), apontando pro `GH_CONFIG_DIR` isolado da sessão. */
function runGh(args: string[], ghConfigDir: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawnBin(ghBin(), args, {
      env: { ...process.env, GH_CONFIG_DIR: ghConfigDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ ok: false, stdout: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim() }));
  });
}

function readStore(home: string): GithubAuthStore | undefined {
  const path = githubAuthPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GithubAuthStore>;
    if (typeof raw.token !== "string" || !raw.token) return undefined;
    return {
      token: raw.token,
      ...(typeof raw.username === "string" && raw.username ? { username: raw.username } : {}),
      connectedAt: typeof raw.connectedAt === "string" ? raw.connectedAt : "",
    };
  } catch {
    // arquivo corrompido não pode travar a tela de config nem o spawn de agente: some a conta
    return undefined;
  }
}

function writeStore(store: GithubAuthStore, home: string): void {
  ensureHome(home);
  writeFileSync(githubAuthPath(home), JSON.stringify(store, null, 2), "utf8");
}

/** Token global do GitHub, se alguma conta estiver conectada — usado por `engineSpawnEnv`. */
export function githubToken(home: string): string | undefined {
  return readStore(home)?.token;
}

export function githubAccount(home: string): { connected: boolean; username?: string; connectedAt?: string } {
  const store = readStore(home);
  if (!store) return { connected: false };
  return { connected: true, ...(store.username ? { username: store.username } : {}), connectedAt: store.connectedAt };
}

/**
 * Só apaga o registro local — não revoga o token no GitHub (mesmo comportamento
 * documentado de `gh auth logout`). Revogar de vez: github.com/settings/applications.
 */
export function disconnectGithub(home: string): void {
  const path = githubAuthPath(home);
  if (existsSync(path)) rmSync(path, { force: true });
}

function stopSession(id: string, kill: boolean): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.ttl);
  sessions.delete(id);
  if (kill && !s.closed && s.child.pid) killTree(s.child.pid);
  cleanupDir(s.ghConfigDir);
}

export function cancelGithubLogin(loginId: string): void {
  stopSession(loginId, true);
}

/** Usado nos testes: não deixa processo de login órfão entre casos. */
export function cancelAllGithubLogins(): void {
  for (const id of [...sessions.keys()]) stopSession(id, true);
}

async function finalize(session: Session, exitCode: number | null): Promise<void> {
  session.closed = true;
  if (session.state !== "waiting") return;
  if (exitCode !== 0) {
    session.state = "failed";
    session.message = `login cancelado ou expirado (código ${exitCode ?? "desconhecido"})`;
    return;
  }
  const token = await runGh(["auth", "token", "--hostname", "github.com"], session.ghConfigDir);
  if (!token.ok || !token.stdout) {
    session.state = "failed";
    session.message = "o GitHub confirmou o login mas o token não apareceu";
    return;
  }
  const who = await runGh(["api", "user", "-q", ".login"], session.ghConfigDir);
  const username = who.ok && who.stdout ? who.stdout : undefined;
  writeStore({ token: token.stdout, ...(username ? { username } : {}), connectedAt: new Date().toISOString() }, session.home);
  session.username = username;
  session.state = "done";
}

export async function startGithubLogin(home: string): Promise<{ loginId: string; code: string; url: string }> {
  cancelAllGithubLogins();

  const id = randomBytes(8).toString("hex");
  const ghConfigDir = githubLoginRunDir(id, home);
  mkdirSync(ghConfigDir, { recursive: true });

  const args = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage"];
  const child = spawnBin(ghBin(), args, {
    env: { ...process.env, GH_CONFIG_DIR: ghConfigDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const session: Session = {
    id,
    home,
    ghConfigDir,
    child,
    closed: false,
    state: "waiting",
    ttl: setTimeout(() => stopSession(id, true), SESSION_TTL),
  };
  sessions.set(id, session);

  const captured = await new Promise<{ code: string; url: string }>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid) killTree(child.pid);
      reject(new Error("o gh não devolveu o código de login"));
    }, CODE_TIMEOUT);
    let buf = "";
    const scan = (chunk: Buffer): void => {
      if (settled) return;
      // As duas linhas (código e URL) podem chegar em `data` events separados
      // mesmo saindo de dois `write` seguidos no processo filho — acumula em vez
      // de testar só o chunk atual, senão nunca casa os dois ao mesmo tempo.
      buf += chunk.toString("utf8");
      const code = CODE_RE.exec(buf)?.[1];
      const url = URL_RE.exec(buf)?.[1];
      if (!code || !url) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, url });
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`login terminou antes do código (código ${code ?? "desconhecido"})`));
    });
  }).catch((err) => {
    stopSession(id, true);
    throw badRequest((err as Error).message);
  });

  session.code = captured.code;
  session.url = captured.url;
  child.on("close", (code) => {
    void finalize(session, code);
  });

  return { loginId: id, ...captured };
}

export function githubLoginStatus(loginId: string): GithubLoginStatus {
  const session = sessions.get(loginId);
  if (!session) throw badRequest("sessão de login expirou — comece de novo");
  const out: GithubLoginStatus = {
    state: session.state,
    ...(session.code ? { code: session.code } : {}),
    ...(session.url ? { url: session.url } : {}),
    ...(session.username ? { username: session.username } : {}),
    ...(session.message ? { message: session.message } : {}),
  };
  if (session.state !== "waiting") stopSession(loginId, false);
  return out;
}
