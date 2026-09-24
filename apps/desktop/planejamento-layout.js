/**
 * Layout do canvas da Tela de Planejamento — puro, sem DOM (testável com happy-dom ou sem nada).
 * Port de `layout.ts` do agent-code (Agent Manager), com as regras de `[[ref]]` de
 * `apps/daemon/src/planejamento.ts`.
 *
 * Fluxo HORIZONTAL: uma coluna por etapa do roteiro, na ordem, e uma coluna final "Sem etapa"
 * pra card sem etapa (ou com etapa que saiu do roteiro). Posição salva (`canvas.json`) sempre
 * ganha da calculada; card sem posição salva entra no FIM da coluna — abaixo de tudo que já
 * ocupa a faixa dela, inclusive card arrastado pra lá — e nunca cai em cima de outro.
 *
 * Arestas: sequência entre etapas seguidas, `links` explícitos e `[[Título]]`/`[[id]]` do corpo
 * (referência que já é link não repete; a que não resolve não vira seta).
 */

export const CARD_W = 248;
/** Altura reservada por card (o CSS corta título e prévia pra caber). */
export const CARD_H = 120;
export const HEADER_H = 56;
export const COL_GAP = 72;
export const ROW_GAP = 16;
export const HEADER_GAP = 28;
export const FIRST_CARD_Y = HEADER_H + HEADER_GAP;
/** Tem '_', que id de etapa ([a-z0-9-]) não aceita: nunca colide. */
export const SEM_ETAPA = "__sem-etapa";

