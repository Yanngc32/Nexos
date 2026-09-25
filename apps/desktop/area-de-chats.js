/**
 * Regras da área de chats (até 3 conversas na tela). Puro: o renderer mede, chama e desenha.
 * Spec: card "Tela: área de chats" do plano `plano-20260925-1502`.
 */

/** Cada chat mantém um SSE e um log vivo; 3 cabe legível e o planejamento usa 2. */
export const MAX_CHATS = 3;
/** Largura mínima de um chat aberto (px). */
export const LARGURA_MIN_CHAT = 320;
/** Abaixo disto (largura útil da área) só um chat fica aberto; os outros viram chip. */
export const LARGURA_UM_CHAT = 760;
/** Faixa da borda (fração da largura do chat) em que soltar divide em vez de substituir. */
export const FAIXA_DA_BORDA = 0.25;

/**
 * O que soltar uma conversa em cima de um chat faz. `x` é a posição do cursor dentro do chat
 * (0 = borda esquerda), `largura` a do chat, `total` quantos chats estão na tela.
 * Com o máximo aberto não há divisão: soltar substitui o chat embaixo do cursor.
 */
export function alvoDoSoltar({ total, x, largura }) {
  if (total >= MAX_CHATS || !(largura > 0)) return "substituir";
  if (x < largura * FAIXA_DA_BORDA) return "esquerda";
  if (x > largura * (1 - FAIXA_DA_BORDA)) return "direita";
  return "substituir";
}

/**
 * "Abrir ao lado" com a área cheia: sai o chat que está há mais tempo sem foco (nunca o em foco).
 * `focadoEm` = quando cada chat teve foco pela última vez.
 */
export function quemSaiPraAbrir(chats, foco) {
  const fora = chats.filter((c) => c !== foco);
  if (!fora.length) return null;
  return fora.reduce((a, b) => ((b.focadoEm ?? 0) < (a.focadoEm ?? 0) ? b : a));
}

/**
 * Quais chats ficam abertos (colunas) e quais viram chip. Minimizado vira chip; o que não cabe
 * na largura (`LARGURA_MIN_CHAT` cada) também, a partir do fim — o em foco sempre fica aberto
 * se não estiver minimizado. Abaixo de `LARGURA_UM_CHAT`, só um aberto. `maximizado` = só ele aberto.
 */
export function distribuir({ chats, foco, largura, maximizado = null }) {
  // maximizado ocupa a área toda; os outros viram chip sem perder o "minimizado" de cada um
  const candidatos = maximizado && chats.includes(maximizado) && !maximizado.minimizado ? [maximizado] : chats.filter((c) => !c.minimizado);
  let cabem = largura > 0 ? Math.max(1, Math.floor(largura / LARGURA_MIN_CHAT)) : candidatos.length;
  if (largura > 0 && largura < LARGURA_UM_CHAT) cabem = 1;
  let abertos = candidatos;
  if (candidatos.length > cabem) {
    const primeiro = candidatos.includes(foco) ? [foco] : [];
    const resto = candidatos.filter((c) => c !== foco).slice(0, cabem - primeiro.length);
    const ficam = new Set([...primeiro, ...resto]);
    abertos = candidatos.filter((c) => ficam.has(c));
  }
  return { abertos, chips: chats.filter((c) => !abertos.includes(c)) };
}

