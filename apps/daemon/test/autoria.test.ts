import { describe, expect, it } from "vitest";
import { ferramentasDeAutoria } from "../src/autoria.ts";
import { tratarMcp } from "../src/mcp.ts";
import { addProfile } from "../src/profiles.ts";
import { listAgents, saveAgent } from "../src/agents.ts";
import { listTeams } from "../src/teams.ts";
import { tempHome } from "./helpers.ts";

type Conteudo = { content: { text: string }[]; isError?: boolean };

function casa(): string {
  const home = tempHome();
  addProfile({ id: "conta-a", engine: "stub" }, home, { skipBinCheck: true });
  addProfile({ id: "conta-b", engine: "stub" }, home, { skipBinCheck: true });
  return home;
}

async function chamar(home: string, name: string, args: unknown = {}): Promise<Conteudo> {
  const r = await tratarMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ferramentasDeAutoria(home),
  );
  return (r.corpo as { result: Conteudo }).result;
}

const texto = (c: Conteudo) => c.content.map((x) => x.text).join("");

async function schemas(home: string): Promise<Record<string, { properties: Record<string, unknown> }>> {
  const r = await tratarMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ferramentasDeAutoria(home));
  const tools = (r.corpo as { result: { tools: { name: string; inputSchema: never }[] } }).result.tools;
  return Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
}

describe("o conjunto de autoria", () => {
  it("oferece criar e editar, e NADA que execute ou apague", async () => {
    /*
     * É a fronteira toda desta feature. Definição errada se conserta em um
     * segundo; um run gasta quota de verdade e escreve branch no repositório da
     * pessoa. Apagar ficou de fora por ser a única ação de autoria que perde
     * trabalho. Se alguém acrescentar uma quarta ferramenta, este teste falha e
     * a decisão volta a ser tomada de propósito.
     */
    const nomes = Object.keys(await schemas(casa()));
    expect(nomes.sort()).toEqual([
      "nexo_agente_salvar",
      "nexo_contexto",
      "nexo_hook_listar",
      "nexo_hook_salvar",
      "nexo_time_salvar",
    ]);
  });

  it("nexo_hook_salvar recusa bloqueante, mesmo que o modelo mande — só a pessoa liga isso na tela", async () => {
    const home = casa();
    saveAgent({ id: "a1", name: "A1", profileId: "conta-a" }, home);
    const r = await chamar(home, "nexo_hook_salvar", {
      escopo: { tipo: "global" },
      evento: "git.pre-push",
      agentId: "a1",
      bloqueante: true,
    });
    expect(r.isError).toBe(true);
    expect(texto(r)).toMatch(/só na tela Hooks/);
  });

  it("as descrições carregam as regras — é o que faz funcionar sem instalar nada", async () => {
    const home = casa();
    const r = await tratarMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ferramentasDeAutoria(home));
    const tools = (r.corpo as { result: { tools: { name: string; description: string }[] } }).result.tools;
    const time = tools.find((t) => t.name === "nexo_time_salvar")?.description ?? "";
    // as três topologias e o que decide entre elas
    for (const p of ["pipeline", "fanin", "supervisor"]) expect(time).toContain(p);
    expect(time, "o supervisor sozinho é o erro mais fácil de cometer").toMatch(/além dele/);
    expect(time, "criar não é rodar, e isso tem que estar dito").toMatch(/NÃO o executa/);
  });
});

describe("nexo_contexto", () => {
  it("lista o que existe, pra ele não inventar id", async () => {
    const home = casa();
    saveAgent({ id: "revisor", name: "Revisor", profileId: "conta-a" }, home);
    const t = texto(await chamar(home, "nexo_contexto"));
    expect(t).toContain("conta-a");
    expect(t).toContain("conta-b");
    expect(t).toContain("revisor");
  });

  it("home vazio diz o que fazer em vez de mostrar lista vazia", async () => {
    const t = texto(await chamar(tempHome(), "nexo_contexto"));
    expect(t).toMatch(/nenhuma/);
    // sem conta não há agente possível, e criar conta não é trabalho do modelo
    expect(t).toMatch(/quem cria conta é a pessoa/);
  });
});

