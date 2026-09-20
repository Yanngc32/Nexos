import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { alvoDePullRequest, githubDoRemote } from "../src/git.ts";

/* Mesmo motivo de worktree.test.ts: cada caso roda git de verdade, e 5s não cobre isso no CI. */
vi.setConfig({ testTimeout: 30_000 });

/**
 * Repositório de verdade num temp, com um "remote" que não existe: nada aqui
 * vai à rede — `origin/<branch>` é criado como ref local, que é exatamente o
 * que um `fetch` teria deixado.
 */
function repo({ remote = "git@github.com:dono/projeto.git", comCommit = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-git-pr-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "teste@nexo");
  git("config", "user.name", "Teste");
  git("config", "commit.gpgsign", "false");
  if (remote) git("remote", "add", "origin", remote);
  if (comCommit) {
    writeFileSync(join(dir, "a.txt"), "a", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "inicial");
  }
  return dir;
}

function comBranch(dir: string, branch: string, { noRemote = true } = {}): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("checkout", "-q", "-b", branch);
  // o que um push seguido de fetch teria deixado: a ref de rastreio do remote
  if (noRemote) git("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
}

describe("githubDoRemote", () => {
  it("entende as três formas que o git produz", () => {
    for (const url of [
      "https://github.com/dono/projeto.git",
      "https://github.com/dono/projeto",
      "git@github.com:dono/projeto.git",
      "ssh://git@github.com/dono/projeto.git",
    ]) {
      expect(githubDoRemote(url), url).toEqual({ owner: "dono", repo: "projeto" });
    }
  });

  it("recusa remote que NÃO é do github.com", () => {
    /*
     * O ponto todo de validar host: sem isso um remote do GitLab viraria um
     * link de github.com com o mesmo owner/repo — 404, ou pior, o repositório
     * de outra pessoa que por acaso tem esse nome.
     */
    expect(githubDoRemote("https://gitlab.com/dono/projeto.git")).toBeUndefined();
    expect(githubDoRemote("git@bitbucket.org:dono/projeto.git")).toBeUndefined();
    expect(githubDoRemote("https://github.com.br/dono/projeto")).toBeUndefined();
  });

  it("recusa o que não é um repositório raiz", () => {
    expect(githubDoRemote("https://github.com/dono")).toBeUndefined();
    expect(githubDoRemote("https://github.com/dono/projeto/sub")).toBeUndefined();
    expect(githubDoRemote("")).toBeUndefined();
    expect(githubDoRemote("nada disso")).toBeUndefined();
  });
});

describe("alvoDePullRequest", () => {
  it("monta o link de compare da branch atual", async () => {
    const dir = repo();
    comBranch(dir, "feat-x");
    const alvo = await alvoDePullRequest(dir);
    expect(alvo).toEqual({
      owner: "dono",
      repo: "projeto",
      branch: "feat-x",
      url: "https://github.com/dono/projeto/compare/feat-x?expand=1",
    });
  });

  it("branch com barra mantém a barra e escapa o resto", async () => {
    /*
     * `feat/x` é o caso de todo dia e o GitHub espera a barra literal no
     * caminho. Já `#` é válido em nome de branch no git e cortaria a URL no
     * fragmento se fosse cru — daí escapar por segmento em vez de tudo ou nada.
     */
    const dir = repo();
    comBranch(dir, "feat/coisa#5");
    const { url } = await alvoDePullRequest(dir);
    expect(url).toBe("https://github.com/dono/projeto/compare/feat/coisa%235?expand=1");
  });

  it("branch que ainda não foi pro remote é recusada com o que fazer", async () => {
    /*
     * É o erro mais comum de todos: commitou e clicou. Sem esta recusa o GitHub
     * abre dizendo "There isn't anything to compare" e a pessoa não descobre
     * que só faltou o push.
     */
    const dir = repo();
    comBranch(dir, "feat-y", { noRemote: false });
    await expect(alvoDePullRequest(dir)).rejects.toThrow(/ainda não está no GitHub/);
  });

  it("estando na branch base, recusa em vez de abrir um compare vazio", async () => {
    const dir = repo();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], {
      cwd: dir,
      stdio: "pipe",
    });
    await expect(alvoDePullRequest(dir)).rejects.toThrow(/é a branch base/);
  });

  it("remote que não é do GitHub é recusado dizendo qual é", async () => {
    const dir = repo({ remote: "https://gitlab.com/dono/projeto.git" });
    comBranch(dir, "feat-z");
    await expect(alvoDePullRequest(dir)).rejects.toThrow(/não é um repositório do github\.com/);
  });

  it("repositório sem remote origin", async () => {
    const dir = repo({ remote: "" });
    await expect(alvoDePullRequest(dir)).rejects.toThrow(/remote `origin`/);
  });

  it("pasta que não é repositório git", async () => {
    await expect(alvoDePullRequest(mkdtempSync(join(tmpdir(), "nexo-sem-git-")))).rejects.toThrow(
      /não é um repositório git/,
    );
  });

  it("pasta que não existe", async () => {
    await expect(alvoDePullRequest(join(tmpdir(), "nexo-nao-existe-nunca"))).rejects.toThrow(/não existe/);
  });

  it("recusa vira 400, não 500 — é pedido que o cliente conserta", async () => {
    const erro = await alvoDePullRequest(repo({ remote: "" })).then(
      () => undefined,
      (e) => e as Error & { status?: number },
    );
    expect(erro?.status).toBe(400);
  });
});
