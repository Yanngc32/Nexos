import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { construirIndice } from "../src/repo-map-indice.ts";
import { ferramentasDeRepoMap } from "../src/repo-map-simbolos.ts";

function tempProjeto(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-repomap-simb-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "login.ts"), "export function login(user, pass) {}\n", "utf8");
  writeFileSync(join(dir, "src", "util.rb"), "def helper; end\n", "utf8");
  return dir;
}

describe("ferramentasDeRepoMap", () => {
  it("vazio quando o projeto ainda não tem índice construído", () => {
    const home = tempHome();
    const dir = tempProjeto();
    expect(ferramentasDeRepoMap(dir, home)()).toEqual([]);
  });

  it("caminho de arquivo devolve os símbolos daquele arquivo", async () => {
    const home = tempHome();
    const dir = tempProjeto();
    construirIndice(dir, home);
    const [ferramenta] = ferramentasDeRepoMap(dir, home)();
    const r = await ferramenta!.executar({ caminho: "src/login.ts" });
    expect(r.ok).toBe(true);
    expect(r.texto).toBe("src/login.ts: function login(user, pass)");
  });

  it("caminho de pasta devolve uma linha por arquivo dentro dela", async () => {
    const home = tempHome();
    const dir = tempProjeto();
    construirIndice(dir, home);
    const [ferramenta] = ferramentasDeRepoMap(dir, home)();
    const r = await ferramenta!.executar({ caminho: "src" });
    expect(r.ok).toBe(true);
    expect(r.texto).toContain("src/login.ts: function login(user, pass)");
    expect(r.texto).toContain("src/util.rb: (sem parser para esta linguagem)");
  });

  it("caminho inexistente é erro de ferramenta (ok:false), não derruba o processo", async () => {
    const home = tempHome();
    const dir = tempProjeto();
    construirIndice(dir, home);
    const [ferramenta] = ferramentasDeRepoMap(dir, home)();
    const r = await ferramenta!.executar({ caminho: "nao/existe.ts" });
    expect(r).toEqual({ ok: false, texto: "caminho não existe: nao/existe.ts" });
  });

  it("caminho fora do projeto (../) é recusado", async () => {
    const home = tempHome();
    const dir = tempProjeto();
    construirIndice(dir, home);
    const [ferramenta] = ferramentasDeRepoMap(dir, home)();
    await expect(ferramenta!.executar({ caminho: "../../etc/passwd" })).rejects.toThrow(/escapa/);
  });

  it("linguagem sem gramática devolve aviso explícito, não lista vazia sem contexto", async () => {
    const home = tempHome();
    const dir = tempProjeto();
    construirIndice(dir, home);
    const [ferramenta] = ferramentasDeRepoMap(dir, home)();
    const r = await ferramenta!.executar({ caminho: "src/util.rb" });
    expect(r.texto).toBe("src/util.rb: (sem parser para esta linguagem)");
  });
});
