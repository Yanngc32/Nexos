import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  apagarBranchesNexo,
  commitarTrabalho,
  criarWorktree,
  listarBranchesNexo,
  nomeDoBranch,
  podeIsolar,
  removerWorktree,
  temMudanca,
} from "../src/worktree.ts";

/*
 * Todo teste aqui roda `git` de verdade — de 5 a 10 processos por caso, contra
 * disco. Os 5s padrão do vitest são pra teste de lógica; num runner Windows
 * lento um `worktree add` + `commit` + `worktree remove` passa disso e o caso
 * morre por tempo, sem nada de errado no código. Já aconteceu no CI.
 *
 * O teto continua existindo (30s, não infinito): git que não volta é defeito, e
 * o teste tem que dizer isso em vez de pendurar o CI.
 */
vi.setConfig({ testTimeout: 30_000 });

/** Conteúdo sem depender de fim de linha: o git troca LF por CRLF no Windows. */
function texto(arquivo: string): string {
  return readFileSync(arquivo, "utf8").replace(/\r\n/g, "\n").trim();
}

/** Repositório de verdade num temp: worktree não dá pra mockar sem virar teste de nada. */
function repo({ comCommit = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "teste@nexo");
  git("config", "user.name", "Teste");
  git("config", "commit.gpgsign", "false");
  if (comCommit) {
    writeFileSync(join(dir, "a.txt"), "original\n", "utf8");
    git("add", "-A");
    git("commit", "-q", "-m", "primeiro");
  }
  return dir;
}

describe("podeIsolar", () => {
  it("repositório com commit pode", async () => {
    expect(await podeIsolar(repo())).toEqual({ pode: true });
  });

  it("repositório sem commit não pode: worktree parte de um ponto do histórico", async () => {
    const r = await podeIsolar(repo({ comCommit: false }));
    expect(r.pode).toBe(false);
    expect(r.motivo).toMatch(/commit/);
  });

  it("pasta que não é repositório não pode", async () => {
    const r = await podeIsolar(mkdtempSync(join(tmpdir(), "nexo-nogit-")));
    expect(r.pode).toBe(false);
    expect(r.motivo).toMatch(/repositório git/);
  });

  it("pasta que não existe não pode, e não estoura", async () => {
    const r = await podeIsolar("/nao/existe/mesmo");
    expect(r.pode).toBe(false);
    expect(r.motivo).toMatch(/não existe/);
  });
});

describe("nomeDoBranch", () => {
  it("é previsível: é por ele que se acha o trabalho depois", () => {
    expect(nomeDoBranch("r-abc", 0, "revisor")).toBe("nexo/r-abc/1-revisor");
    expect(nomeDoBranch("r-abc", 2, "redator")).toBe("nexo/r-abc/3-redator");
  });
});

describe("worktree", () => {
  it("cria a árvore com o conteúdo do HEAD, num branch próprio", async () => {
    const r = repo();
    const dir = join(r, "..", `wt-${Date.now()}`);
    const out = await criarWorktree(r, dir, "nexo/teste/1-a");
    expect(out.ok).toBe(true);
    // conteúdo, não bytes: no Windows o core.autocrlf do git troca LF por CRLF
    // no checkout da árvore, e travar o literal daria falha por plataforma
    expect(texto(join(dir, "a.txt"))).toBe("original");
    await removerWorktree(r, dir);
  });

  it("duas árvores do mesmo repo não compartilham arquivo", async () => {
    const r = repo();
    const d1 = join(r, "..", `wt1-${Date.now()}`);
    const d2 = join(r, "..", `wt2-${Date.now()}`);
    await criarWorktree(r, d1, "nexo/teste/1-a");
    await criarWorktree(r, d2, "nexo/teste/2-b");

    writeFileSync(join(d1, "a.txt"), "do primeiro\n", "utf8");
    writeFileSync(join(d2, "a.txt"), "do segundo\n", "utf8");

    // é exatamente isto que o isolamento existe pra garantir
    expect(texto(join(d1, "a.txt"))).toBe("do primeiro");
    expect(texto(join(d2, "a.txt"))).toBe("do segundo");
    // e o projeto original fica intocado
    expect(texto(join(r, "a.txt"))).toBe("original");

    await removerWorktree(r, d1);
    await removerWorktree(r, d2);
  });

  it("branch repetido é recusado com o motivo", async () => {
    const r = repo();
    const d1 = join(r, "..", `wtx-${Date.now()}`);
    const d2 = join(r, "..", `wty-${Date.now()}`);
    await criarWorktree(r, d1, "nexo/teste/mesmo");
    const segundo = await criarWorktree(r, d2, "nexo/teste/mesmo");
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.motivo.length).toBeGreaterThan(0);
    await removerWorktree(r, d1);
  });

  it("temMudanca vê o que o agente deixou", async () => {
    const r = repo();
    const dir = join(r, "..", `wtm-${Date.now()}`);
    await criarWorktree(r, dir, "nexo/teste/1-m");
    expect(await temMudanca(dir)).toBe(false);
    writeFileSync(join(dir, "novo.txt"), "oi", "utf8");
    expect(await temMudanca(dir)).toBe(true);
    await removerWorktree(r, dir);
  });

  it("o trabalho é commitado antes de a árvore sair, senão o branch ficaria vazio", async () => {
    const r = repo();
    const dir = join(r, "..", `wtc-${Date.now()}`);
    const branch = "nexo/teste/1-c";
    await criarWorktree(r, dir, branch);
    writeFileSync(join(dir, "feito.txt"), "trabalho do agente", "utf8");
    await commitarTrabalho(dir, "nexo: agente");
    await removerWorktree(r, dir);

    // a árvore sumiu, o branch ficou com o conteúdo
    const conteudo = execFileSync("git", ["show", `${branch}:feito.txt`], { cwd: r, encoding: "utf8" });
    expect(conteudo.trim()).toBe("trabalho do agente");
  });

  it("remover árvore que já sumiu do disco não vira erro fatal", async () => {
    const r = repo();
    const out = await removerWorktree(r, join(r, "..", "nunca-existiu"));
    expect(out.ok).toBe(false);
    // o prune roda por dentro; o importante é não estourar
  });
});