/** Título normalizado: sem caixa, sem acento, espaço colapsado (mesma regra do daemon). */
export function normalizarTitulo(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Conteúdo de cada `[[...]]` do corpo, na ordem, sem repetição. */
export function extrairRefs(corpo) {
  const out = [];
  for (const m of String(corpo || "").matchAll(/\[\[([^[\]\n]{1,140})\]\]/g)) {
    const r = m[1].trim();
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Id do card que a referência aponta: id exato, depois título normalizado; ambíguo = null. */
export function resolverRef(ref, cards) {
  if (cards.some((c) => c.id === ref)) return ref;
  const alvo = normalizarTitulo(ref);
  const achados = cards.filter((c) => normalizarTitulo(c.titulo) === alvo);
  return achados.length === 1 ? achados[0].id : null;
}

/** Coluna do card: a etapa dele se ainda estiver no roteiro, senão "Sem etapa". */
export function colunaDoCard(card, etapas) {
  return card.etapa && etapas.some((e) => e.id === card.etapa) ? card.etapa : SEM_ETAPA;
}

/**
 * @param {{ roteiro: { etapas: {id:string,titulo:string,status:string}[] }, cards: any[], layout?: { posicoes?: Record<string,{x:number,y:number}> } }} plano
 * @param {Record<string, number>} [alturas] altura medida de cada card (a tela mede depois de pintar); sem medida = CARD_H
 */
export function calcularLayout(plano, alturas = {}) {
  const alt = (id) => (alturas[id] > 0 ? alturas[id] : CARD_H);
  const etapas = plano.roteiro?.etapas ?? [];
  const cards = plano.cards ?? [];
  const salvas = plano.layout?.posicoes ?? {};
  const temSemEtapa = cards.some((c) => colunaDoCard(c, etapas) === SEM_ETAPA);

  const colunas = etapas.map((e, i) => ({ id: e.id, titulo: e.titulo, status: e.status, indice: i, x: i * (CARD_W + COL_GAP), cardIds: [] }));
  if (temSemEtapa || !colunas.length) {
    colunas.push({ id: SEM_ETAPA, titulo: "Sem etapa", status: null, indice: colunas.length, x: colunas.length * (CARD_W + COL_GAP), cardIds: [] });
  }
  const porId = new Map(colunas.map((c) => [c.id, c]));
  for (const card of cards) porId.get(colunaDoCard(card, etapas))?.cardIds.push(card.id);

  /** @type {Record<string, {x:number,y:number}>} */
  const posicoes = {};
  const valida = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  for (const card of cards) if (valida(salvas[card.id])) posicoes[card.id] = { x: salvas[card.id].x, y: salvas[card.id].y };

  // fundo ocupado de cada faixa de coluna, contando cards salvos que caem nela
  const fundo = new Map(colunas.map((c) => [c.id, FIRST_CARD_Y - ROW_GAP]));
  const faixaDe = (x) => colunas.find((c) => x + CARD_W > c.x && x < c.x + CARD_W);
  for (const [id, p] of Object.entries(posicoes)) {
    const col = faixaDe(p.x);
    if (col) fundo.set(col.id, Math.max(fundo.get(col.id), p.y + alt(id)));
  }
  for (const col of colunas) {
    for (const id of col.cardIds) {
      if (posicoes[id]) continue;
      const y = fundo.get(col.id) + ROW_GAP;
      posicoes[id] = { x: col.x, y };
      fundo.set(col.id, y + alt(id));
    }
  }

  const arestas = [];
  for (let i = 0; i + 1 < etapas.length; i++) {
    arestas.push({ id: `seq:${etapas[i].id}>${etapas[i + 1].id}`, de: etapas[i].id, para: etapas[i + 1].id, tipo: "sequencia" });
  }
  const existe = new Set(cards.map((c) => c.id));
  for (const card of cards) {
    const ligados = new Set();
    for (const alvo of card.links ?? []) {
      if (!existe.has(alvo) || alvo === card.id) continue;
      ligados.add(alvo);
      arestas.push({ id: `link:${card.id}>${alvo}`, de: card.id, para: alvo, tipo: "ligacao" });
    }
    for (const ref of extrairRefs(card.corpo)) {
      const alvo = resolverRef(ref, cards);
      if (!alvo || alvo === card.id || ligados.has(alvo)) continue;
      ligados.add(alvo);
      arestas.push({ id: `ref:${card.id}>${alvo}`, de: card.id, para: alvo, tipo: "referencia" });
    }
  }

  let largura = colunas.length ? colunas.at(-1).x + CARD_W : CARD_W;
  let altura = FIRST_CARD_Y;
  for (const [id, p] of Object.entries(posicoes)) {
    largura = Math.max(largura, p.x + CARD_W);
    altura = Math.max(altura, p.y + alt(id));
  }
  return { colunas, posicoes, arestas, largura, altura, alturas: Object.fromEntries(cards.map((c) => [c.id, alt(c.id)])) };
}

/**
 * Caminho SVG de uma aresta entre dois retângulos. Destino à direita: sai pela borda direita e
 * entra pela esquerda (bezier horizontal). Mesma coluna ou atrás: sai por baixo/entra por cima
 * (ou o contrário), pra linha não atravessar o próprio card.
 */
export function caminhoDaAresta(a, b) {
  const ax2 = a.x + a.w;
  if (b.x >= ax2 + 8) {
    const x1 = ax2;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const d = Math.max(40, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + d} ${y1}, ${x2 - d} ${y2}, ${x2} ${y2}`;
  }
  if (b.x + b.w <= a.x - 8) {
    const x1 = a.x;
    const y1 = a.y + a.h / 2;
    const x2 = b.x + b.w;
    const y2 = b.y + b.h / 2;
    const d = Math.max(40, (x1 - x2) / 2);
    return `M ${x1} ${y1} C ${x1 - d} ${y1}, ${x2 + d} ${y2}, ${x2} ${y2}`;
  }
  const abaixo = b.y >= a.y;
  const x1 = a.x + a.w / 2;
  const y1 = abaixo ? a.y + a.h : a.y;
  const x2 = b.x + b.w / 2;
  const y2 = abaixo ? b.y : b.y + b.h;
  const d = Math.max(24, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + (abaixo ? d : -d)}, ${x2} ${y2 + (abaixo ? -d : d)}, ${x2} ${y2}`;
}

/** Próximo status no clique do roteiro: pendente → em andamento → concluída → pendente. */
export function proximoStatus(status) {
  return status === "pendente" ? "em_andamento" : status === "em_andamento" ? "concluida" : "pendente";
}

/**
 * O que mudou entre duas leituras do plano — é o que a tela anima (F5b). `proprios` tem o que
 * ESTA janela acabou de gravar (`card:<id>:<rev>`, `roteiro:<rev>`): eco da própria escrita não
 * anima, só o que veio de fora (o Agent Manager, outra janela).
 */
export function diffPlano(anterior, atual, proprios = new Set()) {
  const vazio = { etapasNovas: [], statusMudou: [], cardsNovos: [], cardsAlterados: [], arestasNovas: [] };
  if (!anterior || !atual) return vazio;
  const out = vazio;
  const roteiroProprio = proprios.has(`roteiro:${atual.roteiro?.rev}`);
  const etapasAntes = new Map((anterior.roteiro?.etapas ?? []).map((e) => [e.id, e]));
  if (!roteiroProprio) {
    for (const e of atual.roteiro?.etapas ?? []) {
      const antes = etapasAntes.get(e.id);
      if (!antes) out.etapasNovas.push(e.id);
      else if (antes.status !== e.status) out.statusMudou.push(e.id);
    }
  }
  const cardsAntes = new Map((anterior.cards ?? []).map((c) => [c.id, c]));
  for (const c of atual.cards ?? []) {
    if (proprios.has(`card:${c.id}:${c.rev}`)) continue;
    const antes = cardsAntes.get(c.id);
    if (!antes) out.cardsNovos.push(c.id);
    else if (antes.rev !== c.rev) out.cardsAlterados.push(c.id);
  }
  const arestasAntes = new Set(calcularLayout(anterior).arestas.map((a) => a.id));
  const novosOuDeFora = new Set([...out.cardsNovos, ...out.cardsAlterados, ...out.etapasNovas]);
  for (const a of calcularLayout(atual).arestas) {
    if (arestasAntes.has(a.id)) continue;
    // aresta nova de uma escrita própria (a pessoa ligou na tela) não anima
    if (a.tipo === "sequencia" ? !roteiroProprio : novosOuDeFora.has(a.de)) out.arestasNovas.push(a.id);
  }
  return out;
}
