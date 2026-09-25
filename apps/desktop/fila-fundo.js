/**
 * Fila das conversas que NÃO estão abertas.
 *
 * A fila de cada conversa mora no app (`state.queue[threadId]`), e o envio da conversa aberta anda
 * pelo `done` do SSE dela. Trocou de chat, o SSE da outra fecha e a fila dela parava até a pessoa
 * voltar — e mandar algo à mão. Aqui a decisão de quem pode mandar o próximo item, olhando o
 * retrato dos agentes (`GET /v1/agents`) que o app já acompanha. Puro: o renderer faz o envio.
 */

/** Sem retrato do agente depois de mandar (motor que não subiu, poll atrasado): espera isto. */
export const ESPERA_SEM_RETRATO_MS = 15_000;

/**
 * Conversas (fora a aberta) com fila e turno encerrado BEM — prontas pro próximo item.
 *
 * - Turno em voo ou pergunta esperando resposta: espera.
 * - Turno que acabou em erro/quota/login: fila fica parada (mesma regra da conversa aberta — a
 *   próxima mensagem bateria na mesma parede sem ninguém ver).
 * - Depois de mandar um item, só manda o seguinte quando o retrato mostra um turno que COMEÇOU
 *   depois do envio e já acabou; sem retrato nenhum, espera `ESPERA_SEM_RETRATO_MS`. Sem isso o
 *   poll atrasado despejaria a fila inteira de uma vez.
 */
export function conversasProntas({ filas, atual, agentes, ultimoEnvio, enviando, agora = Date.now() }) {
  const porThread = new Map((Array.isArray(agentes) ? agentes : []).map((a) => [a.threadId, a]));
  const prontas = [];
  for (const [threadId, fila] of Object.entries(filas ?? {})) {
    if (threadId === atual || !fila?.length || enviando?.has(threadId)) continue;
    const a = porThread.get(threadId);
    if (a && (a.busy || a.aguardando)) continue;
    if (a?.lastTerminal && a.lastTerminal !== "done") continue;
    const mandou = ultimoEnvio?.get(threadId);
    if (mandou !== undefined) {
      const turnoDepois = a && typeof a.startedAt === "number" && a.startedAt >= mandou;
      if (!turnoDepois && agora - mandou < ESPERA_SEM_RETRATO_MS) continue;
    }
    prontas.push(threadId);
  }
  return prontas;
}
