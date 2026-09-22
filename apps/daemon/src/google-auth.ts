import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { GOOGLE_CLIENT_PADRAO } from "./google-client.ts";
import { ensureHome, googleAuthPath } from "./home.ts";

/**
 * Conta Google única e global: refresh token, access token e o client do app. O fluxo de login
 * (navegador + escolha da pasta) mora em google-conectar.ts.
 *
 * Escopo `drive.file`: o Nexo só LÊ E ESCREVE o que ELE criou (ou a pasta que a pessoa escolher no
 * navegador de pastas — ver google-conectar.ts). `drive.metadata.readonly` é só pra listar nome e
 * subpastas na hora de escolher; sozinho não dá acesso a conteúdo nenhum.
 */
export const SCOPES = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
export function authUrl(): string {
  return process.env.NEXO_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
}
export function tokenUrl(): string {
  return process.env.NEXO_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
}

export type GoogleStore = {
  refreshToken?: string;
  email?: string;
  connectedAt?: string;
  /** Pasta do Drive onde ficam os projetos (escolhida no login, ver google-conectar.ts). */
  folderId?: string;
  folderName?: string;
};

function httpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export function readGoogleStore(home: string): GoogleStore {
  const path = googleAuthPath(home);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: GoogleStore = {};
    for (const k of ["refreshToken", "email", "connectedAt", "folderId", "folderName"] as const) {
      if (typeof raw[k] === "string" && raw[k]) out[k] = raw[k] as string;
    }
    return out;
  } catch {
    // arquivo corrompido não pode travar a tela de config: some a conta, o resto continua funcionando
    return {};
  }
}

/** Merge raso; `undefined` no patch apaga o campo. Escrita atômica com 0600 (tem refresh token). */
export function updateGoogleStore(home: string, patch: { [K in keyof GoogleStore]?: string | undefined }): GoogleStore {
  ensureHome(home);
  const next: Record<string, string> = { ...readGoogleStore(home) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete next[k];
    else next[k] = v;
  }
  const path = googleAuthPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  return next as GoogleStore;
}

/** Client OAuth do app: o embutido (google-client.ts); env sobrescreve, pra desenvolvimento. */
export function googleClient(): { clientId: string; clientSecret: string } | undefined {
  const clientId = process.env.NEXO_GOOGLE_CLIENT_ID || GOOGLE_CLIENT_PADRAO.clientId;
  if (!clientId) return undefined;
  return { clientId, clientSecret: process.env.NEXO_GOOGLE_CLIENT_SECRET ?? GOOGLE_CLIENT_PADRAO.clientSecret };
}

export function googleAccount(home: string): {
  connected: boolean;
  email?: string;
  connectedAt?: string;
  /** Login com Google disponível nesta build (client embutido). */
  disponivel: boolean;
  folder?: { id: string; name: string };
} {
  const store = readGoogleStore(home);
  return {
    connected: Boolean(store.refreshToken),
    ...(store.email ? { email: store.email } : {}),
    ...(store.connectedAt ? { connectedAt: store.connectedAt } : {}),
    disponivel: Boolean(googleClient()),
    ...(store.folderId ? { folder: { id: store.folderId, name: store.folderName ?? store.folderId } } : {}),
  };
}

/** Só apaga o registro local — não revoga no Google (myaccount.google.com/permissions faz isso). */
export function disconnectGoogle(home: string): void {
  updateGoogleStore(home, { refreshToken: undefined, email: undefined, connectedAt: undefined });
  tokenCache.clear();
}

export function limparCacheToken(): void {
  tokenCache.clear();
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error?: string; error_description?: string };

export async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || body.error) {
    const err = httpError(body.error_description || body.error || `Google respondeu ${res.status}`, 400);
    (err as Error & { code?: string }).code = body.error;
    throw err;
  }
  return body;
}

export function emailDoIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/* ---------- access token ---------- */

const tokenCache = new Map<string, { token: string; exp: number }>();

/**
 * Access token válido (renova pelo refresh token quando falta menos de 1 min). `forcar` ignora o
 * cache — usado depois de um 401. Refresh token revogado (`invalid_grant`) desconecta a conta
 * local, pra tela mostrar "não conectado" em vez de errar pra sempre.
 */
export async function googleAccessToken(home: string, forcar = false): Promise<string> {
  const store = readGoogleStore(home);
  const client = googleClient();
  if (!store.refreshToken || !client) throw httpError("conta Google não conectada", 401);
  const chave = `${home}\0${store.refreshToken}`;
  const cached = tokenCache.get(chave);
  if (!forcar && cached && cached.exp - 60_000 > Date.now()) return cached.token;
  try {
    const tok = await postToken({
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      refresh_token: store.refreshToken,
      grant_type: "refresh_token",
    });
    if (!tok.access_token) throw httpError("o Google não devolveu access token", 502);
    tokenCache.set(chave, { token: tok.access_token, exp: Date.now() + (tok.expires_in ?? 3600) * 1000 });
    return tok.access_token;
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_grant") {
      disconnectGoogle(home);
      throw httpError("o acesso ao Google foi revogado — entre de novo", 401);
    }
    throw e;
  }
}
