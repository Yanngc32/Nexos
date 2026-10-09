import { describe, it, expect } from "vitest";
import { SUBAGENTES_MAX } from "@nexos/shared";
import { agentOverrides, definicoesDeSubagentes, getAgent, listAgents, removeAgent, saveAgent, subagentesDaConversa } from "../src/agents.ts";
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

describe("agente como subagente das conversas", () => {
  it("ligar exige descrição", () => {
    const home = homeComConta();
    expect(() => saveAgent({ id: "rev", name: "Revisor", profileId: "p1", subagente: true }, home)).toThrow(/descrição/);
    const ok = saveAgent({ id: "rev", name: "Revisor", profileId: "p1", description: "revisa diff", subagente: true }, home);
    expect(ok.subagente).toBe(true);
    // apagar a descrição com ele ligado também é recusado
    expect(() => saveAgent({ id: "rev", description: "" }, home)).toThrow(/descrição/);
  });

  it(`teto de ${SUBAGENTES_MAX} ligados; desligar libera a vaga`, () => {
    const home = homeComConta();
    for (let i = 0; i < SUBAGENTES_MAX; i++) {
      saveAgent({ id: `a${i}`, name: `A${i}`, profileId: "p1", description: "d", subagente: true }, home);
    }
    expect(() => saveAgent({ id: "extra", name: "X", profileId: "p1", description: "d", subagente: true }, home)).toThrow(/já há/);
    // regravar um que já está ligado não conta contra ele mesmo
    expect(saveAgent({ id: "a0", name: "A0 novo" }, home).subagente).toBe(true);
    expect(saveAgent({ id: "a0", subagente: false }, home).subagente).toBeUndefined();
    expect(saveAgent({ id: "extra", name: "X", profileId: "p1", description: "d", subagente: true }, home).subagente).toBe(true);
  });

  it("escopo por projeto: casa pasta com barra/caixa diferente; vazio = toda conversa", () => {
    const home = homeComConta();
    saveAgent({ id: "geral", name: "G", profileId: "p1", description: "d", subagente: true }, home);
    saveAgent(
      { id: "front", name: "F", profileId: "p1", description: "d", subagente: true, projetos: ["C:\\Repos\\Site\\"] },
      home,
    );
    saveAgent({ id: "desligado", name: "D", profileId: "p1", description: "d" }, home);
    expect(subagentesDaConversa(home, "c:/repos/site").map((a) => a.id)).toEqual(["front", "geral"]);
    expect(subagentesDaConversa(home, "C:\\Repos\\Outro").map((a) => a.id)).toEqual(["geral"]);
    // conversa global (sem projeto) não pega agente com escopo
    expect(subagentesDaConversa(home, undefined).map((a) => a.id)).toEqual(["geral"]);
    // a conversa do próprio agente não recebe ele mesmo
    expect(subagentesDaConversa(home, "c:/repos/site", "front").map((a) => a.id)).toEqual(["geral"]);
    // `null` limpa o escopo
    expect(saveAgent({ id: "front", projetos: null }, home).projetos).toBeUndefined();
  });

  it("definição do --agents: instruções viram prompt e só modelo do Claude passa", () => {
    const home = homeComConta();
    saveAgent({ id: "a", name: "A", profileId: "p1", description: "quando X", instructions: "faça Y", model: "sonnet", subagente: true }, home);
    saveAgent({ id: "b", name: "B", profileId: "p1", description: "quando Z", model: "gpt-5.1", subagente: true }, home);
    const defs = definicoesDeSubagentes(subagentesDaConversa(home, undefined));
    expect(defs.a).toEqual({ description: "quando X", prompt: "faça Y", model: "sonnet" });
    expect(defs.b).toEqual({ description: "quando Z", prompt: "Você é B. quando Z" });
  });
});
