/**
 * O que o painel flutuante mostra, calculado a partir do que o daemon responde.
 *
 * Está separado da tela porque é a parte que dá pra errar: escolher QUAL run
 * mostrar, somar custo entre tentativas, decidir quando um limite vira alerta.
 * A pintura em si é mecânica.
 *
 * Nada aqui faz requisição — recebe as respostas prontas e devolve o retrato.
 */

/**
 * O run que interessa: o que está rodando. Havendo mais de um, o mais NOVO —
 * é o que a pessoa acabou de disparar e está esperando. Nenhum rodando, mostra
 * o último que terminou, pra faixa não ficar vazia logo depois de acabar.
 */
export function runEmDestaque(runs) {
  const lista = Array.isArray(runs) ? runs : [];
  const rodando = lista.filter((r) => r?.status === "running");
  const escolha = rodando.length ? rodando : lista;
  return (
    escolha.reduce((melhor, r) => (!melhor || (r?.createdAt ?? "") > (melhor.createdAt ?? "") ? r : melhor), null) ??
    null
  );
}

/** Passo aberto agora. O supervisor fica aberto o run inteiro, então perde pro membro. */
export function passoAtual(run) {
  const abertos = (run?.steps ?? []).filter((s) => s?.status === "running");
  return abertos.find((s) => !s.supervisor) ?? abertos[0] ?? null;
}

/**
 * Custo do run, incluindo o das tentativas anteriores. Sem `gastoAnterior` o
 * número cairia depois de uma retomada, como se dinheiro tivesse voltado.
 */
export function custoDoRun(run) {
  return (run?.steps ?? []).reduce((n, s) => n + (s?.costUsd ?? 0), run?.gastoAnterior ?? 0);
}

/** Linha do run pro painel. `null` quando não há run nenhum pra mostrar. */
export function faixaDoRun(runs, agora = Date.now()) {
  const run = runEmDestaque(runs);
  if (!run) return null;
  const steps = run.steps ?? [];
  const feitos = steps.filter((s) => s?.status === "done").length;
  const passo = passoAtual(run);
  const inicio = Date.parse(passo?.startedAt ?? run.createdAt ?? "");
  /*
   * Run fechado para o relógio no fim dele. Sem isso o número continuava
   * crescendo depois de acabar, como se ainda estivesse trabalhando — que é
   * exatamente a pergunta que o painel existe pra responder.
   */
  const fim = run.status === "running" ? agora : (Date.parse(run.endedAt ?? "") || agora);
  return {
    id: run.id,
    status: run.status,
    rodando: run.status === "running",
    objetivo: (run.goal ?? "").replace(/\s+/g, " ").slice(0, 60),
    feitos,
    total: steps.length,
    agente: passo?.agentId ?? "",
    /** Vazio quando nada abriu ainda: zero seria mentira, não "ainda não". */
    ms: Number.isNaN(inicio) ? 0 : Math.max(0, fim - inicio),
    custoUsd: custoDoRun(run),
    tetoUsd: run.budget?.maxUsd ?? 0,
  };
}

/** Fatia de limite mais apertada de uma conta: é ela que define a cor do anel. */
export function usoDaConta(entrada) {
  const l = entrada?.limits;
  const janelas = [l?.fiveHour?.utilization, l?.sevenDay?.utilization].filter((v) => typeof v === "number");
  if (!janelas.length) return null;
  const uso = Math.max(...janelas);
  return {
    id: entrada.id,
    engine: entrada.engine ?? "",
    /** 0..1. Acima de 1 acontece: o provedor às vezes passa do teto antes de recusar. */
    uso: Math.min(1, Math.max(0, uso)),
    /** `true` quando a conta já foi recusada — o anel cheio não diz isso sozinho. */
    bloqueada: l?.status === "blocked" || entrada.status === "unauthenticated",
  };
}

/**
 * Contas com uso conhecido, da mais apertada pra menos. Conta que nunca rodou
 * um turno desde o boot não tem dado nenhum e fica de fora: um anel vazio
 * pareceria "sobrando quota", que é o oposto de "não sei".
 */
export function aneisDeConta(contas) {
  return (Array.isArray(contas) ? contas : [])
    .map(usoDaConta)
    .filter((a) => a !== null)
    .sort((a, b) => b.uso - a.uso);
}

/** Conversas com turno em voo AGORA, fora do que já aparece como passo do run. */
export function emVoo(agentes, runId = "") {
  return (Array.isArray(agentes) ? agentes : []).filter((a) => a?.busy && (!runId || a.runId !== runId));
}
