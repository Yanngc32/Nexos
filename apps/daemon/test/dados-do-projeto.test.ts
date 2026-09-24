import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { googleAuthPath } from "../src/home.ts";
import { projetosRoot, trazerPastaManualProDrive } from "../src/projeto-dir.ts";
import { DADOS_DO_PROJETO, PREFIXO_ICONE_MANUAL, dadoDoProjeto, sincronizavel } from "../src/sync-decisao.ts";
import { tempHome } from "./helpers.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Quem grava na pasta de um projeto e o QUÊ grava. Arquivo novo que passe a chamar
 * `projectDir(`/`projectDirSemCriar(` quebra o teste até entrar aqui — e o que ele grava tem que
 * entrar em `DADOS_DO_PROJETO`, senão o sync ignora esse dado sem avisar ninguém.
 */
const QUEM_GRAVA: Record<string, string[]> = {
  "memoria.ts": ['"memoria"'],
  "tarefas.ts": ['"tarefas"'],
  "repo-map-indice.ts": ['"repo-map"'],
  "threads.ts": ['"conversas"'],
  "planejamento.ts": ['"planejamento"'],
  "design-system.ts": ['"design-system.json"', '"design-system"'],
  "project-logo.ts": ['MANUAL = "icone-manual"'],
};

describe("dados do projeto: uma fonte só", () => {
  it("todo arquivo que grava na pasta do projeto está mapeado, e o que ele grava está na lista", () => {
    const usam = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && f !== "projeto-dir.ts")
      .filter((f) => /\bprojectDir(SemCriar)?\(/.test(readFileSync(join(SRC, f), "utf8")));
    expect(usam.sort()).toEqual(Object.keys(QUEM_GRAVA).sort());
    for (const [arquivo, literais] of Object.entries(QUEM_GRAVA)) {
      const fonte = readFileSync(join(SRC, arquivo), "utf8");
      for (const l of literais) expect(fonte, `${arquivo} não grava mais ${l}?`).toContain(l);
    }
    const nomes = Object.values(QUEM_GRAVA)
      .flat()
      .map((l) => /"([^"]+)"/.exec(l)![1]!);
    for (const n of nomes) {
      expect(n === "icone-manual" ? `${n}.` === PREFIXO_ICONE_MANUAL : DADOS_DO_PROJETO.includes(n), n).toBe(true);
    }
    // e nada sobrando na lista que ninguém grava
    for (const d of DADOS_DO_PROJETO) expect(nomes, d).toContain(d);
  });

  it("dentro de pasta que é repo, só pasta com nome de dado conta", () => {
    for (const n of ["memoria", "conversas", "design-system.json", "icone-manual.png"]) expect(dadoDoProjeto(n)).toBe(true);
    for (const n of ["node_modules", "src", "meta.json", ".git", "package.json"]) expect(dadoDoProjeto(n)).toBe(false);
    expect(sincronizavel("_biblioteca/agentes/a.json")).toBe(true);
    expect(sincronizavel("proj/memoria/M.md")).toBe(true);
    expect(sincronizavel("proj/meta.json")).toBe(false);
    expect(sincronizavel("solto.txt")).toBe(false);
    expect(sincronizavel("proj/node_modules/x/i.js")).toBe(false);
  });
});

describe("cópia da pasta manual: dentro da pasta do Nexos, só a lista", () => {
  it("projeto que é repo traz só dados + meta.json", async () => {
    const home = tempHome();
    const manual = mkdtempSync(join(tmpdir(), "nexo-manual-"));
    const p = join(manual, "APROXIMA");
    mkdirSync(join(p, "conversas"), { recursive: true });
    mkdirSync(join(p, "aprxm_sys"), { recursive: true });
    writeFileSync(join(p, "meta.json"), "{}");
    writeFileSync(join(p, "conversas", "c.jsonl"), "{}");
    writeFileSync(join(p, "aprxm_sys", "x.py"), "codigo");
    writeFileSync(join(p, "publicar_v101.log"), "lixo");
    writeFileSync(join(p, "icone-manual.png"), "png");
    saveConfig(home, { projetosDir: manual });
    writeFileSync(googleAuthPath(home), JSON.stringify({ refreshToken: "rt", email: "a@b" }));
    const destino = projetosRoot(home);

    expect(await trazerPastaManualProDrive(home, destino)).toBe(3);
    expect(existsSync(join(destino, "APROXIMA", "meta.json"))).toBe(true);
    expect(existsSync(join(destino, "APROXIMA", "conversas", "c.jsonl"))).toBe(true);
    expect(existsSync(join(destino, "APROXIMA", "icone-manual.png"))).toBe(true);
    expect(existsSync(join(destino, "APROXIMA", "aprxm_sys"))).toBe(false);
    expect(existsSync(join(destino, "APROXIMA", "publicar_v101.log"))).toBe(false);
  });
});
