import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitsRelacionados } from "../src/tarefas-git.ts";

function tempProjeto(): string {
  return mkdtempSync(join(tmpdir(), "nexo-tarefas-git-"));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initGit(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
}

function commit(dir: string, arquivo: string, mensagem: string): void {
  writeFileSync(join(dir, arquivo), `${Date.now()}-${Math.random()}`, "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", mensagem);
}

describe("commitsRelacionados", () => {
  it("acha commit cuja mensagem menciona o id da tarefa", () => {
    const dir = tempProjeto();
    initGit(dir);
    commit(dir, "a.txt", "sem relação nenhuma");
    commit(dir, "b.txt", "corrige bug da tk-abc123 no login");
    const r = commitsRelacionados(dir, "tk-abc123");
    expect(r).toHaveLength(1);
    expect(r[0]!.mensagem).toContain("tk-abc123");
    expect(r[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sem nenhuma menção, devolve vazio", () => {
    const dir = tempProjeto();
    initGit(dir);
    commit(dir, "a.txt", "trabalho normal");
    expect(commitsRelacionados(dir, "tk-nada")).toEqual([]);
  });

  it("projeto sem .git não lança, devolve vazio", () => {
    const dir = tempProjeto();
    expect(commitsRelacionados(dir, "tk-qualquer")).toEqual([]);
  });

  it("acha em qualquer branch (--all), não só no atual", () => {
    const dir = tempProjeto();
    initGit(dir);
    commit(dir, "a.txt", "commit inicial");
    git(dir, "checkout", "-q", "-b", "outra-branch");
    commit(dir, "b.txt", "trabalho da tk-xyz789 nessa branch");
    git(dir, "checkout", "-q", "-");
    const r = commitsRelacionados(dir, "tk-xyz789");
    expect(r).toHaveLength(1);
  });
});