/** "2 min", "40 s", "1 h 5 min" — tempo curto pro pill de rodando. */
export function tempoCurto(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/**
 * Estado que o cabeçalho e o chip do chat mostram. Ordem: pergunta esperando (não pode ficar
 * parada sem ninguém ver) > erro do turno > rodando > terminou sem ser visto > nada.
 * `erro` é o texto curto já pronto ("Sem cota", "Erro no turno", "Precisa de login").
 */
export function pillDoChat({ perguntas = 0, erro = "", rodando = false, desde = 0, terminou = false, agora = Date.now() }) {
  if (perguntas > 0) return { tipo: "pergunta", texto: "Pergunta esperando", contador: perguntas };
  if (erro) return { tipo: "erro", texto: erro };
  if (rodando) return { tipo: "rodando", texto: desde ? `Rodando · ${tempoCurto(agora - desde)}` : "Rodando" };
  if (terminou) return { tipo: "terminou", texto: "Terminou" };
  return null;
}

/** Rótulo acessível do chip: "Nome, pergunta esperando". */
export function rotuloDoChip(titulo, pill) {
  return pill ? `${titulo}, ${pill.texto.toLowerCase()}` : titulo;
}

/** Nova ordem ao mover `chat` pra antes/depois de `alvo` (arrastar o cabeçalho). */
export function reordenar(chats, chat, alvo, lado) {
  if (chat === alvo || !chats.includes(chat) || !chats.includes(alvo)) return chats.slice();
  const sem = chats.filter((c) => c !== chat);
  const i = sem.indexOf(alvo) + (lado === "direita" ? 1 : 0);
  sem.splice(i, 0, chat);
  return sem;
}

/**
 * Divisor entre dois chats vizinhos: novo peso (`flex-grow`) de cada um quando o divisor anda
 * `dx` px. Mantém a soma dos pesos e respeita `LARGURA_MIN_CHAT` dos dois lados.
 */
export function arrastarDivisor({ pesoA, pesoB, larguraA, larguraB, dx }) {
  const total = larguraA + larguraB;
  if (!(total > 0)) return { pesoA, pesoB };
  const min = Math.min(LARGURA_MIN_CHAT, total / 2);
  const novaA = Math.max(min, Math.min(total - min, larguraA + dx));
  const soma = pesoA + pesoB;
  return { pesoA: (soma * novaA) / total, pesoB: (soma * (total - novaA)) / total };
}

/**
 * Retrato da área pra lembrar entre sessões: conversas na ordem (só as que têm conversa), qual
 * estava em foco, minimizado e peso da largura de cada uma.
 */
export function retratoDaArea(chats, foco) {
  const lista = chats.filter((c) => c.threadId);
  return {
    chats: lista.map((c) => ({ threadId: c.threadId, projeto: c.projeto ?? null, minimizado: Boolean(c.minimizado), peso: pesoValido(c.peso) })),
    foco: Math.max(0, lista.indexOf(foco)),
  };
}

const pesoValido = (p) => (Number.isFinite(p) && p > 0.05 && p < 20 ? Math.round(p * 1000) / 1000 : 1);

/** Lê o retrato salvo (texto do localStorage); qualquer coisa estranha vira `null` ou é podada. */
export function lerRetratoDaArea(texto) {
  let raw;
  try {
    raw = JSON.parse(texto || "null");
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.chats)) return null;
  const vistos = new Set();
  const chats = [];
  for (const c of raw.chats) {
    if (!c || typeof c.threadId !== "string" || !c.threadId || vistos.has(c.threadId)) continue;
    vistos.add(c.threadId);
    chats.push({
      threadId: c.threadId,
      projeto: typeof c.projeto === "string" ? c.projeto : null,
      minimizado: c.minimizado === true,
      peso: pesoValido(c.peso),
    });
    if (chats.length === MAX_CHATS) break;
  }
  if (!chats.length) return null;
  const foco = Number.isInteger(raw.foco) && raw.foco >= 0 && raw.foco < chats.length ? raw.foco : 0;
  return { chats, foco };
}

/** Layout do plano em tela cheia (por plano): altura da faixa, minimizados e pesos de Manager/Implementação. */
export function retratoDoPlano({ faixa = null, manager, impl, lateral = false }) {
  return {
    faixa: Number.isFinite(faixa) && faixa > 0 ? Math.round(faixa) : null,
    minimizados: [Boolean(manager.minimizado), Boolean(impl.minimizado)],
    pesos: [pesoValido(manager.peso), pesoValido(impl.peso)],
    lateral: Boolean(lateral),
  };
}

export function lerRetratoDoPlano(texto) {
  let raw;
  try {
    raw = JSON.parse(texto || "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const par = (v, f) => (Array.isArray(v) && v.length === 2 ? v.map(f) : null);
  return {
    faixa: Number.isFinite(raw.faixa) && raw.faixa > 0 ? Math.round(raw.faixa) : null,
    minimizados: par(raw.minimizados, (x) => x === true) ?? [false, false],
    pesos: par(raw.pesos, pesoValido) ?? [1, 1],
    lateral: raw.lateral === true,
  };
}
