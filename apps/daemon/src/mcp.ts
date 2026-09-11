import { TURNO_TETO_MS } from "@nexo/shared";

/**
 * Servidor MCP do Nexo — a versão do supervisor em que ele age DENTRO do turno.
 *
 * No supervisor por turno (`supervisor.ts`) o modelo responde uma ordem, o turno
 * fecha, o daemon executa e volta no turno seguinte: um turno por decisão. Aqui
 * o modelo chama uma ferramenta e recebe a resposta sem sair do turno — o run
 * inteiro cabe num turno só.
 *
 * O que se paga por isso:
 * - **só o motor `claude`.** É o único em que o Nexo liga MCP hoje. Pro `api` e
 *   pro `stub` não há cliente MCP pra ligar; pro `codex` há (o CLI dele suporta
 *   `mcp_servers`) e é lacuna nossa, não impossibilidade. Nas três o run cai no
 *   modo por turno, e é por isso que ele segue sendo o padrão.
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

/**
 * O que o modelo pediu não deu, mas ele pode corrigir e tentar de novo.
 *
 * `imagem` é opcional e só usada por `nexo_navegador_screenshot` (navegador.ts) — MCP suporta
 * bloco de imagem nativamente no resultado de uma ferramenta; ferramentas existentes nunca setam
 * esse campo, então o comportamento delas não muda em nada.
 */
export type Saida = { ok: boolean; texto: string; imagem?: { dataBase64: string; mimeType: string } };

/**
 * Uma ferramenta MCP: o que o modelo vê e o que ela faz.
 *
 * Descrição e schema juntos com a execução de propósito. São a MESMA decisão:
 * o modelo só chama certo o que a descrição explica, e uma descrição que
 * envelhece longe do código vira armadilha.
 */
export type Ferramenta = {
  name: string;
  description: string;
  inputSchema: unknown;
  executar: (args: Record<string, unknown>) => Promise<Saida> | Saida;
};

/**
 * Um conjunto é uma FUNÇÃO, não uma lista: o que existe muda entre chamadas —
 * os membros do run, as contas e os agentes já criados — e a descrição precisa
 * refletir o mundo na hora do `tools/list`, não na hora em que o daemon subiu.
 */
export type Conjunto = () => Ferramenta[];

/** O que vai no `tools/list`: a ferramenta sem o que o modelo não precisa ver. */
export function definicoesDeFerramenta(ferramentas: Ferramenta[]): unknown[] {
  return ferramentas.map((f) => ({ name: f.name, description: f.description, inputSchema: f.inputSchema }));
}

/**
 * As ferramentas do supervisor: ele não trabalha, ele chama quem trabalha.
 *
 * Presas a UM run — quem constrói este conjunto já sabe de qual — porque um
 * supervisor alcançar membro de outro run transformaria um token vazado em
 * "dispare qualquer agente da máquina".
 */
export function ferramentasDoSupervisor(fer: Ferramentas): Conjunto {
  return () => {
    const ids = fer.membros().map((m) => m.id);
    return [
      {
        name: "nexo_membros",
        description:
          "Lista os membros do time que você pode pôr pra trabalhar, com o papel de cada um neste time.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        executar: () => {
          const lista = fer
            .membros()
            .map((m) => `- ${m.id} — ${m.nome}${m.papel ? `: ${m.papel}` : ""}`)
            .join("\n");
          return { ok: true, texto: lista || "o time não tem mais ninguém" };
        },
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
        executar: async (args) => {
          const membro = typeof args.membro === "string" ? args.membro.trim() : "";
          const pedido = typeof args.pedido === "string" ? args.pedido.trim() : "";
          if (!membro || !pedido) {
            return { ok: false, texto: 'faltou "membro" ou "pedido" — os dois são obrigatórios' };
          }
          return fer.chamar(membro, pedido);
        },
      },
    ];
  };
}

/**
 * Conteúdo de resposta de ferramenta. `isError` é o jeito do MCP dizer "deu errado, mas continue".
 *
 * `imagem` soma um content-block `{type:"image"}` do protocolo MCP — usado só por
 * `nexo_navegador_screenshot` (navegador.ts). Ferramentas que nunca passam `imagem` continuam
 * gerando exatamente `{content:[{type:"text",...}]}`, igual antes desta extensão.
 */
