/**
 * Torre de magia — ENTREGAS: quem traz a informação anda até quem a recebe (camada pura).
 *
 * Toda troca REAL de informação entre personagens vira uma viagem com pergaminho na mão:
 * - explorador volta da dungeon (subagente `Agent`/`Task` ou time via `nexo_delegar` terminou):
 *   sobe a escada, anda até a mesa do mago que o mandou, entrega o pergaminho (rasgado, se deu
 *   erro) e some; o mago lê por ~1,8 s e volta ao que fazia (com erro, encolhe os ombros);
 * - (o astrônomo descendo pro Salão no envio do plano e as idas ao mural já são viagens assim).
 *
 * Só fases e progresso: as coordenadas (escada, mesa) ficam com a pintura. Primeiro retrato
 * não gera entrega (vem dos eventos, que já respeitam isso).
 */

export const SUBIDA_MS = 1_500;
export const CAMINHADA_MS = 1_200;
export const ENTREGA_MS = 800;
export const LEITURA_MS = 1_800;
export const SAIDA_MS = 900;
/** Do "voltou" até o explorador sumir. O feed precisa segurar a chamada por pelo menos isto. */
export const ENTREGA_TOTAL_MS = SUBIDA_MS + CAMINHADA_MS + ENTREGA_MS + SAIDA_MS;

export function entregasNovo() {
  return {
    /** portador (chave do explorador) → `{ portador, destino, ok, desde }`. */
    ativas: new Map(),
    /** destino (chave do mago) → `{ ate, ok }`: lendo o pergaminho que acabou de receber. */
    leituras: new Map(),
  };
}

/** Eventos da camada 4: `voltou` abre uma entrega do explorador pro pai. */
export function aplicarEventosNasEntregas(e, eventos, agora) {
  for (const ev of eventos ?? []) {
    if (ev.tipo !== "voltou" || !ev.explorador || !ev.chave) continue;
    if (e.ativas.has(ev.explorador)) continue;
    e.ativas.set(ev.explorador, { portador: ev.explorador, destino: ev.chave, ok: ev.ok !== false, desde: agora });
  }
}

/** Fase da entrega no tempo. */
export function faseDaEntrega(ent, agora) {
  const t = agora - ent.desde;
  if (t < SUBIDA_MS) return { fase: "subindo", progresso: t / SUBIDA_MS };
  if (t < SUBIDA_MS + CAMINHADA_MS) return { fase: "andando", progresso: (t - SUBIDA_MS) / CAMINHADA_MS };
  if (t < SUBIDA_MS + CAMINHADA_MS + ENTREGA_MS) return { fase: "entregando", progresso: (t - SUBIDA_MS - CAMINHADA_MS) / ENTREGA_MS };
  if (t < ENTREGA_TOTAL_MS) return { fase: "saindo", progresso: (t - SUBIDA_MS - CAMINHADA_MS - ENTREGA_MS) / SAIDA_MS };
  return { fase: "fim", progresso: 1 };
}

/**
 * Avança. `presentes` = chaves ainda na torre (destino que sumiu cancela a entrega).
 * @returns `{ portadores: Map portador → { destino, fase, progresso, pose, carga }, leitores: Map destino → { pose, ok } }`
 */
export function avancarEntregas(e, agora, presentes) {
  const portadores = new Map();
  for (const [chave, ent] of [...e.ativas]) {
    const f = faseDaEntrega(ent, agora);
    if (f.fase === "fim" || (presentes && !presentes.has(ent.destino))) {
      e.ativas.delete(chave);
      continue;
    }
    // no momento da entrega o destino começa a ler
    if (f.fase === "entregando" && !e.leituras.has(ent.destino)) {
      e.leituras.set(ent.destino, { ate: agora + ENTREGA_MS + LEITURA_MS, ok: ent.ok });
    }
    const carga = ent.ok ? "pergaminho" : "pergaminhoRasgado";
    const pose =
      f.fase === "subindo" ? "subindo-com-pergaminho" : f.fase === "andando" ? "andando-com-pergaminho" : f.fase === "entregando" ? "entregando" : "andando";
    portadores.set(chave, { destino: ent.destino, fase: f.fase, progresso: f.progresso, pose, carga, ok: ent.ok });
  }
  const leitores = new Map();
  for (const [destino, l] of [...e.leituras]) {
    if (l.ate <= agora || (presentes && !presentes.has(destino))) {
      e.leituras.delete(destino);
      continue;
    }
    leitores.set(destino, { pose: l.ok ? "lendo-entrega" : "lendo-entrega-ruim", ok: l.ok });
  }
  return { portadores, leitores };
}

/** Aba oculta / voltou dela: aplica tudo direto (ninguém reencena a viagem). */
export function esvaziarEntregas(e) {
  e.ativas.clear();
  e.leituras.clear();
}
