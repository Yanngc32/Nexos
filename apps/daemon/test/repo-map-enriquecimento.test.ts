import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { arquivosParaResumir, ferramentaDeResumo, gravarResumo, leitorDeResumos, resumoDe } from "../src/repo-map-enriquecimento.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function tempProjetoGit(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-repomap-enr-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "conteudo original\n", "utf8");
  writeFileSync(join(dir, "b.ts"), "outro conteudo\n", "utf8");
  git(dir, "add", "-A");
  return dir;
}

describe("resumoDe / gravarResumo", () => {
  it("sem resumo cacheado devolve undefined", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    expect(resumoDe(dir, home, "a.ts", "conteudo original\n")).toBeUndefined();
  });

  it("resumo cacheado bate quando o conteúdo é o mesmo", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    gravarResumo(dir, home, "a.ts", "conteudo original\n", "cuida de autenticação");
    expect(resumoDe(dir, home, "a.ts", "conteudo original\n")).toBe("cuida de autenticação");
  });

  it("arquivo mudado invalida SÓ o cache dele, não o dos outros", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    gravarResumo(dir, home, "a.ts", "conteudo original\n", "resumo de a");
    gravarResumo(dir, home, "b.ts", "outro conteudo\n", "resumo de b");
    expect(resumoDe(dir, home, "a.ts", "conteudo MUDOU\n")).toBeUndefined();
    expect(resumoDe(dir, home, "b.ts", "outro conteudo\n")).toBe("resumo de b");
  });
});

describe("leitorDeResumos", () => {
  it("lê do disco e respeita o mesmo critério de hash de resumoDe", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    gravarResumo(dir, home, "a.ts", "conteudo original\n", "resumo de a");
    const ler = leitorDeResumos(dir, home);
    expect(ler("a.ts")).toBe("resumo de a");
    expect(ler("b.ts")).toBeUndefined();
  });
});

describe("arquivosParaResumir", () => {
  it("sem nenhum resumo cacheado, todos os arquivos do repo entram", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    expect(arquivosParaResumir(dir, home).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("depois de resumir tudo, 'gerar resumos' de novo não repete o que já bate hash", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    gravarResumo(dir, home, "a.ts", "conteudo original\n", "resumo de a");
    gravarResumo(dir, home, "b.ts", "outro conteudo\n", "resumo de b");
    expect(arquivosParaResumir(dir, home)).toEqual([]);
  });

  it("só o arquivo tocado pelo commit (conteúdo mudou) volta pra lista", () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    gravarResumo(dir, home, "a.ts", "conteudo original\n", "resumo de a");
    gravarResumo(dir, home, "b.ts", "outro conteudo\n", "resumo de b");
    writeFileSync(join(dir, "a.ts"), "conteudo original MODIFICADO\n", "utf8");
    expect(arquivosParaResumir(dir, home)).toEqual(["a.ts"]);
  });
});

describe("ferramentaDeResumo (nexo_repomap_resumo_salvar)", () => {
  it("grava o resumo com o hash do conteúdo atual do arquivo", async () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    const [ferramenta] = ferramentaDeResumo(dir, home)();
    const r = await ferramenta!.executar({ caminho: "a.ts", resumo: "cuida de X" });
    expect(r).toEqual({ ok: true, texto: "resumo salvo: a.ts" });
    expect(resumoDe(dir, home, "a.ts", "conteudo original\n")).toBe("cuida de X");
  });

  it("recusa sem caminho/resumo, sem gravar nada", async () => {
    const home = tempHome();
    const dir = tempProjetoGit();
    const [ferramenta] = ferramentaDeResumo(dir, home)();
    expect(await ferramenta!.executar({ resumo: "x" })).toEqual({ ok: false, texto: 'faltou "caminho"' });
    expect(await ferramenta!.executar({ caminho: "a.ts" })).toEqual({ ok: false, texto: 'faltou "resumo"' });
  });
});
