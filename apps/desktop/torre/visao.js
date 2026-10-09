import { estandarteDe } from "./arte.js";

/**
 * Torre de magia — a VISÃO GERAL (camada pura): quais torres aparecem, em que ordem, o resumo em
 * texto, o nível em que a aba abre e o recado da ilha. Sem DOM: a aba e a ilha só pintam isto.
 */

export const TORRES_TETO = 8;
export const NIVEL_GERAL = "geral";

/** Soma do que está acontecendo na torre (conversa viva, exploradores, hooks, ateliê). */
export function atividadeDaTorre(t) {
  const c = t.contagem;
  return c.trabalhando + c.esperando + c.exploradores + c.segundoPlano + c.semMana + (t.bibliotecarios?.length ?? 0) + (t.pintor ? 1 : 0);
}

export function torreAtiva(t) {
  return atividadeDaTorre(t) > 0 || Boolean(t.janelas?.observatorio);
}

/** Quem espera você primeiro, depois mais atividade, depois as paradas mais recentes. */
export function ordemDasTorres(torres) {
  return [...(torres ?? [])].sort(
    (a, b) =>
      Number(b.contagem.esperando > 0) - Number(a.contagem.esperando > 0) ||
      atividadeDaTorre(b) - atividadeDaTorre(a) ||
      b.ultimaAtividade - a.ultimaAtividade ||
      a.nome.localeCompare(b.nome),
  );
}

/** As torres da paisagem (no máximo 8) e quantas ficaram de fora. */
export function torresDaPaisagem(torres, teto = TORRES_TETO) {
  const ordem = ordemDasTorres(torres);
  return { visiveis: ordem.slice(0, teto), escondidas: ordem.slice(teto) };
}

/** "4 projetos · 6 trabalhando · 1 esperando você · 2 exploradores" (só o que é > 0). */
export function resumoGeral(torres) {
  const lista = torres ?? [];
  const soma = (k) => lista.reduce((n, t) => n + t.contagem[k], 0);
  const partes = [];
  if (lista.length) partes.push(`${lista.length} ${lista.length === 1 ? "projeto" : "projetos"}`);
  if (soma("trabalhando")) partes.push(`${soma("trabalhando")} trabalhando`);
  if (soma("esperando")) partes.push(`${soma("esperando")} esperando você`);
  if (soma("exploradores")) partes.push(`${soma("exploradores")} ${soma("exploradores") === 1 ? "explorador" : "exploradores"}`);
  return partes.join(" · ");
}

/** Texto da torre (hover e `aria-label`): "Nexos: 2 trabalhando, 1 esperando você, 1 explorando". */
export function rotuloDaTorre(t) {
  const c = t.contagem;
  const partes = [];
  if (c.trabalhando) partes.push(`${c.trabalhando} trabalhando`);
  if (c.esperando) partes.push(`${c.esperando} esperando você`);
  if (c.exploradores) partes.push(`${c.exploradores} explorando`);
  if (c.segundoPlano) partes.push(`${c.segundoPlano} em 2º plano`);
  if (t.janelas?.biblioteca) partes.push("Biblioteca ativa");
  if (t.pintor) partes.push(t.render ? "Ateliê ativo: renderizando vídeo" : "Ateliê ativo");
  return `${t.nome}: ${partes.length ? partes.join(", ") : "parada"}`;
}

/** Janelas e cor da torre em miniatura (o que `pintarTorreMini` pinta). */
export function miniDaTorre(t) {
  return { cor: t.cor, janelas: t.janelas ?? {} };
}

/**
 * Nível em que a aba abre: com atividade em 2+ projetos, a visão geral; em só 1, direto na torre
 * dele; sem nenhuma, na torre do projeto aberto. O que a pessoa escolheu na sessão (`lembrado`:
 * "geral" ou a chave de um projeto) vence.
 */
export function nivelInicial(torres, chaveAberta, lembrado) {
  if (lembrado) return lembrado;
  const ativas = (torres ?? []).filter(torreAtiva);
  if (ativas.length >= 2) return NIVEL_GERAL;
  if (ativas.length === 1) return ativas[0].chave;
  return chaveAberta ?? NIVEL_GERAL;
}

/** O que a ilha mostra: quantas torres ativas, se alguém espera, e a primeira que espera. */
export function resumoDaIlha(torres) {
  const ativas = (torres ?? []).filter(torreAtiva);
  const esperando = ativas.filter((t) => t.contagem.esperando > 0);
  const n = ativas.length;
  const aria = n
    ? `Torres: ${n} ${n === 1 ? "projeto ativo" : "projetos ativos"}${esperando.length ? `, ${esperando.reduce((s, t) => s + t.contagem.esperando, 0)} esperando você` : ""}`
    : "Torres: nenhum projeto ativo";
  return { ativas: n, esperando: esperando.length > 0, primeiraEsperando: esperando[0]?.chave ?? "", aria };
}

/** Cor do estandarte (a mesma do pixel pintado na torre) pro chip da placa e da legenda. */
export function corDoEstandarteCss(cor) {
  return estandarteDe(Number(cor))[0];
}