/*
 * A limpeza. Também com git de verdade: o critério de segurança inteiro é
 * "o git aceita apagar isto?", e um git mockado responderia o que eu quisesse
 * ouvir — que é o oposto do que este teste precisa provar.
 */
describe("limpeza dos branches nexo/*", () => {
  /** Cria o branch como o fan-in cria: árvore, commit, árvore removida. */
  async function branchDeAgente(r: string, branch: string, arquivo: string): Promise<void> {
    const dir = join(r, "..", `lb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await criarWorktree(r, dir, branch);
    writeFileSync(join(dir, arquivo), "trabalho\n", "utf8");
    await commitarTrabalho(dir, `nexo: ${branch}`);
    await removerWorktree(r, dir);
  }

  it("não lista branch nenhum num repo que nunca rodou time", async () => {
    expect(await listarBranchesNexo(repo())).toEqual([]);
  });

  it("lista os nexo/* com o run e a data, e ignora branch de pessoa", async () => {
    const r = repo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: r, stdio: "pipe" });
    await branchDeAgente(r, "nexo/run7/1-revisor", "a.md");
    await branchDeAgente(r, "nexo/run7/2-testador", "b.md");
    git("branch", "meu-trabalho");

    const lista = await listarBranchesNexo(r);
    expect(lista.map((b) => b.branch).sort()).toEqual(["nexo/run7/1-revisor", "nexo/run7/2-testador"]);
    expect(lista.every((b) => b.runId === "run7")).toBe(true);
    expect(lista[0]!.ultimo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("branch com commit fora do HEAD é 'não mesclado' e NÃO é apagado", async () => {
    const r = repo();
    await branchDeAgente(r, "nexo/run8/1-agente", "feito.md");

    const [b] = await listarBranchesNexo(r);
    expect(b!.mesclado).toBe(false);

    // é o cenário real: o run acabou, ninguém olhou, e a limpeza não pode levar
    const feitos = await apagarBranchesNexo(r, ["nexo/run8/1-agente"]);
    expect(feitos[0]!.ok).toBe(false);
    expect(await listarBranchesNexo(r)).toHaveLength(1);
    // e o commit continua alcançável pelo branch
    expect(execFileSync("git", ["show", "nexo/run8/1-agente:feito.md"], { cwd: r, encoding: "utf8" })).toContain(
      "trabalho",
    );
  });

  it("depois de mesclado o branch sai: apagar não perde commit nenhum", async () => {
    const r = repo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: r, stdio: "pipe" });
    await branchDeAgente(r, "nexo/run9/1-agente", "aceito.md");
    git("merge", "--no-edit", "-q", "nexo/run9/1-agente");

    expect((await listarBranchesNexo(r))[0]!.mesclado).toBe(true);
    const feitos = await apagarBranchesNexo(r, ["nexo/run9/1-agente"]);
    expect(feitos[0]!.ok).toBe(true);
    expect(await listarBranchesNexo(r)).toEqual([]);
    // o trabalho ficou: ele está no HEAD, que é a razão de ter podido apagar
    expect(execFileSync("git", ["show", "HEAD:aceito.md"], { cwd: r, encoding: "utf8" })).toContain("trabalho");
  });

  it("branch em checkout numa árvore viva não é apagado — é o run que está rodando", async () => {
    const r = repo();
    const dir = join(r, "..", `lbviva-${Date.now()}`);
    await criarWorktree(r, dir, "nexo/run10/1-agente");
    // sem commit: o branch está no HEAD, então o -d NÃO é barrado por commit solto
    expect((await listarBranchesNexo(r))[0]!.mesclado).toBe(true);

    const feitos = await apagarBranchesNexo(r, ["nexo/run10/1-agente"]);
    expect(feitos[0]!.ok).toBe(false);
    expect(feitos[0]!.saida).toMatch(/worktree|checked out|utilizado|check-out/i);
    expect(await listarBranchesNexo(r)).toHaveLength(1);
    await removerWorktree(r, dir);
  });

  it("recusa nome que não é nexo/*: a limpeza não apaga branch de pessoa", async () => {
    const r = repo();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: r, stdio: "pipe" });
    git("branch", "release");

    const feitos = await apagarBranchesNexo(r, ["release", "main", "../fuga"]);
    expect(feitos.every((f) => !f.ok)).toBe(true);
    expect(feitos.every((f) => f.saida === "não é branch do Nexo")).toBe(true);
    expect(execFileSync("git", ["branch", "--list", "release"], { cwd: r, encoding: "utf8" }).trim()).toContain(
      "release",
    );
  });
});
