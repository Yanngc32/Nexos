import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, listAgents, removeAgent, saveAgent } from "../src/agents.ts";
import { PASTA_BIBLIOTECA, sincronizarBiblioteca } from "../src/biblioteca.ts";
import { saveConfig } from "../src/config.ts";
import { agentsPath, globalSkillsDir } from "../src/home.ts";
import { listarRegras, saveRegra } from "../src/hooks.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

/** Dois PCs = dois homes com `projetosDir` na MESMA pasta (o que o Drive/Drive Desktop faz de verdade). */
let raiz: string;
let pcA: string;
let pcB: string;
let compartilhada: string;

beforeEach(() => {
  raiz = tempHome();
  compartilhada = join(raiz, "drive");
  pcA = join(raiz, "pcA");
  pcB = join(raiz, "pcB");
  for (const h of [pcA, pcB]) {
    mkdirSync(h, { recursive: true });
    saveConfig(h, { projetosDir: compartilhada });
  }
  addProfile({ id: "p1", engine: "stub" }, pcA);
  addProfile({ id: "p1", engine: "stub" }, pcB);
});

afterEach(() => {
  rmSync(raiz, { recursive: true, force: true });
});

const espelho = (...p: string[]) => join(compartilhada, PASTA_BIBLIOTECA, ...p);
const sync = (h: string) => {
  const r = sincronizarBiblioteca(h);
  expect(r.erros).toEqual([]);
  return r;
};

describe("sincronizarBiblioteca", () => {
  it("agente criado num PC aparece no outro", () => {
    saveAgent({ id: "memoria", name: "Memória", profileId: "p1" }, pcA);
    expect(sync(pcA).exportados).toBe(1);
    expect(existsSync(espelho("agentes", "memoria.json"))).toBe(true);
    expect(sync(pcB).importados).toBe(1);
    expect(getAgent("memoria", pcB)?.name).toBe("Memória");
  });

  it("apagar num PC apaga no outro", () => {
    saveAgent({ id: "memoria", name: "Memória", profileId: "p1" }, pcA);
    saveAgent({ id: "outro", name: "Outro", profileId: "p1" }, pcA);
    sync(pcA);
    sync(pcB);
    removeAgent("memoria", pcA);
    expect(sync(pcA).apagadosNoEspelho).toBe(1);
    expect(sync(pcB).apagadosAqui).toBe(1);
    expect(listAgents(pcB).map((a) => a.id)).toEqual(["outro"]);
  });

  it("dois PCs criando coisas diferentes: nenhum perde nada", () => {
    saveAgent({ id: "a", name: "A", profileId: "p1" }, pcA);
    saveAgent({ id: "b", name: "B", profileId: "p1" }, pcB);
    sync(pcA);
    sync(pcB);
    sync(pcA);
    expect(listAgents(pcA).map((a) => a.id)).toEqual(["a", "b"]);
    expect(listAgents(pcB).map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("edição num PC chega no outro", () => {
    saveAgent({ id: "a", name: "A", profileId: "p1" }, pcA);
    sync(pcA);
    sync(pcB);
    saveAgent({ id: "a", name: "A editado" }, pcA);
    sync(pcA);
    sync(pcB);
    expect(getAgent("a", pcB)?.name).toBe("A editado");
  });

  it("conta que não existe aqui vira a primeira pronta, sem mudar a dos outros PCs", () => {
    addProfile({ id: "trabalho", engine: "stub" }, pcA);
    saveAgent({ id: "a", name: "A", profileId: "trabalho" }, pcA);
    sync(pcA);
    sync(pcB);
    expect(getAgent("a", pcB)?.profileId).toBe("p1");
    // a troca local não pode parecer edição: nada sobe, e o espelho segue com a conta de lá
    expect(sync(pcB).exportados).toBe(0);
    expect(JSON.parse(readFileSync(espelho("agentes", "a.json"), "utf8")).profileId).toBe("trabalho");
  });

  it("hook de projeto chega com o caminho do mesmo projeto nesta máquina", () => {
    const projA = join(raiz, "discoA", "meuproj");
    const projB = join(raiz, "discoB", "meuproj");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    saveConfig(pcA, { repos: [projA] });
    saveConfig(pcB, { repos: [projB] });
    saveAgent({ id: "memoria", name: "Memória", profileId: "p1" }, pcA);
    saveRegra({ escopo: { tipo: "projeto", projectPath: projA }, evento: "git.post-commit", agentId: "memoria" }, pcA);
    sync(pcA);
    sync(pcB);
    const [regra] = listarRegras(pcB);
    expect(regra.escopo).toEqual({ tipo: "projeto", projectPath: projB });
    expect(sync(pcB).exportados).toBe(0);
  });

  it("skill global vai e volta, e apagar propaga", () => {
    const dir = join(globalSkillsDir(pcA), "minha");
    mkdirSync(join(dir, "refs"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: minha\n---\ncorpo", "utf8");
    writeFileSync(join(dir, "refs", "extra.md"), "extra", "utf8");
    sync(pcA);
    sync(pcB);
    expect(readFileSync(join(globalSkillsDir(pcB), "minha", "refs", "extra.md"), "utf8")).toBe("extra");
    rmSync(dir, { recursive: true });
    sync(pcA);
    sync(pcB);
    expect(existsSync(join(globalSkillsDir(pcB), "minha"))).toBe(false);
  });

  it("agents.json ilegível não vira 'apaguei tudo' no espelho", () => {
    saveAgent({ id: "a", name: "A", profileId: "p1" }, pcA);
    sync(pcA);
    writeFileSync(agentsPath(pcA), "{ quebrado", "utf8");
    const r = sincronizarBiblioteca(pcA);
    expect(r.erros.some((e) => e.startsWith("agentes:"))).toBe(true);
    expect(existsSync(espelho("agentes", "a.json"))).toBe(true);
  });

  it("apagar o último agente também propaga", () => {
    saveAgent({ id: "a", name: "A", profileId: "p1" }, pcA);
    sync(pcA);
    sync(pcB);
    removeAgent("a", pcA);
    sync(pcA);
    sync(pcB);
    expect(listAgents(pcB)).toEqual([]);
    sync(pcA);
    expect(listAgents(pcA)).toEqual([]);
  });

  it("espelho sumido (pasta desmontada) só junta de novo, não apaga nada aqui", () => {
    saveAgent({ id: "a", name: "A", profileId: "p1" }, pcA);
    sync(pcA);
    rmSync(join(compartilhada, PASTA_BIBLIOTECA), { recursive: true });
    expect(sync(pcA).apagadosAqui).toBe(0);
    expect(getAgent("a", pcA)).toBeDefined();
    expect(existsSync(espelho("agentes", "a.json"))).toBe(true);
  });
});
