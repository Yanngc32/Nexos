import { describe, expect, it, vi } from "vitest";
import {
  configDeMcp,
  definicoesDeFerramenta,
  erroDeParse,
  MCP_PROTOCOL,
  MCP_TOOLS,
  tratarMcp,
  type Ferramentas,
} from "../src/mcp.ts";

const MEMBROS = [
  { id: "leitor", nome: "Leitor", papel: "lê o código" },
  { id: "escritor", nome: "Escritor" },
];

function ferramentas(over: Partial<Ferramentas> = {}): Ferramentas {
  return {
    membros: () => MEMBROS,
    chamar: async (membro, pedido) => ({ ok: true, texto: `${membro} fez: ${pedido}` }),
    ...over,
  };
}

/** Extrai o `result` de uma resposta bem-sucedida; falha o teste se veio erro. */
function resultado(r: Awaited<ReturnType<typeof tratarMcp>>) {
  const corpo = r.corpo as { result?: unknown; error?: { message: string } };
  if (corpo?.error) throw new Error(`esperava result, veio erro: ${corpo.error.message}`);
  return corpo?.result as Record<string, unknown>;
}

function erro(r: Awaited<ReturnType<typeof tratarMcp>>) {
  const corpo = r.corpo as { error?: { code: number; message: string } };
  if (!corpo?.error) throw new Error("esperava erro");
  return corpo.error;
}

/** Texto que o modelo lê de volta numa chamada de ferramenta. */
function texto(res: Record<string, unknown>): string {
  return (res.content as Array<{ text: string }>)[0]?.text ?? "";
}

describe("handshake", () => {
  it("initialize devolve a versão do protocolo e a capacidade de ferramentas", async () => {
    const r = await tratarMcp({ jsonrpc: "2.0", id: 1, method: "initialize" }, ferramentas());
    expect(resultado(r)).toMatchObject({
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "nexo" },
    });
  });

  it("notificação não tem resposta: 202 sem corpo", async () => {
    const r = await tratarMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, ferramentas());
    expect(r).toEqual({ corpo: null, status: 202 });
  });

  it("pedido sem id também é notificação — responder com corpo faria cliente estrito reclamar", async () => {
    expect(await tratarMcp({ jsonrpc: "2.0", method: "tools/list" }, ferramentas())).toEqual({
      corpo: null,
      status: 202,
    });
  });

  it("método que não existe é 'method not found', não erro genérico", async () => {
    const r = await tratarMcp({ jsonrpc: "2.0", id: 2, method: "resources/list" }, ferramentas());
    expect(erro(r).code).toBe(-32601);
  });

  it("corpo ilegível vira erro de parse do JSON-RPC", () => {
    expect((erroDeParse().corpo as { error: { code: number } }).error.code).toBe(-32700);
  });
});

describe("tools/list", () => {
  it("expõe as duas ferramentas, com os ids do time no enum", async () => {
    const r = await tratarMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ferramentas());
    const tools = resultado(r).tools as Array<{
      name: string;
      inputSchema: { properties: { membro?: { enum?: string[] } } };
    }>;
    expect(tools.map((t) => t.name)).toEqual(["nexo_membros", "nexo_chamar"]);
    // o enum é o que impede o modelo de inventar id de membro
    expect(tools[1]?.inputSchema.properties.membro?.enum).toEqual(["leitor", "escritor"]);
  });

  it("time vazio não gera enum vazio, que recusaria qualquer valor", () => {
    const tools = definicoesDeFerramenta([]) as Array<{ inputSchema: { properties: Record<string, object> } }>;
    expect(tools[1]?.inputSchema.properties.membro).not.toHaveProperty("enum");
  });

  it("os nomes que o CLI enxerga batem com o que vai no --allowed-tools", async () => {
    const r = await tratarMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ferramentas());
    const tools = resultado(r).tools as Array<{ name: string }>;
    expect(tools.map((t) => `mcp__nexo__${t.name}`)).toEqual(MCP_TOOLS);
  });
});

describe("nexo_membros", () => {
  it("lista quem dá pra chamar, com o papel", async () => {
    const r = await tratarMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nexo_membros" } },
      ferramentas(),
    );
    expect(texto(resultado(r))).toBe("- leitor — Leitor: lê o código\n- escritor — Escritor");
  });
});

describe("nexo_chamar", () => {
  const chamada = (args: unknown) => ({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "nexo_chamar", arguments: args },
  });

  it("roda o membro e devolve o que ele produziu", async () => {
    const r = await tratarMcp(chamada({ membro: "leitor", pedido: "olha o src" }), ferramentas());
    expect(texto(resultado(r))).toBe("leitor fez: olha o src");
    expect(resultado(r).isError).toBeUndefined();
  });

  it("argumento faltando é erro DE FERRAMENTA, pro modelo corrigir a chamada", async () => {
    const chamar = vi.fn();
    const r = await tratarMcp(chamada({ membro: "leitor" }), ferramentas({ chamar }));
    // isError deixa o turno seguir: o modelo lê a mensagem e tenta de novo
    expect(resultado(r).isError).toBe(true);
    expect(texto(resultado(r))).toMatch(/membro.*pedido/);
    expect(chamar).not.toHaveBeenCalled();
  });

  it("membro recusado volta como isError, não derruba o turno", async () => {
    const r = await tratarMcp(
      chamada({ membro: "fantasma", pedido: "x" }),
      ferramentas({ chamar: async () => ({ ok: false, texto: "não está no time" }) }),
    );
    expect(resultado(r).isError).toBe(true);
    expect(texto(resultado(r))).toBe("não está no time");
  });

  it("exceção do daemon vira erro de protocolo: é defeito nosso, não do modelo", async () => {
    const r = await tratarMcp(
      chamada({ membro: "leitor", pedido: "x" }),
      ferramentas({
        chamar: async () => {
          throw new Error("disco cheio");
        },
      }),
    );
    expect(erro(r)).toMatchObject({ code: -32603, message: "disco cheio" });
  });

  it("ferramenta desconhecida é recusada pelo nome", async () => {
    const r = await tratarMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rm_rf" } },
      ferramentas(),
    );
    expect(erro(r).message).toMatch(/rm_rf/);
  });
});

describe("configDeMcp", () => {
  it("aponta pro run, com o token no header", () => {
    const cfg = JSON.parse(configDeMcp(7432, "segredo", "r-1"));
    expect(cfg.mcpServers.nexo).toEqual({
      type: "http",
      url: "http://127.0.0.1:7432/v1/mcp/r-1",
      headers: { Authorization: "Bearer segredo" },
    });
  });

  it("o caminho carrega o id do run: é o que prende a ferramenta a UM run", () => {
    const a = JSON.parse(configDeMcp(7432, "s", "r-1")).mcpServers.nexo.url;
    const b = JSON.parse(configDeMcp(7432, "s", "r-2")).mcpServers.nexo.url;
    expect(a).not.toBe(b);
  });
});
