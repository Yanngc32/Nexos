/**
 * Máquina de estados do painel de agentes: aplica um evento do stream no
 * retrato de uma conversa.
 *
 * Fica separado do painel porque é a única parte com regra de verdade — e
 * regra sutil: o que liga e desliga o "ocupado", quando o cronômetro começa,
 * e o fato de `switched` limpar a marca de quota (a conta nova não herda o
 * limite estourado da antiga).
 */

/** Rabo do que o agente está escrevendo: o painel mostra o fim, não o começo. */
export const AGENT_TAIL_CHARS = 400;

/**
 * @param a retrato do agente, alterado no lugar
 * @param ev evento do stream
 * @returns true quando algo mudou e vale repintar
 */
export function aplicarNoRetrato(a, ev) {
  switch (ev.type) {
    case "text":
      a.busy = true;
      a.tail = (a.tail + ev.text).slice(-AGENT_TAIL_CHARS);
      if (!a.startedAt) a.startedAt = Date.now();
      break;
    case "thinking":
      a.busy = true;
      if (!a.startedAt) a.startedAt = Date.now();
      break;
    case "session":
      if (ev.model) a.model = ev.model;
      break;
    case "context":
    case "usage":
      if (ev.contextTokens) a.contextTokens = ev.contextTokens;
      break;
    case "switched":
      a.profileId = ev.toProfileId;
      a.pendingQuota = false;
      break;
    case "quota":
      a.busy = false;
      a.pendingQuota = true;
      a.lastTerminal = "quota";
      break;
    case "auth":
    case "error":
      a.busy = false;
      a.lastTerminal = ev.type === "auth" ? "auth" : "error";
      break;
    case "done":
      a.busy = false;
      a.pendingQuota = false;
      a.lastTerminal = "done";
      break;
    default:
      return false;
  }
  return true;
}
