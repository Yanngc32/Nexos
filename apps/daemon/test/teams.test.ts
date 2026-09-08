import { describe, it, expect } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { saveAgent } from "../src/agents.ts";
import { getTeam, listTeams, removeTeam, saveTeam, upsertTimeDeMencao } from "../src/teams.ts";
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
      saveTeam({ id: "t", name: "T", topology: "democracia", members: [{ agentId: "escritor" }] }, home),
    ).toThrow(/topologia inválida/);
  });

  it("supervisor sozinho é recusado: ele não trabalha, chama", () => {
    const home = base();
    expect(() =>
      saveTeam({ id: "t", name: "T", topology: "supervisor", members: [{ agentId: "escritor" }] }, home),
    ).toThrow(/pelo menos um membro além dele/);
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

describe("upsertTimeDeMencao", () => {
  it("cria um time-pipeline-de-1 oculto pro agente citado", () => {
    const home = base();
    const t = upsertTimeDeMencao("revisor", home);
    expect(t.topology).toBe("pipeline");
    expect(t.members).toEqual([{ agentId: "revisor" }]);
    expect(t.origem).toBe("mencao");
    // getTeam (o que o motor de Run usa) enxerga mesmo sendo oculto
    expect(getTeam(t.id, home)).toEqual(t);
  });

  it("some da listagem que a tela de Times usa, mesmo depois de criado", () => {
    const home = base();
    upsertTimeDeMencao("revisor", home);
    expect(listTeams(home)).toEqual([]);
  });

  it("é idempotente: citar de novo atualiza o mesmo registro, não duplica", () => {
    const home = base();
    const primeiro = upsertTimeDeMencao("revisor", home);
    const segundo = upsertTimeDeMencao("revisor", home);
    expect(segundo.id).toBe(primeiro.id);
    expect(segundo.createdAt).toBe(primeiro.createdAt);
  });

  it("time de verdade com o mesmo id que um time oculto teria não é sobrescrito por engano", () => {
    // não é o caso coberto aqui (ids vêm com prefixo mencao-), só confirma que
    // citar um agente não mexe em time nenhum que a pessoa criou
    const home = base();
    saveTeam({ id: "feature", name: "Time de feature", members: [{ agentId: "escritor" }] }, home);
    upsertTimeDeMencao("revisor", home);
    expect(listTeams(home)).toHaveLength(1);
    expect(listTeams(home)[0]?.id).toBe("feature");
  });

  it("recusa agente que não existe", () => {
    const home = base();
    expect(() => upsertTimeDeMencao("fantasma", home)).toThrow(/agente não existe/);
  });
});