function conteudo(texto: string, erro = false, imagem?: { dataBase64: string; mimeType: string }): unknown {
  const content: unknown[] = [{ type: "text", text: texto }];
  if (imagem) content.push({ type: "image", data: imagem.dataBase64, mimeType: imagem.mimeType });
  return { content, ...(erro ? { isError: true } : {}) };
}

/**
 * Trata uma mensagem JSON-RPC.
 *
 * Notificação (sem `id`) não tem resposta — devolve 202 com corpo vazio, que é o
 * que o transporte HTTP do MCP espera. Responder 200 com corpo a uma notificação
 * faz cliente estrito reclamar.
 */
export async function tratarMcp(msg: JsonRpc, conjunto: Conjunto): Promise<Resposta> {
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

  if (method === "tools/list") return ok(id, { tools: definicoesDeFerramenta(conjunto()) });

  if (method === "tools/call") {
    const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const achada = conjunto().find((f) => f.name === p.name);
    if (!achada) return falha(id, ERRO.metodo, `ferramenta desconhecida: ${String(p.name)}`);
    const args = (p.arguments ?? {}) as Record<string, unknown>;
    try {
      /*
       * Argumento errado ou regra violada é erro DE FERRAMENTA (`isError`), não
       * de protocolo: assim o modelo LÊ a mensagem e corrige a chamada. Erro de
       * JSON-RPC mata o turno no cliente e ele nunca fica sabendo o motivo.
       * Erro de protocolo fica pra defeito nosso, que ele não pode contornar.
       */
      const r = await achada.executar(args);
      return ok(id, conteudo(r.texto, !r.ok, r.imagem));
    } catch (e) {
      const err = e as Error & { status?: number };
      // 4xx é o daemon dizendo "seu pedido está errado" — isso o modelo conserta
      if (err.status && err.status >= 400 && err.status < 500) {
        return ok(id, conteudo(err.message, true));
      }
      return falha(id, ERRO.interno, err.message || "a ferramenta falhou");
    }
  }

  return falha(id, ERRO.metodo, `método não suportado: ${String(method)}`);
}

/** Erro de parse do corpo, na forma que o JSON-RPC manda. */
export function erroDeParse(): Resposta {
  return falha(null, ERRO.parse, "JSON inválido");
}

/**
 * Quanto o cliente MCP espera por UMA chamada de ferramenta.
 *
 * O padrão do CLI é 5 minutos, e é limite de parede — notificação de progresso
 * NÃO estica. Cinco minutos não cobre um membro fazendo trabalho de verdade:
 * a chamada morreria no cliente com o membro ainda trabalhando, e o supervisor
 * receberia um erro que não sabe interpretar.
 *
 * O valor é o teto do próprio daemon mais folga. A ordem importa: quem tem que
 * desistir primeiro é o daemon, porque só ele sabe DIZER o motivo ("motor
 * falhou", "quota estourou") de um jeito que o supervisor entende e pode
 * contornar. Cliente desistindo antes troca uma mensagem útil por um timeout
 * cego.
 */
const FOLGA_MS = 60_000;
export const MCP_TOOL_TIMEOUT_MS = TURNO_TETO_MS + FOLGA_MS;

/**
 * Arquivo de config que o CLI recebe em `--mcp-config`. Vai em ARQUIVO e não em
 * argumento porque carrega o token do daemon: argv de processo é legível por
 * qualquer processo do mesmo usuário, e um arquivo `0600` não é.
 */
function configPara(porta: number, token: string, caminho: string): string {
  return JSON.stringify({
    mcpServers: {
      nexo: {
        type: "http",
        url: `http://127.0.0.1:${porta}${caminho}`,
        headers: { Authorization: `Bearer ${token}` },
        timeout: MCP_TOOL_TIMEOUT_MS,
      },
    },
  });
}

/** Config do supervisor: presa ao run, porque as ferramentas dele são. */
export function configDeMcp(porta: number, token: string, runId: string): string {
  return configPara(porta, token, `/v1/mcp/${runId}`);
}

/**
 * Caminho de `/v1/mcp` pra ESTA conversa — o projeto vai como query porque
 * `/v1/mcp` é uma boca só, compartilhada por toda conversa normal (ao
 * contrário do supervisor, que tem uma por run). É assim que o handler sabe
 * de qual projeto oferecer as ferramentas do repo map (`repo-map-simbolos.ts`):
 * sem projeto no caminho, ele não saberia qual índice checar.
 *
 * `runId` soma quando a conversa É o passo de um run de PIPELINE (ver
 * `executarPasso` em runs.ts, que cria a thread com `runId` no meta) — é
 * assim que o handler sabe oferecer `nexo_veredito` (hooks.ts) só pra ESTE
 * run, mesmo essa conversa passando pela boca de autoria normal e não pela do
 * supervisor (`/v1/mcp/:id`, que só existe pra topologia `supervisor`).
 */
