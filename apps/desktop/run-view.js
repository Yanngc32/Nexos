/**
 * Estado da execução de um time, do lado da tela.
 *
 * Diferente da bancada de um agente, aqui o daemon já entrega os passos
 * estruturados — com `startedAt`/`endedAt` do próprio servidor. Então o tempo
 * NÃO é o de chegada do evento: é o que o daemon mediu. A única coisa medida
 * aqui é o passo ainda aberto, que cresce contra o relógio local até o `endedAt`
 * chegar.
 */

/** Passos que já terminaram, num sentido ou noutro. */
const FECHADOS = new Set(["done", "error", "skipped"]);

/**
 * Aplica um evento do stream no run. Altera no lugar.
 * @returns true quando algo mudou e vale repintar
 */
export function aplicarEventoDeRun(run, ev) {
  if (!run || !ev || typeof ev.type !== "string") return false;
  if (ev.runId && ev.runId !== run.id) return false;

  switch (ev.type) {
    case "run_start":
      run.status = "running";
      return true;

    /**
     * Passo que nasceu no meio do run: só o supervisor produz isso, porque só
     * nele a lista não sai pronta do daemon. Anexar pelo índice do próprio
     * evento — e não empurrar no fim — mantém o array alinhado com o do daemon
     * mesmo se um evento chegar fora de ordem.
     */
    case "step_add": {
      if (!ev.step || !run.steps) return false;
      if (run.steps[ev.step.index]) return false;
      run.steps[ev.step.index] = ev.step;
      return true;
    }

    case "step_start": {
      const passo = run.steps?.[ev.index];
      if (!passo) return false;
      passo.status = "running";
      passo.threadId = ev.threadId;
      if (!passo.startedAt) passo.startedAt = new Date().toISOString();
      return true;
    }

    case "step_done": {
      if (!run.steps?.[ev.index] || !ev.step) return false;
      // o daemon manda o passo inteiro: substituir é mais seguro que remendar
      run.steps[ev.index] = ev.step;
      return true;
    }

    case "run_end":
      run.status = ev.status;
      if (ev.error) run.error = ev.error;
      if (!run.endedAt) run.endedAt = new Date().toISOString();
      return true;

    default:
      return false;
  }
}

function ms(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Duração de um passo. Fechado usa o que o daemon mediu; aberto cresce contra o
 * relógio local. Passo que nem começou não tem duração — zero, não "agora menos
 * nada", que daria um número gigante.
 */
export function duracaoDoPasso(step, agora = Date.now()) {
  const inicio = ms(step?.startedAt);
  if (!inicio) return 0;
  const fim = ms(step?.endedAt);
  return Math.max(0, (fim || agora) - inicio);
}

export function passoAberto(step) {
  return step?.status === "running";
}

/** Totais do run: tempo de parede, tokens, custo e a contagem por situação. */
export function resumoDoRun(run, agora = Date.now()) {
  const steps = run?.steps ?? [];
  const inicio = ms(run?.createdAt);
  const fim = ms(run?.endedAt);
  return {
    ms: inicio ? Math.max(0, (fim || agora) - inicio) : 0,
    rodando: run?.status === "running",
    tokens: steps.reduce((n, s) => n + (s.tokens ?? 0), 0),
    custoUsd: steps.reduce((n, s) => n + (s.costUsd ?? 0), 0),
    concluidos: steps.filter((s) => s.status === "done").length,
    total: steps.length,
    /** Soma do tempo dos passos: menor que o do run, que inclui a montagem. */
    msDosPassos: steps.reduce((n, s) => n + duracaoDoPasso(s, agora), 0),
  };
}

/** O passo que está rodando agora, ou undefined. */
export function passoEmVoo(run) {
  return (run?.steps ?? []).find(passoAberto);
}

/** Terminou de vez? Serve pra parar o relógio e fechar o stream. */
export function runFechado(run) {
  return Boolean(run) && run.status !== "running";
}

/** Largura da barra de cada passo, proporcional ao mais longo do run. */
export function larguraDosPassos(steps, agora = Date.now()) {
  const duracoes = (steps ?? []).map((s) => duracaoDoPasso(s, agora));
  const maior = Math.max(0, ...duracoes);
  return duracoes.map((d) => (!maior || !d ? 0 : Math.max(2, Math.round((d / maior) * 100))));
}

/** Todo passo tem um estado visual; `pending` é o único que ainda não aconteceu. */
export function rotuloDoPasso(step) {
  switch (step?.status) {
    case "done":
      return "concluído";
    case "running":
      return "rodando";
    case "error":
      return "falhou";
    case "skipped":
      return "não rodou";
    default:
      return "na fila";
  }
}

export { FECHADOS as STATUS_FECHADOS };
