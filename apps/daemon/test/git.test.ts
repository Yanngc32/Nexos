import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  alvoDePullRequest,
  atualizar,
  clonar,
  estadoDoRepo,
  githubDoRemote,
  gitStream,
  listarBranches,
  trocarBranch,
  validarUrlDeClone,
} from "../src/git.ts";

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

describe("validarUrlDeClone", () => {
  it("aceita https e ssh, e tira o nome da pasta", () => {
    expect(validarUrlDeClone("https://github.com/dono/projeto.git").nome).toBe("projeto");
    expect(validarUrlDeClone("https://github.com/dono/projeto").nome).toBe("projeto");
    expect(validarUrlDeClone("git@github.com:dono/projeto.git").nome).toBe("projeto");
    expect(validarUrlDeClone("ssh://git@github.com/dono/projeto.git").nome).toBe("projeto");
    // host qualquer serve: clonar do GitLab não tem por que ser recusado
    expect(validarUrlDeClone("https://gitlab.com/dono/projeto.git").nome).toBe("projeto");
  });

  it("recusa `ext::`, que executa comando", () => {
    /*
     * É a razão de a lista de esquemas ser branca. `ext::` é transporte
     * legítimo do git e roda o que vier depois: clonar essa URL é rodar código
     * arbitrário na máquina da pessoa.
     */
    expect(() => validarUrlDeClone('ext::sh -c "touch /tmp/invadido"')).toThrow();
    expect(() => validarUrlDeClone("file:///etc")).toThrow();
    expect(() => validarUrlDeClone("git://github.com/dono/projeto.git")).toThrow();
  });

  it("recusa link começando com `-`, que o git leria como flag", () => {
    expect(() => validarUrlDeClone("--upload-pack=touch /tmp/invadido")).toThrow(/não pode começar com/);
  });

  it("recusa link sem nome de pasta utilizável", () => {
    expect(() => validarUrlDeClone("https://github.com/")).toThrow();
    expect(() => validarUrlDeClone("")).toThrow(/faltou o link/);
  });
});

describe("clonar", () => {
  it("recusa caminho local — link é https ou ssh, e é isso que mantém `ext::` fora", async () => {
    const origem = repo();
    const destino = mkdtempSync(join(tmpdir(), "nexo-clone-"));
    await expect(clonar(origem, destino)).rejects.toThrow();
  });

  /*
   * O clone de verdade não passa por `clonar()` aqui: ela só aceita https/ssh
   * (de propósito — é o que barra `ext::`), e um teste não deve ir à rede. O
   * que dá pra provar offline é o MECANISMO que ela usa, com um repo local:
   * que o clone funciona e que o progresso sai em linhas enquanto acontece, em
   * vez de tudo de uma vez no fim.
   */
  it("o mecanismo por trás (gitStream + --progress) clona e emite progresso em linhas", async () => {
    const origem = repo();
    const destino = mkdtempSync(join(tmpdir(), "nexo-clone-real-"));
    const linhas: string[] = [];
    const r = await gitStream(["clone", "--progress", "--", origem, join(destino, "copia")], destino, (l) =>
      linhas.push(l),
    );
    expect(r.ok, r.saida).toBe(true);
    expect(existsSync(join(destino, "copia", "a.txt"))).toBe(true);
    expect(linhas.length, "progresso chega em pedaços, não de uma vez").toBeGreaterThan(0);
    expect(linhas.join("\n")).toMatch(/Cloning|Clonando|done|feito/i);
  });

  it("recusa destino que não existe", async () => {
    await expect(clonar("https://github.com/dono/projeto.git", join(tmpdir(), "nao-existe-nunca"))).rejects.toThrow(
      /pasta de destino não existe/,
    );
  });

  it("recusa sobrescrever pasta que já tem conteúdo", async () => {
    const destino = mkdtempSync(join(tmpdir(), "nexo-clone-"));
    mkdirSync(join(destino, "projeto"));
    writeFileSync(join(destino, "projeto", "importante.txt"), "não me apague", "utf8");
    await expect(clonar("https://github.com/dono/projeto.git", destino)).rejects.toThrow(/já existe uma pasta/);
    // e o arquivo continua lá
    expect(existsSync(join(destino, "projeto", "importante.txt"))).toBe(true);
  });
});

describe("estadoDoRepo", () => {
  it("branch limpa, sem upstream", async () => {
    const dir = repo();
    const e = await estadoDoRepo(dir);
    expect(e.branch).toBe("main");
    expect(e.limpo).toBe(true);
    expect(e.upstream).toBeUndefined();
    expect(e.github).toEqual({ owner: "dono", repo: "projeto" });
  });

  it("árvore suja é detectada", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "mudou", "utf8");
    expect((await estadoDoRepo(dir)).limpo).toBe(false);
  });

  it("conta quantos commits atrás do upstream", async () => {
    const dir = repo();
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    // upstream com um commit a mais que o local: é o que um fetch teria trazido
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("branch", "--set-upstream-to=origin/main", "main");
    writeFileSync(join(dir, "b.txt"), "b", "utf8");
    g("add", "-A");
    g("commit", "-q", "-m", "do remote");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    g("reset", "-q", "--hard", "HEAD~1");
    const e = await estadoDoRepo(dir);
    expect(e.upstream).toBe("origin/main");
    expect(e.atras).toBe(1);
    expect(e.adiante).toBe(0);
  });
});

