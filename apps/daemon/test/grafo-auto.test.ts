import { describe, expect, it } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { getAgent, saveAgent } from "../src/agents.ts";
import { apagarRegra, listarRegras, resetHooksForTest, saveRegra } from "../src/hooks.ts";
import { desligarGrafoAutomatico, sincronizarGrafoAutomatico } from "../src/grafo-auto.ts";
import { saveConfig } from "../src/config.ts";
import { resetRunsForTest } from "../src/runs.ts";
import { tempHome } from "./helpers.ts";

function base(): string {
  resetRunsForTest();
  resetHooksForTest();
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  return home;
}

describe("sincronizarGrafoAutomatico", () => {
  it("módulo desligado: no-op, não cria agente nem regra", () => {
    const home = base();
    const r = sincronizarGrafoAutomatico(home);
    expect(r.ok).toBe(true);
    expect(getAgent("grafo", home)).toBeUndefined();
    expect(listarRegras(home)).toEqual([]);
  });

  it("ligado sem conta configurada: reprova com motivo, não cria nada", () => {
    const home = base();
    saveConfig(home, { modulos: { rtk: false, caveman: false, cavemanNivel: "full", grafoAuto: true, grafoAutoProfileId: "" } });
    const r = sincronizarGrafoAutomatico(home);
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/conta configurada não existe/);
    expect(getAgent("grafo", home)).toBeUndefined();
  });

  it("ligado com conta inexistente: reprova", () => {
    const home = base();
    saveConfig(home, {
      modulos: { rtk: false, caveman: false, cavemanNivel: "full", grafoAuto: true, grafoAutoProfileId: "fantasma" },
    });
    expect(sincronizarGrafoAutomatico(home).ok).toBe(false);
  });

  it("ligado com conta válida: cria o agente 'grafo' e as duas regras globais", () => {
    const home = base();
    saveConfig(home, {
      modulos: { rtk: false, caveman: false, cavemanNivel: "full", grafoAuto: true, grafoAutoProfileId: "p1" },
    });
    const r = sincronizarGrafoAutomatico(home);
    expect(r.ok).toBe(true);
    expect(getAgent("grafo", home)?.profileId).toBe("p1");
    const regras = listarRegras(home);
    expect(regras.map((x) => x.evento).sort()).toEqual(["git.post-commit", "nexo.projeto-novo"]);
    expect(regras.every((x) => x.agentId === "grafo" && x.escopo.tipo === "global")).toBe(true);
  });

  it("idempotente: rodar duas vezes não duplica regra", () => {
    const home = base();
    saveConfig(home, {
      modulos: { rtk: false, caveman: false, cavemanNivel: "full", grafoAuto: true, grafoAutoProfileId: "p1" },
    });
    sincronizarGrafoAutomatico(home);
    sincronizarGrafoAutomatico(home);
    expect(listarRegras(home)).toHaveLength(2);
  });

  it("recria só a regra que a pessoa apagou à mão, não as duas", () => {
    const home = base();
    saveConfig(home, {
      modulos: { rtk: false, caveman: false, cavemanNivel: "full", grafoAuto: true, grafoAutoProfileId: "p1" },
    });
    sincronizarGrafoAutomatico(home);
    const antes = listarRegras(home);
    apagarRegra(antes.find((r) => r.evento === "git.post-commit")!.id, home);
    sincronizarGrafoAutomatico(home);
    const depois = listarRegras(home);
    expect(depois.map((x) => x.evento).sort()).toEqual(["git.post-commit", "nexo.projeto-novo"]);
    expect(depois.find((r) => r.evento === "nexo.projeto-novo")?.id).toBe(
      antes.find((r) => r.evento === "nexo.projeto-novo")?.id,
    );
  });
});

describe("desligarGrafoAutomatico", () => {
  it("apaga as duas regras gerenciadas, mas deixa o agente", () => {
    const home = base();
    saveConfig(home, {
      modulos: { rtk: false, caveman: false, cavemanNivel: "full", grafoAuto: true, grafoAutoProfileId: "p1" },
    });
    sincronizarGrafoAutomatico(home);
    desligarGrafoAutomatico(home);
    expect(listarRegras(home)).toEqual([]);
    expect(getAgent("grafo", home)).toBeTruthy();
  });

  it("não mexe numa regra alheia com agentId 'grafo' de outro evento", () => {
    const home = base();
    saveAgent({ id: "grafo", name: "Grafo custom", profileId: "p1" }, home);
    const alheia = saveRegra({ escopo: { tipo: "global" }, evento: "git.post-push", agentId: "grafo" }, home);
    desligarGrafoAutomatico(home);
    expect(listarRegras(home).some((r) => r.id === alheia.id)).toBe(true);
  });
});
