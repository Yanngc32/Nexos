/**
 * Torre de magia — coreografia do MURAL do Quadro (pura, sem DOM nem relógio próprio).
 *
 * Adaptada do `boardChoreo.ts` do escritório do agent-code. Cada mudança no Quadro vira uma
 * "viagem" do mago da conversa que fez a mudança: ele levanta, sobe até o Observatório, faz o
 * gesto e volta; o pergaminho só muda de coluna QUANDO ELE CHEGA. Mudança feita pela pessoa na
 * tela (ou sem dono): ninguém anda, o pergaminho desliza sozinho com o selo "Você".
 *
 * Travas (as do agent-code):
 * - até 4 mudanças por viagem (2 se o mago está no meio de um turno — ele tem pressa); o que
 *   excede aplica direto e vira um balão "+N mudanças";
 * - atraso máximo de 15 s entre a mudança real e o mural: se a viagem não cabe, desliza sozinho;
 * - um pergaminho nunca é movido por dois magos ao mesmo tempo: o segundo espera;
 * - aba oculta ou ao voltar dela: `esvaziar` aplica tudo direto, sem animação.
 *
 * O mural em si (`estado.tarefas`) é a lista de pergaminhos com a coluna em que estão PINTADOS —
 * pode ficar atrás do Quadro real por no máximo LAG_MS.
 */

export const LAG_MS = 15_000;
export const PASSOS_POR_VIAGEM = 4;
export const PASSOS_COM_PRESSA = 2;
/** Tempos da viagem: subir até o mural, cada gesto, voltar. */
export const SUBIDA_MS = 1_800;
export const GESTO_MS = 700;
export const DESCIDA_MS = 1_800;
/** Quanto o pergaminho que desliza sozinho leva. */
export const DESLIZE_MS = 600;

export function muralNovo() {
  return {
    /** pergaminhos como estão pintados: `[{ id, colunaId, titulo, fita, alta, carimbo }]`. */
    tarefas: [],
    colunas: [],
    colunaFinal: "",
    /** mudanças ainda não pintadas: `[{ ev, autor, em }]`. */
    fila: [],
    /** viagens em andamento, por mago: chave → `{ chave, passos, fase, desde, ate, pergaminhos: Set }`. */
    viagens: new Map(),
    /** pergaminhos deslizando sozinhos: `[{ id, de, para, desde, ate, selo }]`. */
    deslizes: [],
    /** balões "+N mudanças" por mago: chave → `{ n, ate }`. */
    baloes: new Map(),
    /** pergaminho em viagem → chave do mago que o leva. */
    travados: new Map(),
  };
}

/** Carrega o Quadro real (consulta): colunas, tarefas e qual é a coluna final. */
export function carregarQuadro(m, quadro, tarefas) {
  const cols = [...(quadro?.colunas ?? [])].sort((a, b) => a.ordem - b.ordem);
  m.colunas = cols.map((c) => ({ id: c.id, nome: c.nome }));
  m.colunaFinal = cols.at(-1)?.id ?? "";
  const final = m.colunaFinal;
  const idsTarefas = new Set((tarefas ?? []).map((t) => t.id));
  const pendentes = (t) => (t.dependeDe ?? []).some((id) => {
    const dep = (tarefas ?? []).find((x) => x.id === id);
    return dep && dep.colunaId !== final;
  });
  m.tarefas = (tarefas ?? []).map((t) => ({
    id: t.id,
    colunaId: t.colunaId,
    titulo: t.titulo ?? "",
    fita: pendentes(t),
    alta: t.prioridade === "alta" || t.prioridade === "urgente",
    carimbo: t.colunaId === final,
    ordem: t.ordem ?? 0,
  }));
  // tarefa que sumiu do Quadro não pode ficar presa numa viagem
  for (const id of [...m.travados.keys()]) if (!idsTarefas.has(id)) m.travados.delete(id);
}

/**
 * Chegou um evento do SSE do Quadro. `autor`: `{ tipo: "voce" | "sozinho" | "conversa", threadId }`
 * (ver `autorDaMudanca` do feed). Só enfileira; `avancar` decide quem leva.
 */
export function receberMudanca(m, ev, autor, agora) {
  if (!ev || ev.tipo === "colunas") return;
  m.fila.push({ ev, autor, em: agora });
}

function aplicarNoMural(m, ev) {
  if (ev.tipo === "apagou") {
    m.tarefas = m.tarefas.filter((t) => t.id !== ev.tarefaId);
    return;
  }
  const atual = m.tarefas.find((t) => t.id === ev.tarefaId);
  if (ev.tipo === "criou" && !atual) {
    m.tarefas.push({ id: ev.tarefaId, colunaId: ev.para, titulo: ev.titulo ?? "", fita: false, alta: false, carimbo: ev.para === m.colunaFinal, ordem: 1e9 });
    return;
  }
  if (!atual) return;
  if (ev.para) atual.colunaId = ev.para;
  if (ev.titulo) atual.titulo = ev.titulo;
  atual.carimbo = atual.colunaId === m.colunaFinal;
}

/** Gesto do mago no mural por tipo de mudança (nome da animação). */
export function gestoDe(m, ev) {
  if (ev.tipo === "criou") return "escreve-e-prega";
  if (ev.tipo === "moveu") return ev.para === m.colunaFinal ? "prega-e-carimba" : "despega-e-prega";
  if (ev.tipo === "apagou") return "despega";
  return "aponta";
}

/**
 * Fase da viagem no tempo: `subindo` → `no-mural` (um gesto por passo) → `descendo` → fim.
 */