describe("nexo_agente_salvar", () => {
  it("cria de verdade", async () => {
    const home = casa();
    const c = await chamar(home, "nexo_agente_salvar", {
      id: "escritor",
      name: "Escritor",
      profileId: "conta-a",
      instructions: "escreve o rascunho e não revisa",
    });
    expect(c.isError).toBeFalsy();
    const a = listAgents(home).find((x) => x.id === "escritor");
    expect(a?.instructions).toBe("escreve o rascunho e não revisa");
  });

  it("atualiza sem apagar o que não foi mandado", async () => {
    const home = casa();
    await chamar(home, "nexo_agente_salvar", {
      id: "e",
      name: "E",
      profileId: "conta-a",
      instructions: "original",
    });
    await chamar(home, "nexo_agente_salvar", { id: "e", name: "E2", profileId: "conta-a" });
    const a = listAgents(home).find((x) => x.id === "e");
    expect(a?.name).toBe("E2");
    expect(a?.instructions, "campo não mandado não é campo apagado").toBe("original");
  });

  it("pedido inválido volta como isError com o motivo, e não mata o turno", async () => {
    /*
     * A diferença importa: erro de JSON-RPC derruba a chamada no cliente e o
     * modelo nunca sabe o porquê. Como `isError` ele LÊ a mensagem e corrige.
     */
    const home = casa();
    const c = await chamar(home, "nexo_agente_salvar", { id: "MAIÚSCULO", name: "X", profileId: "conta-a" });
    expect(c.isError).toBe(true);
    expect(texto(c)).toMatch(/id inválido/);
  });

  it("conta que não existe é recusada com o nome dela", async () => {
    const c = await chamar(casa(), "nexo_agente_salvar", { id: "x", name: "X", profileId: "fantasma" });
    expect(c.isError).toBe(true);
    expect(texto(c)).toContain("fantasma");
  });

  it("o enum de conta é o que existe agora, não uma lista fixa", async () => {
    const home = casa();
    const s = await schemas(home);
    const conta = (s.nexo_agente_salvar?.properties.profileId ?? {}) as { enum?: string[] };
    expect(conta.enum).toEqual(["conta-a", "conta-b"]);
  });
});

describe("nexo_time_salvar", () => {
  const comAgentes = () => {
    const home = casa();
    saveAgent({ id: "escritor", name: "Escritor", profileId: "conta-a" }, home);
    saveAgent({ id: "revisor", name: "Revisor", profileId: "conta-b" }, home);
    return home;
  };

  it("cria pipeline na ordem que veio", async () => {
    const home = comAgentes();
    const c = await chamar(home, "nexo_time_salvar", {
      id: "dupla",
      name: "Dupla",
      topology: "pipeline",
      members: [{ agentId: "escritor", papel: "rascunho" }, { agentId: "revisor" }],
    });
    expect(c.isError).toBeFalsy();
    const t = listTeams(home).find((x) => x.id === "dupla");
    expect(t?.members.map((m) => m.agentId)).toEqual(["escritor", "revisor"]);
    expect(texto(c), "ele tem que ficar sabendo que não rodou").toMatch(/dispara na tela/);
  });

  it("supervisor sozinho é recusado com o motivo", async () => {
    const home = comAgentes();
    const c = await chamar(home, "nexo_time_salvar", {
      id: "so-chefe",
      name: "Só chefe",
      topology: "supervisor",
      members: [{ agentId: "escritor" }],
    });
    expect(c.isError).toBe(true);
    expect(texto(c)).toMatch(/pelo menos um membro além dele/);
    expect(listTeams(home)).toHaveLength(0);
  });

  it("agente que não existe é recusado", async () => {
    const c = await chamar(comAgentes(), "nexo_time_salvar", {
      id: "t",
      name: "T",
      topology: "pipeline",
      members: [{ agentId: "ninguem" }],
    });
    expect(c.isError).toBe(true);
  });

  it("o enum de membro é o que existe agora", async () => {
    const s = await schemas(comAgentes());
    const membros = (s.nexo_time_salvar?.properties.members ?? {}) as {
      items?: { properties?: { agentId?: { enum?: string[] } } };
    };
    expect(membros.items?.properties?.agentId?.enum).toEqual(["escritor", "revisor"]);
  });

  it("time sem membro nenhum não passa", async () => {
    const c = await chamar(comAgentes(), "nexo_time_salvar", {
      id: "vazio",
      name: "Vazio",
      topology: "pipeline",
      members: [],
    });
    expect(c.isError).toBe(true);
  });
});

describe("ferramenta que não existe", () => {
  it("é erro de protocolo, porque não é coisa que o modelo conserte chamando de novo", async () => {
    const r = await tratarMcp(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nexo_time_apagar" } },
      ferramentasDeAutoria(casa()),
    );
    expect((r.corpo as { error?: { message: string } }).error?.message).toMatch(/desconhecida/);
  });
});
