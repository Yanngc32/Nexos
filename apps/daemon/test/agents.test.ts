import { describe, it, expect } from "vitest";
import { agentOverrides, getAgent, listAgents, removeAgent, saveAgent } from "../src/agents.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

function homeComConta(): string {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  return home;
}

describe("agents", () => {
  it("cria, lê e lista", () => {
    const home = homeComConta();
    const def = saveAgent({ id: "rev", name: "Revisor", profileId: "p1", instructions: "seja seco" }, home);
    expect(def.id).toBe("rev");
    expect(def.createdAt).toBeTruthy();
    expect(getAgent("rev", home)?.instructions).toBe("seja seco");
    expect(listAgents(home).map((a) => a.id)).toEqual(["rev"]);
  });

  it("id ganha minúscula e recusa formato inválido", () => {
    const home = homeComConta();
    expect(saveAgent({ id: "REV", name: "R", profileId: "p1" }, home).id).toBe("rev");
    expect(() => saveAgent({ id: "com espaço", name: "R", profileId: "p1" }, home)).toThrow(/id inválido/);
    expect(() => saveAgent({ id: "-x", name: "R", profileId: "p1" }, home)).toThrow(/id inválido/);
  });

  it("recusa conta que não existe e campo inválido", () => {
    const home = homeComConta();
    expect(() => saveAgent({ id: "a", name: "A", profileId: "fantasma" }, home)).toThrow(/perfil não existe/);
    expect(() => saveAgent({ id: "a", name: "A", profileId: "p1", effort: "turbo" }, home)).toThrow(/esforço/);
    expect(() => saveAgent({ id: "a", name: "A", profileId: "p1", model: "rm -rf" }, home)).toThrow(/modelo/);
    expect(() => saveAgent({ id: "a", name: "A", profileId: "p1", color: "vermelho" }, home)).toThrow(/cor/);
  });

  it("atualização parcial preserva o que não veio e campo vazio apaga", () => {
    const home = homeComConta();
    saveAgent(
      { id: "a", name: "A", profileId: "p1", model: "opus", effort: "high", instructions: "x" },
      home,
    );
    const so_nome = saveAgent({ id: "a", name: "Aa" }, home);
    expect(so_nome.model).toBe("opus");
    expect(so_nome.effort).toBe("high");
    expect(so_nome.instructions).toBe("x");
    expect(so_nome.profileId).toBe("p1");
    const limpo = saveAgent({ id: "a", model: "", instructions: "" }, home);
    expect(limpo.model).toBeUndefined();
    expect(limpo.instructions).toBeUndefined();
    expect(limpo.effort).toBe("high");
    // createdAt é da criação; updatedAt anda a cada gravação
    expect(limpo.createdAt).toBe(so_nome.createdAt);
  });

  it("overrides saem só do que o agente define", () => {
    const home = homeComConta();
    saveAgent({ id: "a", name: "A", profileId: "p1", model: "sonnet", permissionMode: "plan" }, home);
    expect(agentOverrides("a", home)).toEqual({ model: "sonnet", permissionMode: "plan" });
    expect(agentOverrides("nao-existe", home)).toEqual({});
    expect(agentOverrides(undefined, home)).toEqual({});
  });

  it("remove e recusa remoção de inexistente", () => {
    const home = homeComConta();
    saveAgent({ id: "a", name: "A", profileId: "p1" }, home);
    removeAgent("a", home);
    expect(listAgents(home)).toEqual([]);
    expect(() => removeAgent("a", home)).toThrow(/não existe/);
  });
});
