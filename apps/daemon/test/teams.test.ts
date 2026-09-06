import { describe, it, expect } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { saveAgent } from "../src/agents.ts";
import { getTeam, listTeams, removeTeam, saveTeam } from "../src/teams.ts";
import { tempHome } from "./helpers.ts";

function base(): string {
  const home = tempHome();
  addProfile({ id: "p1", engine: "stub" }, home);
  saveAgent({ id: "escritor", name: "Escritor", profileId: "p1" }, home);
  saveAgent({ id: "revisor", name: "Revisor", profileId: "p1" }, home);
  return home;
}

describe("times", () => {
  it("cria com membros na ordem e devolve o que gravou", () => {
    const home = base();
    const t = saveTeam(
      {
        id: "feature",
        name: "Time de feature",
        members: [{ agentId: "escritor", papel: "escreve" }, { agentId: "revisor" }],
      },
      home,
    );
    expect(t.topology).toBe("pipeline");
    expect(t.members).toEqual([{ agentId: "escritor", papel: "escreve" }, { agentId: "revisor" }]);
    expect(getTeam("feature", home)?.name).toBe("Time de feature");
  });

  it("a ordem dos membros é a semântica do pipeline: não é reordenada", () => {
    const home = base();
    const t = saveTeam(
      { id: "t", name: "T", members: [{ agentId: "revisor" }, { agentId: "escritor" }] },
      home,
    );
    expect(t.members.map((m) => m.agentId)).toEqual(["revisor", "escritor"]);
  });

  it("mesmo agente pode aparecer duas vezes, com papéis diferentes", () => {
    const home = base();
    const t = saveTeam(
      {
        id: "t",
        name: "T",
        members: [
          { agentId: "escritor", papel: "rascunho" },
          { agentId: "revisor", papel: "crítica" },
          { agentId: "escritor", papel: "versão final" },
        ],
      },
      home,
    );
    expect(t.members).toHaveLength(3);
    expect(t.members[2]?.papel).toBe("versão final");
  });

  it("recusa membro apontando pra agente que não existe", () => {
    const home = base();
    expect(() => saveTeam({ id: "t", name: "T", members: [{ agentId: "fantasma" }] }, home)).toThrow(
      /agente não existe/,
    );
  });

  it("recusa time sem membro", () => {
    const home = base();
    expect(() => saveTeam({ id: "t", name: "T", members: [] }, home)).toThrow(/pelo menos um membro/);
  });

  it("recusa topologia que não existe", () => {
    const home = base();
    expect(() =>
      saveTeam({ id: "t", name: "T", topology: "supervisor", members: [{ agentId: "escritor" }] }, home),
    ).toThrow(/topologia inválida/);
  });

  it("recusa id fora do formato e nome vazio", () => {
    const home = base();
    expect(() => saveTeam({ id: "Com Espaço", name: "T", members: [{ agentId: "escritor" }] }, home)).toThrow(
      /id inválido/,
    );
    expect(() => saveTeam({ id: "t", name: "", members: [{ agentId: "escritor" }] }, home)).toThrow(
      /nome obrigatório/,
    );
  });

  it("atualizar mantém createdAt e troca updatedAt", async () => {
    const home = base();
    const antes = saveTeam({ id: "t", name: "T", members: [{ agentId: "escritor" }] }, home);
    await new Promise((r) => setTimeout(r, 5));
    const depois = saveTeam({ id: "t", name: "T2" }, home);
    expect(depois.createdAt).toBe(antes.createdAt);
    expect(depois.updatedAt).not.toBe(antes.updatedAt);
    // não mandar membros mantém os que já estavam
    expect(depois.members).toEqual(antes.members);
  });

  it("remover some da lista; remover de novo é 404", () => {
    const home = base();
    saveTeam({ id: "t", name: "T", members: [{ agentId: "escritor" }] }, home);
    removeTeam("t", home);
    expect(listTeams(home)).toHaveLength(0);
    expect(() => removeTeam("t", home)).toThrow(/não existe/);
  });

  it("arquivo corrompido devolve lista vazia em vez de derrubar", async () => {
    const home = base();
    saveTeam({ id: "t", name: "T", members: [{ agentId: "escritor" }] }, home);
    const { writeFileSync } = await import("node:fs");
    const { teamsPath } = await import("../src/home.ts");
    writeFileSync(teamsPath(home), "{ não é json", "utf8");
    expect(listTeams(home)).toEqual([]);
  });
});