describe("listarBranches", () => {
  it("lista as locais e diz qual é a atual", async () => {
    const dir = repo();
    comBranch(dir, "feat-a", { noRemote: false });
    const r = await listarBranches(dir);
    expect(r.atual).toBe("feat-a");
    expect(r.locais.sort()).toEqual(["feat-a", "main"]);
  });
});

describe("trocarBranch", () => {
  it("troca quando a árvore está limpa", async () => {
    const dir = repo();
    comBranch(dir, "feat-b", { noRemote: false });
    await trocarBranch(dir, "main");
    expect((await estadoDoRepo(dir)).branch).toBe("main");
  });

  it("recusa com mudança não commitada, em vez de levar ela junto", async () => {
    /*
     * O git deixa trocar carregando a mudança, e ela "segue" pra outra branch —
     * some da que a pessoa achava estar editando. Perder trabalho assim é
     * silencioso, então quem decide é ela, no terminal.
     */
    const dir = repo();
    comBranch(dir, "feat-c", { noRemote: false });
    writeFileSync(join(dir, "a.txt"), "trabalho não salvo", "utf8");
    await expect(trocarBranch(dir, "main")).rejects.toThrow(/não commitada/);
    expect((await estadoDoRepo(dir)).branch, "continua onde estava").toBe("feat-c");
  });

  it("recusa nome de branch começando com `-` (viraria flag do git)", async () => {
    await expect(trocarBranch(repo(), "--help")).rejects.toThrow(/inválido/);
  });

  it("branch que não existe volta o motivo do git", async () => {
    await expect(trocarBranch(repo(), "nao-existe")).rejects.toThrow();
  });
});

describe("atualizar", () => {
  it("recusa com árvore suja, antes de qualquer fetch", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "mudou", "utf8");
    await expect(atualizar(dir)).rejects.toThrow(/não commitada/);
  });

  it("recusa quando as duas pontas andaram — nunca junta sozinho", async () => {
    /*
     * A fronteira do "atualizar": fast-forward ou nada. Merge automático no
     * repositório de outra pessoa é o que, quando dá errado, ninguém desfaz
     * sem saber git — e quem clicou em "atualizar" não pediu por isso.
     */
    const dir = repo();
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    // um remote local de verdade, pra o fetch funcionar sem rede
    const remoto = mkdtempSync(join(tmpdir(), "nexo-remoto-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remoto], { stdio: "pipe" });
    g("remote", "remove", "origin");
    g("remote", "add", "origin", remoto);
    g("push", "-q", "-u", "origin", "main");

    // o remote anda...
    const clone = mkdtempSync(join(tmpdir(), "nexo-clone2-"));
    execFileSync("git", ["clone", "-q", remoto, join(clone, "c")], { stdio: "pipe" });
    const gc = (...args: string[]) => execFileSync("git", args, { cwd: join(clone, "c"), stdio: "pipe" });
    gc("config", "user.email", "t@n");
    gc("config", "user.name", "T");
    gc("config", "commit.gpgsign", "false");
    writeFileSync(join(clone, "c", "remoto.txt"), "r", "utf8");
    gc("add", "-A");
    gc("commit", "-q", "-m", "do remote");
    gc("push", "-q");

    // ...e o local também
    writeFileSync(join(dir, "local.txt"), "l", "utf8");
    g("add", "-A");
    g("commit", "-q", "-m", "meu");

    await expect(atualizar(dir)).rejects.toThrow(/as duas pontas andaram/);
  });

  it("avança quando dá fast-forward, e diz quantos commits trouxe", async () => {
    const dir = repo();
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    const remoto = mkdtempSync(join(tmpdir(), "nexo-remoto-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remoto], { stdio: "pipe" });
    g("remote", "remove", "origin");
    g("remote", "add", "origin", remoto);
    g("push", "-q", "-u", "origin", "main");

    const clone = mkdtempSync(join(tmpdir(), "nexo-clone3-"));
    execFileSync("git", ["clone", "-q", remoto, join(clone, "c")], { stdio: "pipe" });
    const gc = (...args: string[]) => execFileSync("git", args, { cwd: join(clone, "c"), stdio: "pipe" });
    gc("config", "user.email", "t@n");
    gc("config", "user.name", "T");
    gc("config", "commit.gpgsign", "false");
    writeFileSync(join(clone, "c", "novo.txt"), "n", "utf8");
    gc("add", "-A");
    gc("commit", "-q", "-m", "do remote");
    gc("push", "-q");

    const r = await atualizar(dir);
    expect(r.trazidos).toBe(1);
    expect(r.jaEstavaEmDia).toBe(false);
    expect(existsSync(join(dir, "novo.txt")), "o arquivo do remote chegou").toBe(true);
  });

  it("já em dia não é erro", async () => {
    const dir = repo();
    const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    const remoto = mkdtempSync(join(tmpdir(), "nexo-remoto-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remoto], { stdio: "pipe" });
    g("remote", "remove", "origin");
    g("remote", "add", "origin", remoto);
    g("push", "-q", "-u", "origin", "main");
    const r = await atualizar(dir);
    expect(r.jaEstavaEmDia).toBe(true);
    expect(r.trazidos).toBe(0);
  });
});
