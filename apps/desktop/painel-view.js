import { fmtReset, folderName } from "./format.js";

/**
 * O que o painel de borda mostra, calculado a partir do que o daemon responde.
 *
 * Separado da pintura porque é a parte que dá pra errar: qual janela de uso é a mais apertada,
 * quando uma leitura ficou velha, quando uma conversa "terminou" ou "está esperando você" e quando
 * um limite cruzou 80%/100%. Nada aqui faz requisição nem mexe no DOM.
 */

/** Limites de cor padrão (os do codenotch no Windows): atenção a partir de 50%, crítico a partir de 80%. */
export const LIMITES_PADRAO = { atencao: 0.5, critico: 0.8 };

/** Faixa de cor do uso: verde abaixo da atenção, amarelo até o crítico, laranja até 99%, cheio em 100%. */
export function nivelDoUso(uso, limites = LIMITES_PADRAO) {
  if (uso >= 1) return "cheio";
  if (uso >= limites.critico) return "alto";
  if (uso >= limites.atencao) return "medio";
  return "ok";
}

const JANELAS = [
  ["fiveHour", "Sessão", "5 h"],
  ["sevenDay", "Semana", "7 dias"],
];

/**
 * Janelas de uso de uma conta. `velha`: a janela já renovou desde a leitura (o `resetsAt` passou)
 * — o número guardado é da janela ANTERIOR, então o painel escurece e marca "~" em vez de afirmar.
 */
export function janelasDaConta(entrada, agora = Date.now(), limites = LIMITES_PADRAO) {
  const l = entrada?.limits;
  const out = [];
  for (const [chave, rotulo, duracao] of JANELAS) {
    const w = l?.[chave];
    if (typeof w?.utilization !== "number") continue;
    const resetMs = Number(w.resetsAt) * 1000 || 0;
    const velha = resetMs > 0 && resetMs <= agora;
    const uso = Math.min(1, Math.max(0, w.utilization));
    out.push({
      chave,
      rotulo,
      duracao,
      uso,
      pct: Math.round(uso * 100),
      velha,
      nivel: nivelDoUso(uso, limites),
      reset: velha ? "Já renovou — atualiza no próximo turno" : fmtReset(w.resetsAt),
    });
  }
  return out;
}

/**
 * Uma célula por conta com uso conhecido, da mais apertada pra menos. A célula mostra a janela
 * mais apertada que ainda vale (velha só entra se não houver outra). Conta sem dado nenhum fica de
 * fora: anel vazio pareceria "sobrando quota", que é o oposto de "não sei".
 */
export function celulasDeConta(contas, agora = Date.now(), limites = LIMITES_PADRAO) {
  const out = [];
  for (const c of Array.isArray(contas) ? contas : []) {
    const janelas = janelasDaConta(c, agora, limites);
    if (!janelas.length) continue;
    const valendo = janelas.filter((j) => !j.velha);
    const base = valendo.length ? valendo : janelas;
    const pior = base.reduce((a, b) => (b.uso > a.uso ? b : a));
    const bloqueada = c.limits?.status === "blocked" || c.status === "unauthenticated";
    out.push({
      id: c.id,
      nome: c.nickname || c.id,
      engine: c.engine ?? "",
      uso: pior.uso,
      pct: pior.pct,
      nivel: bloqueada ? "cheio" : pior.nivel,
      velha: !valendo.length,
      bloqueada,
      janelas,
    });
  }
  return out.sort((a, b) => b.uso - a.uso);
}

/** Estado de uma conversa pro painel. */
export function estadoDoAgente(a) {
  if (a?.aguardando) return "esperando";
  if (a?.busy) return "trabalhando";
  return "parado";
}

/**
 * Conversas pro card de atividade: as que estão rodando/esperando agora e as que terminaram e
 * ainda não foram vistas (`terminadas`, mantidas por quem chama). Esperando primeiro (pede ação),
 * depois trabalhando, depois terminadas.
 */
