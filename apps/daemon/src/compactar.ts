import type { PackConfig, Profile, ThreadEvent } from "@nexo/shared";
import { aResumir, CABECALHO, cobertosPor, escopo, tokensDoHistorico } from "./packer.ts";

/**
 * Resumir o histórico antigo, em vez de cortá-lo.
 *
 * O que existia antes: quando o histórico passava do teto, o `pack` guardava as
 * últimas mensagens e, do resto, os primeiros `prefixCharBudget` CARACTERES —
 * cortados no meio da palavra. O meio da conversa desaparecia inteiro, e a única
 * pista era um `context_trimmed` no JSONL.
 *
 * **Por que resumir e não cortar mais.** Cortar melhor não existe: qualquer corte
 * escolhe o que perder por posição, e posição não tem relação com importância. O
 * resumo é a única forma de o turno seguinte ainda saber por que uma decisão foi
 * tomada seis mensagens atrás.
 *
 * **Por que o Nexo precisa fazer isso, e não o CLI.** O CLI do `claude` tem
 * autocompact próprio (o `autocompact_state` do stream traz `enabled` e
 * `threshold`), mas ele nunca dispara aqui: o Nexo faz UM SPAWN POR TURNO com
 * `--print`, e o histórico vai no context pack. Não existe sessão longa pra ele
 * compactar — a memória da conversa é do Nexo, então a compactação também.
 *
 * **O que isto custa.** Um turno inteiro da sua conta, com o histórico antigo
 * como entrada. É o preço de resumir e não tem como fugir dele. Em troca, todos
 * os turnos seguintes mandam o resumo em vez do histórico — então se paga rápido
 * numa conversa que continua. O interruptor é `pack.compactar`.
 */

/**
 * O pedido de resumo.
 *
 * Escrito pra ser lido por OUTRO MODELO, não por uma pessoa: o resumo vai no
 * topo do context pack dos turnos seguintes, e o que importa ali é o que muda
 * uma decisão futura. Resumo bonito e vago ("discutimos a arquitetura") é pior
 * que o corte, porque ocupa espaço fingindo que preservou algo.
 */
export function pedidoDeResumo(historico: string): string {
  return [
    "Resuma a conversa abaixo para que OUTRO agente possa continuar o trabalho sem tê-la lido.",
    "",
    "Inclua, quando houver:",
    "- decisões tomadas e o MOTIVO de cada uma (o motivo é o que não dá pra redescobrir);",
    "- o que foi tentado e falhou, pra ninguém repetir;",
    "- arquivos, funções e comandos mencionados, pelo nome exato;",
    "- números, versões e valores que foram medidos ou combinados;",
    "- o que ficou pendente ou em aberto.",
    "",
    "Não inclua: elogio, saudação, meta-comentário sobre a conversa, nem repetição",
    "de código que está no repositório. Não invente o que não está escrito — se algo",
    "ficou ambíguo, diga que ficou.",
    "",
    "Escreva em tópicos, dentro de 400 palavras, sem preâmbulo nenhum: comece direto",
    "pelo primeiro tópico.",
    "",
    "--- conversa ---",
    historico,
  ].join("\n");
}

/**
 * O texto que vai ao motor: o resumo anterior, se houver, mais o trecho que
 * será substituído.
 *
 * O resumo anterior entra de propósito: assim o resultado continua sendo UM
 * resumo consolidado. Sem ele, cada compactação produziria um resumo do resumo,
 * e a informação mais antiga iria se degradando a cada passagem.
 */
export function historicoParaResumir(events: ThreadEvent[], packCfg: PackConfig, tetoTokens: number): string {
  const anterior = escopo(events).resumo;
  const corpo = aResumir(events, packCfg, tetoTokens)
    .map((e) => {
      if (e.type === "user") return `Usuário: ${e.text}`;
      if (e.type === "assistant") return `Assistente: ${e.text}`;
      if (e.type === "tool") return `[ferramenta ${e.name}: ${e.summary}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
  return anterior ? `${CABECALHO}\n${anterior}\n\n${corpo}` : corpo;
}

/** Resumo que não presta é pior que corte: ocupa espaço fingindo ter preservado algo. */
const RESUMO_MIN_CHARS = 40;

export type Resultado =
  | { ok: true; evento: Extract<ThreadEvent, { type: "compacted" }> }
  | { ok: false; motivo: string };

/**
 * Monta o evento `compacted`, dado o texto que o motor devolveu.
 *
 * Separado de quem chama o motor de propósito: esta parte é pura e é onde estão
 * as decisões (o que conta como resumo utilizável, quantos eventos ele cobre),
 * então dá pra testá-la sem subir motor nenhum.
 */
export function montarCompactacao(
  events: ThreadEvent[],
  packCfg: PackConfig,
  tetoTokens: number,
  threadId: string,
  resumo: string,
  agora: string,
): Resultado {
  const texto = resumo.trim();
  if (texto.length < RESUMO_MIN_CHARS) return { ok: false, motivo: "o motor devolveu resumo vazio ou curto demais" };
  const cobertos = cobertosPor(events, packCfg, tetoTokens);
  if (cobertos <= 0) return { ok: false, motivo: "não havia o que resumir" };

  const antes = tokensDoHistorico(events);
  const depois = tokensDoHistorico([
    ...events,
    { ts: agora, type: "compacted", threadId, text: texto, cobertos, tokensAntes: 0, tokensDepois: 0 },
  ]);
  /*
   * Resumo que não encolhe nada é descartado. Acontece com conversa de muitas
   * mensagens curtas: o resumo pedido tem tamanho próprio e pode ficar maior que
   * o que ele substitui. Gravar seria pagar um turno pra piorar.
   */
  if (depois >= antes) return { ok: false, motivo: `o resumo não encolheu nada (${antes} → ${depois} tokens)` };

  return {
    ok: true,
    evento: { ts: agora, type: "compacted", threadId, text: texto, cobertos, tokensAntes: antes, tokensDepois: depois },
  };
}

/** Contas em que o resumo é possível. `stub` entra porque é como se testa. */
export function podeCompactar(p: Profile): boolean {
  return p.status === "ready";
}
