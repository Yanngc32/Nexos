/**
 * Torre de magia — MANA: a fila nos cristais e o apagão da torre (camada pura).
 *
 * Equivalente da fila do café e do apagão/festa do escritório do agent-code:
 * - mago sem mana (conta no limite) e sem tarefa vai pros cristais: 4 lugares (2 no banco, 2 de
 *   pé atrás), por ordem de chegada; quem está na frente avança quando abre vaga; quando a mana
 *   volta, levanta num pulo e volta correndo pra mesa;
 * - TODAS as contas no limite = apagão: luzes caem, susto, festa com papéis sorteados por
 *   semente (1 tocha com 3+ magos, o resto dança). Qualquer conta de volta = luzes voltam e todo
 *   mundo corre pra mesa.
 */
import { sorteioDe } from "./acaso.js";

export const LUGARES = ["banco-0", "banco-1", "pe-0", "pe-1"];
export const APAGANDO_MS = 1_500;
export const ACENDENDO_MS = 2_000;
export const VOLTA_MS = 6_000;
export const VOLTA_CORRENDO_MS = 800;

export function manaNovo() {
  return {
    /** chave → `{ desde }` (ordem de chegada). */
    fila: new Map(),
    /** `{ desde, papeis: Map chave → "tocha"|"danca", semente, susto }` ou null. */
    apagao: null,
    /** quando o último apagão acabou (luzes voltando, magos correndo). */
    acabouEm: 0,
    /** chaves que acabaram de sair da fila (pra pintura mandar correr): zerado a cada tique. */
    voltaram: [],
    primeiroRetrato: true,
  };
}

/** Apagado = conta no limite (ou bloqueada); `semDado` não conta como limite. */
export function contaApagada(c) {
  return Boolean(c) && !c.semDado && (c.bloqueada || c.uso >= 1);
}

export function todasApagadas(contas) {
  const lista = Array.isArray(contas) ? contas.filter((c) => c && !c.semDado) : [];
  return lista.length > 0 && lista.every(contaApagada);
}

function papeisDe(magos, semente) {
  const s = sorteioDe(`apagao:${semente}`);
  const chaves = magos.map((m) => m.chave).sort();
  const papeis = new Map(chaves.map((k) => [k, "danca"]));
  if (chaves.length >= 3) papeis.set(chaves[Math.floor(s() * chaves.length)], "tocha");
  return papeis;
}

/**
 * Avança.
 * @returns `{ fila: Map chave → { lugar, indice, pose }, voltaram: chave[], apagao: null | { fase, progresso, papeis, pose: Map },
 *   luzes: 0..1 (1 = acesas), acendendo: bool }`
 */
export function avancarMana(m, { magos, contas, agora }) {
  const porChave = new Map(magos.map((x) => [x.chave, x]));
  const voltaram = [];

  // ---- fila nos cristais ----
  for (const [chave] of [...m.fila]) {
    const x = porChave.get(chave);
    if (!x || x.estado !== "sem-mana") {
      m.fila.delete(chave);
      if (x) voltaram.push(chave);
    }
  }
  for (const x of magos) {
    if (x.estado === "sem-mana" && !m.fila.has(x.chave)) m.fila.set(x.chave, { desde: agora });
  }
  const ordem = [...m.fila.entries()].sort((a, b) => a[1].desde - b[1].desde || a[0].localeCompare(b[0]));
  const fila = new Map();
  ordem.forEach(([chave], i) => {
    const lugar = LUGARES[Math.min(i, LUGARES.length - 1)];
    fila.set(chave, { lugar, indice: i, pose: lugar.startsWith("banco") ? "sentado-banco" : "esperando-de-pe", escondido: i >= LUGARES.length });
  });

  // ---- apagão ----
  const escuro = todasApagadas(contas);
  if (escuro && !m.apagao) {
    const semente = magos.map((x) => x.chave).sort().join("|");
    m.apagao = { desde: agora, semente, papeis: papeisDe(magos, semente), susto: !m.primeiroRetrato };
  } else if (!escuro && m.apagao) {
    m.apagao = null;
    m.acabouEm = agora;
    for (const x of magos) voltaram.push(x.chave);
  }
  m.primeiroRetrato = false;

  let apagao = null;
  let luzes = 1;
  if (m.apagao) {
    const t = agora - m.apagao.desde;
    luzes = Math.max(0, 1 - t / APAGANDO_MS);
    // quem chega no meio vai pra pista
    for (const x of magos) if (!m.apagao.papeis.has(x.chave)) m.apagao.papeis.set(x.chave, "danca");
    const pose = new Map();
    for (const [chave, papel] of m.apagao.papeis) {
      if (!porChave.has(chave)) continue;
      pose.set(chave, t < 700 && m.apagao.susto ? "susto" : papel === "tocha" ? "procurando-com-tocha" : "dancando");
    }
    apagao = { fase: t < APAGANDO_MS ? "apagando" : "festa", progresso: Math.min(1, t / APAGANDO_MS), papeis: m.apagao.papeis, pose };
  } else if (m.acabouEm) {
    const t = agora - m.acabouEm;
    luzes = Math.min(1, t / ACENDENDO_MS);
  }
  const acendendo = !m.apagao && m.acabouEm > 0 && agora - m.acabouEm < ACENDENDO_MS;
  /** Depois da luz voltar, todo mundo corre pra mesa e fica sentado VOLTA_MS (quem tem tarefa já trabalha). */
  const voltando = !m.apagao && m.acabouEm > 0 && agora - m.acabouEm < VOLTA_MS;
  return { fila, voltaram, apagao, luzes, acendendo, voltando };
}

export function esvaziarMana(m) {
  m.voltaram = [];
  m.acabouEm = 0;
}