export function linhasDeAtividade(agentes, terminadas = new Map(), agora = Date.now()) {
  const linhas = [];
  const vistos = new Set();
  for (const a of Array.isArray(agentes) ? agentes : []) {
    const estado = estadoDoAgente(a);
    if (estado === "parado") continue;
    vistos.add(a.threadId);
    linhas.push({
      threadId: a.threadId,
      projectPath: a.projectPath ?? "",
      projeto: a.projectPath ? folderName(a.projectPath) : "sem projeto",
      nome: a.agentName || a.preview || a.profileId || "conversa",
      estado,
      ms: a.startedAt ? Math.max(0, agora - a.startedAt) : 0,
    });
  }
  for (const [threadId, t] of terminadas) {
    if (vistos.has(threadId)) continue;
    linhas.push({ ...t, threadId, estado: "terminou", ms: 0 });
  }
  const ordem = { esperando: 0, trabalhando: 1, terminou: 2 };
  return linhas.sort((a, b) => ordem[a.estado] - ordem[b.estado]);
}

/** Quanto tempo um "vista" da janela principal vale pra barrar um "terminou" que chega depois. */
export const VISTA_VALE_MS = 60_000;

/**
 * Tira do "terminou" quem a pessoa já viu na janela principal. O aviso de vista pode chegar ANTES
 * do painel perceber o fim (ele só nota no poll seguinte, até 2 s depois): sem lembrar os vistos
 * recentes, a conversa que terminou aberta na tela entrava no painel como "terminou" e ficava.
 */
export function naoVistas(terminou, vistas, agora = Date.now(), valeMs = VISTA_VALE_MS) {
  return (Array.isArray(terminou) ? terminou : []).filter((a) => {
    const em = vistas?.get(a.threadId);
    return !(typeof em === "number" && agora - em <= valeMs);
  });
}

/**
 * O que mudou entre dois retratos das conversas: quem terminou (estava em voo e não está mais) e
 * quem passou a esperar resposta. É isso que abre o painel sozinho e toca o som.
 */
export function transicoes(antes, agora) {
  const eram = new Map((Array.isArray(antes) ? antes : []).map((a) => [a.threadId, estadoDoAgente(a)]));
  const terminou = [];
  const esperando = [];
  for (const a of Array.isArray(agora) ? agora : []) {
    const era = eram.get(a.threadId);
    const e = estadoDoAgente(a);
    if (e === "esperando" && era !== "esperando") esperando.push(a);
    if (e === "parado" && (era === "trabalhando" || era === "esperando") && a.lastTerminal !== "error") terminou.push(a);
  }
  // conversa em voo que sumiu da lista (motor fechou) também terminou
  const ids = new Set((Array.isArray(agora) ? agora : []).map((a) => a.threadId));
  for (const a of Array.isArray(antes) ? antes : []) {
    if (!ids.has(a.threadId) && estadoDoAgente(a) === "trabalhando") terminou.push(a);
  }
  return { terminou, esperando };
}

/**
 * O que mudou nos limites desde a última leitura, por conta e janela — um aviso por evento:
 * - `limiar`: cruzou PRA CIMA o crítico ou os 100%;
 * - `renovou`: a janela que estava valendo passou do `resetsAt` (renovou).
 * `antes` é o mapa devolvido na chamada anterior; a primeira leitura só grava, não avisa (abrir o
 * app com 85% não é "acabou de cruzar").
 */
export function mudancasDeLimite(antes, celulas, limites = LIMITES_PADRAO) {
  const atual = new Map();
  const avisos = [];
  for (const c of Array.isArray(celulas) ? celulas : []) {
    for (const j of c.janelas) {
      const chave = `${c.id}:${j.chave}`;
      atual.set(chave, { uso: j.uso, velha: j.velha });
      const era = antes?.get(chave);
      if (!era) continue;
      const janela = `${j.rotulo} (${j.duracao})`;
      if (!era.velha && j.velha) {
        if (era.uso > 0) avisos.push({ tipo: "renovou", conta: c.id, janela, chave: j.chave });
        continue;
      }
      if (j.velha) continue;
      const limiar = [1, limites.critico].find((l) => era.uso < l && j.uso >= l);
      if (limiar) avisos.push({ tipo: "limiar", conta: c.id, janela, chave: j.chave, limiar, pct: j.pct });
    }
  }
  return { avisos, atual };
}
