import { githubToken } from "./github-auth.ts";
import { spawnBin } from "./spawn-bin.ts";

/**
 * Repositórios e branches da conta de GitHub conectada (github-auth.ts), pro
 * seletor do "Clonar repositório". Autentica cada chamada via `GH_TOKEN` —
 * sem isso o `gh` tentaria a sessão pessoal da máquina (ou nenhuma), não a
 * conta que o Nexo guardou.
 */

function ghBin(): string {
  return process.env.NEXO_GH_BIN ?? "gh";
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function requireToken(home: string): string {
  const token = githubToken(home);
  if (!token) throw badRequest("GitHub não conectado — configure em Configurações → GitHub");
  return token;
}

function runGh(args: string[], token: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnBin(ghBin(), args, {
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

export type GithubRepo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
  cloneUrl: string;
};

const REPO_JSON_FIELDS = "nameWithOwner,isPrivate,defaultBranchRef,updatedAt,url";

type RepoRaw = {
  nameWithOwner: string;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
  updatedAt: string;
  url: string;
};

/** Repositórios do dono da conta conectada (equivalente a `gh repo list`, sem argumento). */
export async function listGithubRepos(home: string): Promise<GithubRepo[]> {
  const token = requireToken(home);
  const r = await runGh(["repo", "list", "--limit", "200", "--json", REPO_JSON_FIELDS], token);
  if (!r.ok) throw new Error(r.stderr || "não deu pra listar os repositórios");
  let raw: RepoRaw[];
  try {
    raw = JSON.parse(r.stdout || "[]") as RepoRaw[];
  } catch {
    throw new Error("resposta inesperada do gh ao listar repositórios");
  }
  return raw
    .map((x) => ({
      fullName: x.nameWithOwner,
      private: x.isPrivate,
      defaultBranch: x.defaultBranchRef?.name || "main",
      updatedAt: x.updatedAt,
      cloneUrl: `${x.url}.git`,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/;

export async function listGithubBranches(home: string, fullName: string): Promise<string[]> {
  const token = requireToken(home);
  if (!REPO_FULL_NAME.test(fullName)) throw badRequest("repositório inválido");
  const r = await runGh(["api", `repos/${fullName}/branches`, "--paginate", "-q", ".[].name"], token);
  if (!r.ok) throw new Error(r.stderr || "não deu pra listar as branches");
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
