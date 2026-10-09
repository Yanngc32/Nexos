/**
 * Torre de magia — IDAS AOS ANDARES pela ferramenta (camada pura).
 *
 * Equivalente das idas à estante do escritório do agent-code: quando a conversa usa uma
 * ferramenta de um andar (memória → Biblioteca, mock/DS/vídeo → Ateliê, plano → Observatório),
 * o PRÓPRIO mago dela levanta, sobe/desce a escada, faz o gesto enquanto a sequência de chamadas
 * durar (+ LINGER) e volta pra mesa. Só fases e progresso; coordenadas ficam na pintura.
 */

export const DESLOCAMENTO_MS = 1_800;
export const LINGER_MS = 3_000;
/** Estado em que o mago larga a ida e volta na hora. */
const INTERROMPE = new Set(["esperando", "sem-mana", "erro"]);
const POSE_DO_ANDAR = { biblioteca: "lendo-estante", atelie: "pintando", observatorio: "olhando-telescopio" };
const POSE_ESCREVENDO = { biblioteca: "escrevendo-estante" };

export function idasNovo() {
  return {
    /** chave do mago → `{ andar, desde, ultimoSinal, voltandoDesde, gravando }`. */
    ativas: new Map(),
  };
}

/**
 * Avança. `sinais` = `feed.idasRecentes` (`{ threadId, andar, gravando, em }`).
 * @returns Map chave → `{ andar, fase: "indo"|"la"|"voltando", progresso, pose }`
 */
export function avancarIdas(i, { magos, sinais = [], agora, reduzido = false, bloqueado = false }) {
  const porChave = new Map(magos.map((m) => [m.chave, m]));
  // sinal mais recente por conversa (`bloqueado` = apagão: ninguém começa ida e quem está fora volta)
  const recente = new Map();
  for (const s of bloqueado ? [] : sinais) {
    if (agora - s.em > LINGER_MS || s.em > agora) continue;
    const chave = `conv:${s.threadId}`;
    const r = recente.get(chave);
    if (!r || s.em > r.em) recente.set(chave, s);
  }

  for (const [chave, s] of recente) {
    const m = porChave.get(chave);
    if (!m || INTERROMPE.has(m.estado)) continue;
    const a = i.ativas.get(chave);
    if (a && a.andar === s.andar && !a.voltandoDesde) {
      a.ultimoSinal = Math.max(a.ultimoSinal, s.em);
      a.gravando = Boolean(s.gravando);
      continue;
    }
    if (a && a.andar !== s.andar && !a.voltandoDesde) {
      // andar diferente no meio: termina esta e vai pra outra no tique seguinte
      a.voltandoDesde = agora;
      continue;
    }
    if (a) continue; // voltando: espera chegar na mesa
    i.ativas.set(chave, { andar: s.andar, desde: agora, ultimoSinal: s.em, voltandoDesde: 0, gravando: Boolean(s.gravando) });
  }

  const out = new Map();
  for (const [chave, a] of [...i.ativas]) {
    const m = porChave.get(chave);
    if (!m) {
      i.ativas.delete(chave);
      continue;
    }
    if (!a.voltandoDesde && (bloqueado || INTERROMPE.has(m.estado) || agora - a.ultimoSinal > LINGER_MS)) a.voltandoDesde = agora;
    if (a.voltandoDesde) {
      const t = agora - a.voltandoDesde;
      if (t >= DESLOCAMENTO_MS || reduzido) {
        i.ativas.delete(chave);
        continue;
      }
      out.set(chave, { andar: a.andar, fase: "voltando", progresso: t / DESLOCAMENTO_MS, pose: "andando" });
      continue;
    }
    const t = agora - a.desde;
    const pose = (a.gravando && POSE_ESCREVENDO[a.andar]) || POSE_DO_ANDAR[a.andar] || "andando";
    if (reduzido || t >= DESLOCAMENTO_MS) out.set(chave, { andar: a.andar, fase: "la", progresso: 1, pose });
    else out.set(chave, { andar: a.andar, fase: "indo", progresso: t / DESLOCAMENTO_MS, pose: "andando" });
  }
  return out;
}

export function esvaziarIdas(i) {
  i.ativas.clear();
}
