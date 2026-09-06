/**
 * Servidor MCP do Nexo — a versão do supervisor em que ele age DENTRO do turno.
 *
 * No supervisor por turno (`supervisor.ts`) o modelo responde uma ordem, o turno
 * fecha, o daemon executa e volta no turno seguinte: um turno por decisão. Aqui
 * o modelo chama uma ferramenta e recebe a resposta sem sair do turno — o run
 * inteiro cabe num turno só.
 *
 * O que se paga por isso:
 * - **só motor que fala MCP.** `api` e `stub` não falam; ali só existe o modo
 *   por turno, e é por isso que ele continua sendo o padrão.
 * - **a ferramenta é presa a UM run.** O caminho carrega o id, e um supervisor
 *   não alcança membro de outro run. Sem isso, um token vazado daria acesso a
 *   disparar qualquer agente da máquina.
 *
 * Isto NÃO é um servidor MCP genérico: implementa o mínimo do JSON-RPC que o
 * cliente do Claude Code exige (initialize, tools/list, tools/call) e recusa o
 * resto com "method not found", que é a resposta correta pra método que não
 * existe.
 */

/** Versão do protocolo que respondemos. O cliente manda a dele no initialize. */
export const MCP_PROTOCOL = "2025-06-18";

export type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export type Resposta = { corpo: unknown; status: number } | { corpo: null; status: 202 };

const ERRO = {
  parse: -32700,
  pedido: -32600,
  metodo: -32601,
  parametro: -32602,
  interno: -32603,
} as const;

function ok(id: JsonRpc["id"], result: unknown): Resposta {
  return { corpo: { jsonrpc: "2.0", id: id ?? null, result }, status: 200 };
}

function falha(id: JsonRpc["id"], code: number, message: string): Resposta {
  return { corpo: { jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status: 200 };
}

/** Um membro que o supervisor pode chamar. */
export type MembroMcp = { id: string; nome: string; papel?: string };

export type Ferramentas = {
  membros: () => MembroMcp[];
  /** Roda o passo e devolve o que o membro produziu. Erro esperado vem como texto. */
  chamar: (membro: string, pedido: string) => Promise<{ ok: boolean; texto: string }>;
};

export function definicoesDeFerramenta(membros: MembroMcp[]): unknown[] {
  const ids = membros.map((m) => m.id);
  return [
    {
      name: "nexo_membros",
      description:
        "Lista os membros do time que você pode pôr pra trabalhar, com o papel de cada um neste time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "nexo_chamar",
      description:
        "Põe um membro do time pra trabalhar e devolve o que ele produziu. Ele roda na pasta do " +
        "projeto, com as ferramentas dele. Chame um de cada vez e use o resultado pra decidir o " +
        "próximo. Você NÃO executa o trabalho: quem lê arquivo, escreve código e roda comando são " +
        "os membros.",
      inputSchema: {
        type: "object",
        properties: {
          membro: { type: "string", description: "id do membro", ...(ids.length ? { enum: ids } : {}) },
          pedido: { type: "string", description: "o que ele deve fazer, com o contexto necessário" },
        },
        required: ["membro", "pedido"],
        additionalProperties: false,
      },
    },
  ];
}

/** Conteúdo de resposta de ferramenta. `isError` é o jeito do MCP dizer "deu errado, mas continue". */
function conteudo(texto: string, erro = false): unknown {
  return { content: [{ type: "text", text: texto }], ...(erro ? { isError: true } : {}) };
}

/**
 * Trata uma mensagem JSON-RPC.
 *
 * Notificação (sem `id`) não tem resposta — devolve 202 com corpo vazio, que é o
 * que o transporte HTTP do MCP espera. Responder 200 com corpo a uma notificação
 * faz cliente estrito reclamar.
 */
export async function tratarMcp(msg: JsonRpc, fer: Ferramentas): Promise<Resposta> {
  if (!msg || typeof msg !== "object") return falha(null, ERRO.pedido, "mensagem inválida");
  const { method, id } = msg;
  const notificacao = id === undefined || id === null;

  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return { corpo: null, status: 202 };
  }
  if (notificacao) return { corpo: null, status: 202 };

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "nexo", version: "1" },
    });
  }

  if (method === "ping") return ok(id, {});

  if (method === "tools/list") {
    return ok(id, { tools: definicoesDeFerramenta(fer.membros()) });
  }

  if (method === "tools/call") {
    const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const args = (p.arguments ?? {}) as { membro?: unknown; pedido?: unknown };
    if (p.name === "nexo_membros") {
      const lista = fer
        .membros()
        .map((m) => `- ${m.id} — ${m.nome}${m.papel ? `: ${m.papel}` : ""}`)
        .join("\n");
      return ok(id, conteudo(lista || "o time não tem mais ninguém"));
    }
    if (p.name !== "nexo_chamar") {
      return falha(id, ERRO.metodo, `ferramenta desconhecida: ${String(p.name)}`);
    }
    const membro = typeof args.membro === "string" ? args.membro.trim() : "";
    const pedido = typeof args.pedido === "string" ? args.pedido.trim() : "";
    // Argumento faltando é erro DE FERRAMENTA, não de protocolo: assim o modelo
    // lê a mensagem e corrige a chamada, em vez de o turno morrer no cliente.
    if (!membro || !pedido) {
      return ok(id, conteudo('faltou "membro" ou "pedido" — os dois são obrigatórios', true));
    }
    try {
      const r = await fer.chamar(membro, pedido);
      return ok(id, conteudo(r.texto, !r.ok));
    } catch (e) {
      return falha(id, ERRO.interno, (e as Error).message || "falhou ao chamar o membro");
    }
  }

  return falha(id, ERRO.metodo, `método não suportado: ${String(method)}`);
}

/** Erro de parse do corpo, na forma que o JSON-RPC manda. */
export function erroDeParse(): Resposta {
  return falha(null, ERRO.parse, "JSON inválido");
}

/**
 * Arquivo de config que o CLI recebe em `--mcp-config`. Vai em ARQUIVO e não em
 * argumento porque carrega o token do daemon: argv de processo é legível por
 * qualquer processo do mesmo usuário, e um arquivo `0600` não é.
 */
export function configDeMcp(porta: number, token: string, runId: string): string {
  return JSON.stringify({
    mcpServers: {
      nexo: {
        type: "http",
        url: `http://127.0.0.1:${porta}/v1/mcp/${runId}`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
}

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS = ["mcp__nexo__nexo_membros", "mcp__nexo__nexo_chamar"];
