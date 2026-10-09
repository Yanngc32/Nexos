/**
 * Torre de magia — LAZER com saídas da mesa (camada pura), como o `runFree` + `claim` do
 * escritório do agent-code.
 *
 * Mago livre (ocioso, sem pendência) sorteia, de tempos em tempos, um lugar com vaga — janela
 * da torre, estante da Biblioteca, caldeirão de chá do Porão, banco dos cristais — vai até lá,
 * fica 6–25 s e volta. Lugares têm teto (claim/release) e fila no caldeirão. Pedido novo,
 * pergunta ou sem mana no meio: larga tudo e VOLTA CORRENDO pra mesa. Fica abaixo do convívio e
 * das idas na prioridade: quem já está em outra coisa não sai pra lazer.
 */

export const LUGARES = {
  janela: { vagas: 2, pose: "olhando-janela" },
  estante: { vagas: 3, pose: "lendo-estante" },
  caldeirao: { vagas: 1, fila: 2, pose: "bebendo-cha", poseFila: "esperando-de-pe", preparo: 2_400 },
  banco: { vagas: 2, pose: "cochilando-banco" },
};
export const SORTEIO_MIN_MS = 20_000;
export const SORTEIO_MAX_MS = 40_000;
export const FICA_MIN_MS = 6_000;
export const FICA_MAX_MS = 25_000;
export const IDA_MS = 1_800;
export const VOLTA_CORRENDO_MS = 800;

const LIVRE = new Set(["ocioso", "terminou", "erro"]);

export function lazerNovo() {
  return {
    /** chave → `{ lugar, vaga, desde, ate, correndoDesde }`. */
    ativas: new Map(),
    proximo: new Map(),
    ultimo: new Map(),
  };
}

function livre(m) {
  return LIVRE.has(m.estado) && !m.comemorando;
}

/** Vagas tomadas por lugar (quem está correndo de volta já largou a vaga). */
function ocupacao(l) {
  const n = new Map();
  for (const a of l.ativas.values()) if (!a.correndoDesde) n.set(a.lugar, (n.get(a.lugar) ?? 0) + 1);
  return n;
}

function proximoSorteio(l, chave, agora, sorteio) {
  l.proximo.set(chave, agora + SORTEIO_MIN_MS + Math.floor(sorteio() * (SORTEIO_MAX_MS - SORTEIO_MIN_MS)));
}

/**
 * Avança. `ocupados` = chaves já em convívio/ida/entrega/fila (não saem pra lazer).
 * @returns Map chave → `{ lugar, vaga, fase: "indo"|"la"|"fila"|"voltando"|"correndo", progresso, pose }`
 */
export function avancarLazer(l, { magos, agora, sorteio = Math.random, reduzido = false, ocupados = new Set() }) {
  const porChave = new Map(magos.map((m) => [m.chave, m]));

  // 1. quem deixou de estar livre volta correndo; quem venceu o tempo volta andando; quem sumiu some
  for (const [chave, a] of [...l.ativas]) {
    const m = porChave.get(chave);
    if (!m) {
      l.ativas.delete(chave);
      continue;
    }
    if (a.correndoDesde) {
      if (agora - a.correndoDesde >= VOLTA_CORRENDO_MS) l.ativas.delete(chave);
      continue;
    }
    if (!livre(m)) {
      a.correndoDesde = agora;
      continue;
    }
    if (a.voltandoDesde) {
      if (agora - a.voltandoDesde >= IDA_MS) l.ativas.delete(chave);
      continue;
    }
    if (agora >= a.ate) a.voltandoDesde = agora;
  }

  // 2. sorteio pra quem está livre, sem nada, na vez
  if (!reduzido) {
    for (const m of magos) {
      if (!livre(m) || l.ativas.has(m.chave) || ocupados.has(m.chave)) continue;
      const quando = l.proximo.get(m.chave);
      if (quando === undefined) {
        proximoSorteio(l, m.chave, agora, sorteio);
        continue;
      }
      if (quando > agora) continue;
      proximoSorteio(l, m.chave, agora, sorteio);
      const ocup = ocupacao(l);
      const opcoes = Object.entries(LUGARES).filter(([nome, def]) => nome !== l.ultimo.get(m.chave) && (ocup.get(nome) ?? 0) < def.vagas + (def.fila ?? 0));
      if (!opcoes.length) continue;
      const [lugar, def] = opcoes[Math.floor(sorteio() * opcoes.length)];
      const vaga = ocup.get(lugar) ?? 0;
      const fica = FICA_MIN_MS + Math.floor(sorteio() * (FICA_MAX_MS - FICA_MIN_MS));
      l.ativas.set(m.chave, { lugar, vaga, desde: agora, ate: agora + IDA_MS + fica + (vaga >= def.vagas ? def.preparo ?? 0 : 0), voltandoDesde: 0, correndoDesde: 0 });
      l.ultimo.set(m.chave, lugar);
    }
  }

  // 3. saída
  const out = new Map();
  for (const [chave, a] of l.ativas) {
    const def = LUGARES[a.lugar];
    if (a.correndoDesde) {
      out.set(chave, { lugar: a.lugar, vaga: a.vaga, fase: "correndo", progresso: (agora - a.correndoDesde) / VOLTA_CORRENDO_MS, pose: "correndo" });
      continue;
    }
    if (a.voltandoDesde) {
      out.set(chave, { lugar: a.lugar, vaga: a.vaga, fase: "voltando", progresso: (agora - a.voltandoDesde) / IDA_MS, pose: "andando" });
      continue;
    }
    const t = agora - a.desde;
    if (t < IDA_MS) {
      out.set(chave, { lugar: a.lugar, vaga: a.vaga, fase: "indo", progresso: t / IDA_MS, pose: "andando" });
      continue;
    }
    // caldeirão: quem não tem vaga fica na fila; quem tem, serve e bebe
    const naFila = a.vaga >= def.vagas;
    const pose = naFila ? def.poseFila : def.preparo && t < IDA_MS + def.preparo ? "servindo-cha" : def.pose;
    out.set(chave, { lugar: a.lugar, vaga: a.vaga, fase: naFila ? "fila" : "la", progresso: 1, pose });
  }
  return out;
}

export function esvaziarLazer(l) {
  l.ativas.clear();
}
