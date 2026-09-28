/**
 * O que o clique no botão do motor faz. Decide pelo que a pessoa VIU, não pelo estado no instante
 * do clique: com o motor congelado o botão mostrava "Reiniciar"/"Ligar", o motor voltava um segundo
 * depois, o poll trocava pra "Desligar" e o mesmo clique DESLIGAVA o motor — parecia que ele morria
 * do nada, logo depois de voltar (visto duas vezes no daemon.log: `sem_resposta → ok` e `ok →
 * fechado` 1–2 s depois, sem crash nenhum).
 */

/** Rótulo trocado há menos que isso: o clique mirava o rótulo anterior, ignora. */
export const ROTULO_ESTAVEL_MS = 1000;

/**
 * @param {{ acao: "ligar" | "desligar" | "reiniciar" | "", desde: number }} mostrado
 *   ação que o botão exibe e desde quando (`Date.now()` da última troca de rótulo)
 * @param {number} agora
 * @param {{ doMago?: boolean }} [opts] clique no mago: nunca desliga (ele muda de lugar e de
 *   estado sozinho; desligar o motor é ação de botão, com rótulo à vista)
 * @returns {"ligar" | "desligar" | "reiniciar" | null} `null` = não faz nada
 */
export function decidirCliqueDoMotor(mostrado, agora, opts = {}) {
  const acao = mostrado?.acao || "";
  if (!acao) return null;
  if (agora - (mostrado.desde ?? 0) < ROTULO_ESTAVEL_MS) return null;
  if (acao === "desligar" && opts.doMago) return null;
  return acao;
}
