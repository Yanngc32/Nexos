import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  commitarTrabalho,
  criarWorktree,
  nomeDoBranch,
  podeIsolar,
  removerWorktree,
  temMudanca,
} from "../src/worktree.ts";

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
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("original\n");
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
    expect(readFileSync(join(d1, "a.txt"), "utf8")).toBe("do primeiro\n");
    expect(readFileSync(join(d2, "a.txt"), "utf8")).toBe("do segundo\n");
    // e o projeto original fica intocado
    expect(readFileSync(join(r, "a.txt"), "utf8")).toBe("original\n");

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
    expect(conteudo).toBe("trabalho do agente");
  });

  it("remover árvore que já sumiu do disco não vira erro fatal", async () => {
    const r = repo();
    const out = await removerWorktree(r, join(r, "..", "nunca-existiu"));
    expect(out.ok).toBe(false);
    // o prune roda por dentro; o importante é não estourar
  });
});
