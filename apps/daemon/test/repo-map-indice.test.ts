import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import {
  construirIndice,
  indiceDisponivel,
  lerIndice,
  listarArquivos,
  montarArvore,
  renderizarComTeto,
  statusDoIndice,
} from "../src/repo-map-indice.ts";

function tempProjeto(): string {
  return mkdtempSync(join(tmpdir(), "nexo-repomap-proj-"));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initGitComArquivos(dir: string, arquivos: string[]): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.com");
  git(dir, "config", "user.name", "t");
  for (const rel of arquivos) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "conteudo\n", "utf8");
  }
  git(dir, "add", "-A");
}

describe("montarArvore + renderizarComTeto", () => {
  it("projeto pequeno cabe inteiro, sem truncar", () => {
    const arvore = montarArvore(["README.md", "src/index.ts", "src/util.ts", "package.json"]);
    const { texto, truncado } = renderizarComTeto(arvore, 1200);
    expect(truncado).toBe(false);
    expect(texto.split("\n").sort()).toEqual(["README.md", "package.json", "src/index.ts", "src/util.ts"].sort());
  });

  it("árvore grande com teto apertado: raiz e pastas de 1º nível inteiras, 2º nível colapsa", () => {
    const caminhos = ["README.md"];
    for (let i = 0; i < 50; i++) caminhos.push(`src/vendor/pacote-${i}/arquivo.ts`);
    const arvore = montarArvore(caminhos);
    const { texto, truncado } = renderizarComTeto(arvore, 40); // teto minúsculo de propósito
    expect(truncado).toBe(true);
    // raiz sempre aparece
    expect(texto).toContain("README.md");
    // pasta de 1º nível (src) nunca vira "src/… (N arquivos)" — só o que está a partir do 2º nível colapsa
    expect(texto).not.toMatch(/^src\/… /m);
    // e o que colapsou é justamente o conteúdo de 2º nível (dentro de src/), não a raiz
    expect(texto).toMatch(/src\/vendor\/… \(\d+ arquivos\)/);
  });

  it("resumo que estoura o teto cai pro caminho puro — nunca mostra resumo cortado como se fosse atual", () => {
    const arvore = montarArvore(["a.ts"]);
    const resumoGigante = "x".repeat(500);
    const { texto } = renderizarComTeto(arvore, 20, () => resumoGigante);
    expect(texto).toBe("a.ts");
    expect(texto).not.toContain(resumoGigante);
  });

  it("resumo que cabe aparece ao lado do caminho", () => {
    const arvore = montarArvore(["a.ts"]);
    const { texto } = renderizarComTeto(arvore, 1200, (c) => (c === "a.ts" ? "cuida de autenticação" : undefined));
    expect(texto).toBe("a.ts — cuida de autenticação");
  });
});

describe("listarArquivos", () => {
  it("git ls-files filtra .gitignore corretamente", () => {
    const dir = tempProjeto();
    writeFileSync(join(dir, ".gitignore"), "ignorado.txt\n", "utf8");
    initGitComArquivos(dir, ["visivel.txt", "ignorado.txt"]);
    const arquivos = listarArquivos(dir);
    expect(arquivos).toContain("visivel.txt");
    expect(arquivos).not.toContain("ignorado.txt");
  });

  it("pasta sem .git devolve lista vazia, não lança", () => {
    const dir = tempProjeto();
    expect(listarArquivos(dir)).toEqual([]);
  });
});

describe("construirIndice / indiceDisponivel / lerIndice / statusDoIndice", () => {
  it("constrói, cacheia em disco e fica disponível pras próximas leituras", () => {
    const home = tempHome();
    const dir = tempProjeto();
    initGitComArquivos(dir, ["README.md", "src/a.ts", "src/b.ts"]);
    expect(indiceDisponivel(dir, home)).toBe(false);
    expect(lerIndice(dir, home)).toBe("");

    const { texto } = construirIndice(dir, home);
    expect(texto).toContain("README.md");
    expect(indiceDisponivel(dir, home)).toBe(true);
    expect(lerIndice(dir, home)).toBe(texto);

    const status = statusDoIndice(dir, home);
    expect(status.existe).toBe(true);
    expect(status.arquivos).toBe(3);
  });

  it("statusDoIndice sem índice construído não cria nada em disco", () => {
    const home = tempHome();
    const dir = tempProjeto();
    initGitComArquivos(dir, ["a.ts"]);
    const status = statusDoIndice(dir, home);
    expect(status.existe).toBe(false);
  });
});
