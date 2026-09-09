import type { Conjunto } from "./mcp.ts";
import { appendEvent } from "./threads.ts";
import { sessionBus } from "./bus.ts";

/**
 * `nexo_perguntar`: pausa o turno pra perguntar algo a quem está acompanhando a conversa (ou o
 * time/hook, se for passo de Run) e retoma com a resposta. Ver design em
 * `docs/superpowers/specs/2026-09-09-delegacao-e-pergunta-design.md`.
 *
 * Escopo por `threadId`, não por `runId` — é o denominador comum entre conversa normal (só tem
 * thread) e passo de Run (`executarPasso` em runs.ts já cria uma thread por passo). No máximo UMA
 * pergunta pendente por thread: o modelo só chama uma ferramenta de cada vez dentro do turno, então
 * isso nunca precisa desempatar duas perguntas da mesma conversa.
 */

function nowIso(): string {
  return new Date().toISOString();
}

let seq = 0;
function newPerguntaId(): string {
  seq += 1;
  return `pg-${Date.now().toString(36)}-${seq}`;
}

type Pendente = { resolve: (resposta: string) => void };

/** Pergunta em voo, por thread. */
const pendentes = new Map<string, Pendente>();

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS_PERGUNTAR = ["mcp__nexo__nexo_perguntar"];

const OPCOES_MAX = 6;

/**
 * Ferramenta MCP `nexo_perguntar`, presa a ESTE thread — mesmo padrão de `ferramentaDeVeredito`.
 * Entra pela boca de autoria (`/v1/mcp?threadId=...`), disponível em toda conversa (normal ou
 * passo de Run), ao contrário do veredito (só quando `runId` é de um pre-push).
 */
export function ferramentaDePerguntar(threadId: string, home: string): Conjunto {
  return () => [
    {
      name: "nexo_perguntar",
      description:
        "Pausa e pergunta algo a quem está acompanhando esta conversa (pessoa, ou quem revisa o " +
        "run, se for time/hook automático). Use quando uma decisão importante depende de uma " +
        "escolha que só quem pediu pode fazer — não para confirmar cada passo pequeno. Com " +
        "`opcoes`, a resposta tende a ser uma delas, mas texto livre também é aceito. Sem " +
        "resposta dentro do teto do turno (~15min), a chamada estoura como qualquer ferramenta " +
        "travada — não fique perguntando o óbvio esperando alguém acordar.",
      inputSchema: {
        type: "object",
        properties: {
          pergunta: { type: "string", description: "a pergunta, direta e com o contexto necessário" },
          opcoes: {
            type: "array",
            items: { type: "string" },
            maxItems: OPCOES_MAX,
            description: "opcional: até 6 opções pra UI desenhar como botão — dica de exibição, não validação",
          },
        },
        required: ["pergunta"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const pergunta = typeof args.pergunta === "string" ? args.pergunta.trim() : "";
        if (!pergunta) return { ok: false, texto: 'faltou "pergunta"' };
        const opcoesRaw = Array.isArray(args.opcoes) ? args.opcoes : [];
        const opcoes = opcoesRaw
          .map((o) => String(o).trim())
          .filter(Boolean)
          .slice(0, OPCOES_MAX);
        return perguntar(threadId, home, pergunta, opcoes);
      },
    },
  ];
}

/**
 * O mecanismo de pausa em si, sem a casca de ferramenta MCP — `nexo_delegar` (delegar.ts), no
 * modo "questionar", chama isto direto pra perguntar "pode delegar?" sem precisar o modelo passar
 * por uma segunda chamada de ferramenta.
 */
export async function perguntar(
  threadId: string,
  home: string,
  pergunta: string,
  opcoes: string[] = [],
): Promise<{ ok: boolean; texto: string }> {
  if (pendentes.has(threadId)) {
    return { ok: false, texto: "já existe uma pergunta pendente nesta conversa — espere a resposta antes de perguntar de novo" };
  }

  const id = newPerguntaId();
  const perguntaEv = {
    ts: nowIso(),
    type: "pergunta" as const,
    threadId,
    id,
    texto: pergunta,
    ...(opcoes.length ? { opcoes: opcoes.slice(0, OPCOES_MAX) } : {}),
  };
  appendEvent(perguntaEv, home);
  sessionBus.emit(threadId, perguntaEv);
  sessionBus.emit("*", perguntaEv);

  const resposta = await new Promise<string>((resolve) => {
    pendentes.set(threadId, { resolve });
  });

  const respostaEv = { ts: nowIso(), type: "pergunta_resposta" as const, threadId, id, resposta };
  appendEvent(respostaEv, home);
  sessionBus.emit(threadId, respostaEv);
  sessionBus.emit("*", respostaEv);

  return { ok: true, texto: resposta };
}

/** Resolve a pergunta pendente desta thread. `false` se não havia nenhuma (já respondida, ou nunca existiu). */
export function responderPergunta(threadId: string, resposta: string): boolean {
  const p = pendentes.get(threadId);
  if (!p) return false;
  pendentes.delete(threadId);
  p.resolve(resposta.trim());
  return true;
}

/** Se esta thread tem pergunta esperando resposta agora. */
export function temPerguntaPendente(threadId: string): boolean {
  return pendentes.has(threadId);
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetPerguntasForTest(): void {
  pendentes.clear();
}