export function faseDaViagem(v, agora) {
  const t = agora - v.desde;
  if (t < SUBIDA_MS) return { fase: "subindo", progresso: t / SUBIDA_MS };
  const gestos = v.passos.length * GESTO_MS;
  if (t < SUBIDA_MS + gestos) return { fase: "no-mural", passo: Math.min(v.passos.length - 1, Math.floor((t - SUBIDA_MS) / GESTO_MS)) };
  if (t < SUBIDA_MS + gestos + DESCIDA_MS) return { fase: "descendo", progresso: (t - SUBIDA_MS - gestos) / DESCIDA_MS };
  return { fase: "fim" };
}

function deslizar(m, item, agora, selo) {
  const ev = item.ev;
  const de = m.tarefas.find((t) => t.id === ev.tarefaId)?.colunaId ?? ev.de ?? "";
  aplicarNoMural(m, ev);
  if (ev.tipo === "moveu" || ev.tipo === "criou") m.deslizes.push({ id: ev.tarefaId, de, para: ev.para, desde: agora, ate: agora + DESLIZE_MS, selo });
}

/**
 * Avança a coreografia. `disponiveis`: chave do mago → `{ comPressa }` pra quem pode andar agora
 * (na torre aberta, não esperando você, com mana). Devolve o que mudou pra pintura.
 * @param visivel aba visível; falso = aplica tudo direto (sem animação)
 */
export function avancar(m, agora, disponiveis, visivel = true) {
  // 1. viagens que chegaram no mural aplicam os passos; as que terminaram somem
  for (const [chave, v] of [...m.viagens]) {
    const f = faseDaViagem(v, agora);
    if (f.fase === "no-mural" || f.fase === "descendo" || f.fase === "fim") {
      const ate = f.fase === "no-mural" ? f.passo + 1 : v.passos.length;
      for (let i = v.aplicados; i < ate; i++) {
        aplicarNoMural(m, v.passos[i].ev);
        m.travados.delete(v.passos[i].ev.tarefaId);
      }
      v.aplicados = Math.max(v.aplicados, ate);
    }
    if (f.fase === "fim") m.viagens.delete(chave);
  }
  m.deslizes = m.deslizes.filter((d) => d.ate > agora);
  for (const [k, b] of [...m.baloes]) if (b.ate <= agora) m.baloes.delete(k);
  if (!m.fila.length) return;

  if (!visivel) {
    esvaziar(m);
    return;
  }

  // 2. decide quem leva cada mudança pendente
  const porMago = new Map();
  const sobra = [];
  for (const item of m.fila) {
    const { ev, autor, em } = item;
    const chave = autor?.tipo === "conversa" ? `conv:${autor.threadId}` : "";
    const dono = chave && disponiveis?.get?.(chave);
    const cabe = agora - em + SUBIDA_MS + GESTO_MS <= LAG_MS;
    const travadoPorOutro = m.travados.has(ev.tarefaId) && m.travados.get(ev.tarefaId) !== chave;
    if (!dono || !cabe) {
      if (travadoPorOutro) {
        sobra.push(item); // espera o outro mago voltar
        continue;
      }
      deslizar(m, item, agora, autor?.tipo === "voce" ? "voce" : "");
      continue;
    }
    if (travadoPorOutro) {
      sobra.push(item);
      continue;
    }
    if (!porMago.has(chave)) porMago.set(chave, { comPressa: Boolean(dono.comPressa), itens: [] });
    porMago.get(chave).itens.push(item);
  }
  m.fila = sobra;

  // 3. monta a viagem de cada mago (ou soma à que está em curso se ainda está subindo)
  for (const [chave, { comPressa, itens }] of porMago) {
    const teto = comPressa ? PASSOS_COM_PRESSA : PASSOS_POR_VIAGEM;
    const emCurso = m.viagens.get(chave);
    if (emCurso) {
      // já saiu: o que chegar agora não cabe nesta viagem — aplica direto e conta no balão
      const f = faseDaViagem(emCurso, agora);
      const vaga = f.fase === "subindo" ? teto - emCurso.passos.length : 0;
      const entram = itens.slice(0, Math.max(0, vaga));
      for (const it of entram) {
        emCurso.passos.push({ ev: it.ev, gesto: gestoDe(m, it.ev) });
        m.travados.set(it.ev.tarefaId, chave);
      }
      const resto = itens.slice(entram.length);
      for (const it of resto) deslizar(m, it, agora, "");
      if (resto.length) somarBalao(m, chave, resto.length, agora);
      continue;
    }
    const passos = itens.slice(0, teto).map((it) => ({ ev: it.ev, gesto: gestoDe(m, it.ev) }));
    for (const p of passos) m.travados.set(p.ev.tarefaId, chave);
    m.viagens.set(chave, { chave, passos, desde: agora, aplicados: 0 });
    const resto = itens.slice(teto);
    for (const it of resto) deslizar(m, it, agora, "");
    if (resto.length) somarBalao(m, chave, resto.length, agora);
  }
}

function somarBalao(m, chave, n, agora) {
  const b = m.baloes.get(chave) ?? { n: 0, ate: 0 };
  b.n += n;
  b.ate = agora + 4_000;
  m.baloes.set(chave, b);
}

/** Aplica tudo direto, sem animação (aba oculta / ao voltar dela). */
export function esvaziar(m) {
  for (const v of m.viagens.values()) for (let i = v.aplicados; i < v.passos.length; i++) aplicarNoMural(m, v.passos[i].ev);
  m.viagens.clear();
  for (const item of m.fila) aplicarNoMural(m, item.ev);
  m.fila = [];
  m.deslizes = [];
  m.baloes.clear();
  m.travados.clear();
}

/** Texto do balão "+N mudanças". */
export function textoDoBalao(n) {
  return `+${n} ${n === 1 ? "mudança" : "mudanças"}`;
}