function caminhoDaAutoria(projectPath?: string, runId?: string, threadId?: string): string {
  const params = new URLSearchParams();
  if (projectPath) params.set("projectPath", projectPath);
  if (runId) params.set("runId", runId);
  // `threadId` é o que dá ao handler de `/v1/mcp` como oferecer `nexo_perguntar` (perguntas.ts) e
  // `nexo_delegar` (delegar.ts) presos a ESTA conversa — os dois escopam por thread, não por run,
  // porque conversa normal (sem run nenhum) também precisa dos dois.
  if (threadId) params.set("threadId", threadId);
  const query = params.toString();
  return query ? `/v1/mcp?${query}` : "/v1/mcp";
}

/**
 * Config da conversa normal: as ferramentas de AUTORIA (e, se o projeto já
 * tiver índice de repo map construído, a de símbolos sob demanda; e, se for
 * passo de um run com `runId`, o `nexo_veredito` desse run).
 *
 * Sem run no caminho porque não há run — o que a autoria faz é escrever
 * `agents.json` e `teams.json`; o que o repo map faz é só LER estrutura/símbolo
 * que já existe (ou parsear na hora, sem gravar nada no projeto). Nenhuma das
 * duas executa nada, e é isso que torna aceitável estarem numa conversa comum:
 * definição ruim se apaga num segundo, e consultar símbolo não muda nada no disco.
 */
export function configDeMcpAutoria(
  porta: number,
  token: string,
  projectPath?: string,
  runId?: string,
  threadId?: string,
): string {
  return configPara(porta, token, caminhoDaAutoria(projectPath, runId, threadId));
}

/** Endereço da boca MCP do daemon. O `codex` recebe isto, não arquivo. */
export function urlDeMcp(porta: number, caminho = "/v1/mcp"): string {
  return `http://127.0.0.1:${porta}${caminho}`;
}

/** Mesma boca de `urlDeMcp`, com o projeto (e run, se houver) embutidos — ver `caminhoDaAutoria`. */
export function urlDeMcpAutoria(porta: number, projectPath?: string, runId?: string, threadId?: string): string {
  return urlDeMcp(porta, caminhoDaAutoria(projectPath, runId, threadId));
}

/**
 * Variável que carrega o token pro `codex`.
 *
 * O `-c mcp_servers.<nome>` do codex não aceita header: ele aceita
 * `bearer_token_env_var`, o NOME de uma variável que ele lê do ambiente. Isso
 * cai bem na mesma preocupação que fez a config do `claude` ir pra arquivo
 * `0600` em vez de argv — aqui o token não passa nem por um nem por outro.
 */
export const ENV_TOKEN_MCP = "NEXO_MCP_TOKEN";

/**
 * Os argumentos que ligam o MCP do daemon no `codex exec`.
 *
 * TOML dentro de argumento, que é como o `-c` recebe valor. Sem espaço e com o
 * mínimo de aspas de propósito: no Windows o motor nasce via `cmd.exe`, então
 * quanto menos citação o valor exigir, menos chance de o shell mastigá-lo.
 *
 * Medido contra o codex-cli 0.153.4: o `-c` vale só pra invocação, não escreve
 * `config.toml`, e as ferramentas do daemon chegam ao modelo agrupadas num
 * `mcp__nexo` — verifiquei inspecionando o corpo que o codex manda ao provedor.
 */
export function flagsDeMcpCodex(url: string): string[] {
  return ["-c", `mcp_servers.nexo={url="${url}",bearer_token_env_var="${ENV_TOKEN_MCP}"}`];
}

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS = ["mcp__nexo__nexo_membros", "mcp__nexo__nexo_chamar"];

/** As de autoria, que entram na conversa normal. */
export const MCP_TOOLS_AUTORIA = [
  "mcp__nexo__nexo_contexto",
  "mcp__nexo__nexo_agente_salvar",
  "mcp__nexo__nexo_time_salvar",
  "mcp__nexo__nexo_hook_salvar",
  "mcp__nexo__nexo_hook_listar",
];
