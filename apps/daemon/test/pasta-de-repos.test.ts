import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { fecharLog, iniciarLog } from "../src/log.ts";
import {
  dirDoProjeto,
  projectDir,
  projetosRoot,
  resetProjetosDirForTest,
  resgatarDaPastaDeRepos,
} from "../src/projeto-dir.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  fecharLog();
  resetProjetosDirForTest();
});

/**
 * A máquina do Kerol: `projetosDir = C:\projects`, com o repo APROXIMA lá dentro, e o Nexos já
 * tendo gravado meta.json, conversas/ e repo-map/ dentro do repo.
 */
function pastaDeRepos(): { repos: string; repo: string } {
  const repos = mkdtempSync(join(tmpdir(), "nexo-repos-"));
  const repo = join(repos, "APROXIMA");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "conversas"), { recursive: true });
  mkdirSync(join(repo, "repo-map"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "codigo");
  writeFileSync(join(repo, "meta.json"), JSON.stringify({ projectPath: repo, slug: "aproxima", origem: "pasta" }));
  writeFileSync(join(repo, "conversas", "t1.jsonl"), '{"ts":"1"}\n');
  writeFileSync(join(repo, "repo-map", "indice.json"), "{}");
  return { repos, repo };
}

describe("projetosDir salvo que é pasta de repos", () => {
  it("é ignorado na subida: raiz padrão, aviso 1x, banner, dados da lista copiados, nada apagado", async () => {
    const home = tempHome();
    iniciarLog(home);
    const { repos, repo } = pastaDeRepos();
    saveConfig(home, { projetosDir: repos }); // config antiga: o PUT de hoje recusaria
    // já havia algo na raiz nova: não pode ser sobrescrito
    mkdirSync(join(home, "projetos", "aproxima", "repo-map"), { recursive: true });
    writeFileSync(join(home, "projetos", "aproxima", "repo-map", "indice.json"), "novo");

    expect(resgatarDaPastaDeRepos(home)).toBe(1);
    expect(projetosRoot(home)).toBe(join(home, "projetos"));
    expect(projetosRoot(home)).toBe(join(home, "projetos"));

    const novo = join(home, "projetos", "aproxima");
    expect(readFileSync(join(novo, "conversas", "t1.jsonl"), "utf8")).toContain('"ts"');
    expect(readFileSync(join(novo, "repo-map", "indice.json"), "utf8")).toBe("novo");
    expect(existsSync(join(novo, "meta.json"))).toBe(true);
    expect(existsSync(join(novo, "src"))).toBe(false);
    // nada sai do repo
    for (const f of ["meta.json", "conversas/t1.jsonl", "repo-map/indice.json", "src/app.ts"]) {
      expect(existsSync(join(repo, ...f.split("/"))), f).toBe(true);
    }
    // uma vez por pasta de origem
    expect(resgatarDaPastaDeRepos(home)).toBe(0);

    const log = readFileSync(join(home, "daemon.log"), "utf8");
    expect(log.split("\n").filter((l) => l.includes("ignorada: tem repositórios git"))).toHaveLength(1);
    expect(log).toContain("os originais ficaram onde estavam");
    expect(log).toContain(basename(repo));

    const token = "t".repeat(48);
    const res = await createApp(home, token).request("/v1/config", { headers: { authorization: `Bearer ${token}` } });
    expect(((await res.json()) as { projetosDirIgnorado?: string }).projetosDirIgnorado).toBe(repos);
  });

  it("projeto aberto a partir dessa pasta grava na raiz padrão, nunca no repo", () => {
    const home = tempHome();
    const { repos, repo } = pastaDeRepos();
    saveConfig(home, { projetosDir: repos });
    const dir = projectDir(join(repos, "outro-projeto"), home);
    expect(dir.startsWith(join(home, "projetos"))).toBe(true);
    expect(existsSync(join(repo, "outro-projeto"))).toBe(false);
  });
});

describe("trava do dirDoProjeto", () => {
  it("slug que bate no próprio projectPath (maiúsculas diferentes) vira slug-<hash>", () => {
    const home = tempHome();
    const raiz = mkdtempSync(join(tmpdir(), "nexo-raiz-"));
    const projeto = join(raiz, "MeuApp"); // sem .git: a raiz não conta como pasta de repos
    mkdirSync(projeto, { recursive: true });
    saveConfig(home, { projetosDir: raiz });
    const dir = dirDoProjeto(projeto, home, "pasta");
    expect(basename(dir)).toMatch(/^meuapp-[0-9a-f]{6}$/);
    expect(dir.toLowerCase()).not.toBe(projeto.toLowerCase());
    // estável: mesmo nome na próxima chamada (e em outra máquina com o mesmo slug)
    expect(dirDoProjeto(projeto, home, "pasta")).toBe(dir);
    const criado = projectDir(projeto, home);
    expect(criado).toBe(dir);
    expect(existsSync(join(projeto, "meta.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).slug).toBe(basename(dir));
  });

  it("sem colisão, o nome é o slug de sempre", () => {
    const home = tempHome();
    const raiz = mkdtempSync(join(tmpdir(), "nexo-raiz-"));
    saveConfig(home, { projetosDir: raiz });
    expect(basename(dirDoProjeto(join(tmpdir(), "longe", "MeuApp"), home, "pasta"))).toBe("meuapp");
  });
});

describe("lixo em ~/.nexos/drive", () => {
  it("acima de 50 MB fora da lista: um aviso com tamanho e pastas, nada apagado", async () => {
    const { avisarLixoNoDrive } = await import("../src/drive-sync.ts");
    const home = tempHome();
    iniciarLog(home);
    const p = join(home, "drive", "APROXIMA");
    mkdirSync(join(p, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(p, "conversas"), { recursive: true });
    writeFileSync(join(p, "meta.json"), "{}");
    writeFileSync(join(p, "conversas", "c.jsonl"), "x".repeat(1024));
    writeFileSync(join(p, "node_modules", "pkg", "grande.bin"), Buffer.alloc(51 * 1024 * 1024));
    writeFileSync(join(home, "drive", "___All_Errors.txt"), "erro");

    const r = await avisarLixoNoDrive(home);
    expect(r.bytes).toBeGreaterThan(50 * 1024 * 1024);
    expect(r.maiores[0]).toMatchObject({ pasta: "APROXIMA/node_modules" });
    const avisos = readFileSync(join(home, "daemon.log"), "utf8")
      .split("\n")
      .filter((l) => l.includes("fora do sync"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/AVISO \[drive\] 51 MB .*APROXIMA\/node_modules/);
    expect(existsSync(join(p, "node_modules", "pkg", "grande.bin"))).toBe(true);
    expect(existsSync(join(home, "drive", "___All_Errors.txt"))).toBe(true);
  });

  it("abaixo de 50 MB: silêncio", async () => {
    const { avisarLixoNoDrive } = await import("../src/drive-sync.ts");
    const home = tempHome();
    iniciarLog(home);
    mkdirSync(join(home, "drive", "x"), { recursive: true });
    writeFileSync(join(home, "drive", "x", "a.txt"), "a");
    await avisarLixoNoDrive(home);
    expect(existsSync(join(home, "daemon.log")) ? readFileSync(join(home, "daemon.log"), "utf8") : "").not.toContain("fora do sync");
  });
});
