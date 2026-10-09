/**
 * O recado das torres na ilha de borda (puro, sem DOM): quais torres estão ativas e o texto que
 * o leitor de tela lê. A ilha só tem o retrato das conversas (ela consulta, não escuta stream),
 * então aqui não há explorador nem hook em tempo real — janelas do Observatório e do Salão e o "?"
 * saem direto dele; a aba Torre, com os streams, mostra o resto.
 */
import { aplicarRetrato, feedVazio } from "./torre/feed.js";
import { torreModelo } from "./torre/modelo.js";
import { ordemDasTorres, resumoDaIlha, torreAtiva } from "./torre/visao.js";

export const TORRES_NA_FAIXA = 4;

/**
 * @param agentes retrato do daemon (`GET /v1/agents`)
 * @returns `{ torres, ativas, esperando, primeiraEsperando, aria }` — `torres`: só as ativas, as que esperam você primeiro
 */
export function torresDaIlha(agentes, agora = Date.now()) {
  const feed = feedVazio();
  aplicarRetrato(feed, Array.isArray(agentes) ? agentes : [], agora);
  const modelo = torreModelo(feed, agora, {});
  return { torres: ordemDasTorres(modelo.torres.filter(torreAtiva)), ...resumoDaIlha(modelo.torres) };
}

/** Conversa que espera resposta numa torre (pro clique no "?"). */
export function conversaEsperando(torre) {
  const m = torre?.magos?.find((x) => x.estado === "esperando") ?? torre?.astronomos?.find((x) => x.estado === "esperando");
  return m ? { threadId: m.threadId, projectPath: torre.projectPath } : null;
}
