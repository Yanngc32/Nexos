/**
 * Torre de magia — a DUNGEON do porão (decorativa: não representa o repositório).
 *
 * Cada explorador (chamada `Agent`) ganha uma faixa gerada com SEMENTE = id da chamada: o mesmo
 * subagente tem sempre o mesmo mapa, inclusive ao reabrir a aba. A faixa é uma fileira de salas
 * (4 a 8) em corte lateral: parede atrás, chão embaixo, porta entre uma sala e outra, baú na
 * última. O explorador anda de sala em sala em ritmo fixo; salas por onde passou ficam em
 * penumbra, o resto no escuro (só a tocha ilumina).
 */
import { inteiro, sorteioDe } from "./acaso.js";

export const COLUNAS = 9;
/** Tempo pra atravessar uma sala. */
export const SALA_MS = 1_800;

/** Faixa gerada pela semente: `{ salas: [{ ini, fim }], paredes: [nome], chao: [nome], portas: [col], bau }`. */
export function gerarDungeon(semente, colunas = COLUNAS) {
  const sorteio = sorteioDe(`dungeon:${semente}`);
  const nSalas = Math.min(colunas, inteiro(sorteio, 4, 8));
  // larguras: todo mundo começa com 1 coluna; as que sobram vão pra salas sorteadas
  const larguras = Array(nSalas).fill(1);
  for (let sobra = colunas - nSalas; sobra > 0; sobra--) larguras[inteiro(sorteio, 0, nSalas - 1)]++;
  const salas = [];
  let col = 0;
  for (const w of larguras) {
    salas.push({ ini: col, fim: col + w - 1 });
    col += w;
  }
  const paredes = Array.from({ length: colunas }, () => (sorteio() < 0.18 ? "paredeGrade" : "parede"));
  const chao = Array.from({ length: colunas }, () => (sorteio() < 0.25 ? "entulho" : "chao"));
  const portas = salas.slice(1).map((s) => s.ini);
  return { semente: String(semente), colunas, salas, paredes, chao, portas, bau: salas.at(-1).ini + Math.floor((salas.at(-1).fim - salas.at(-1).ini) / 2) };
}

/** Sala em que uma coluna cai. */
export function salaDaColuna(mapa, col) {
  const c = Math.max(0, Math.min(mapa.colunas - 1, Math.floor(col)));
  return mapa.salas.findIndex((s) => c >= s.ini && c <= s.fim);
}

/**
 * Onde está o explorador `ms` depois de chegar na faixa. Vai até o baú e, se o subagente ainda
 * não voltou, fica indo e vindo pelas salas. Devolve `{ col, sala, visitadas, espelho, noBau }`
 * (col fracionária, em colunas de tile).
 */
export function posicaoNaDungeon(mapa, ms) {
  const colPorMs = 1 / SALA_MS;
  const ida = mapa.bau / colPorMs;
  const t = Math.max(0, Number(ms) || 0);
  let col;
  let espelho = false;
  if (t <= ida) col = t * colPorMs;
  else {
    // ida e volta entre a primeira sala e o baú (explorando), começando pela volta
    const vai = (t - ida) % (2 * ida || 1);
    if (vai < ida) {
      col = mapa.bau - vai * colPorMs;
      espelho = true;
    } else col = (vai - ida) * colPorMs;
  }
  const maisLonge = Math.min(mapa.bau, t * colPorMs);
  const visitadas = new Set();
  for (let c = 0; c <= maisLonge; c++) visitadas.add(salaDaColuna(mapa, c));
  return { col, sala: salaDaColuna(mapa, col), visitadas, espelho, noBau: Math.abs(col - mapa.bau) < 0.25 };
}

/**
 * Quais explorador ocupam quais faixas: os mais recentes ganham faixa, cada um sempre a mesma
 * enquanto estiver lá (quem já tem faixa fica nela, como as mesas do Salão).
 */
export function faixasDosExploradores(exploradores, anterior, teto) {
  const faixas = new Map();
  const usadas = new Set();
  const lista = (exploradores ?? []).slice(0, teto);
  const vivos = new Set(lista.map((e) => e.chave));
  for (const [chave, i] of anterior ?? []) {
    if (!vivos.has(chave) || i >= teto || usadas.has(i)) continue;
    faixas.set(chave, i);
    usadas.add(i);
  }
  for (const e of lista) {
    if (faixas.has(e.chave)) continue;
    let i = 0;
    while (usadas.has(i)) i++;
    faixas.set(e.chave, i);
    usadas.add(i);
  }
  return faixas;
}
