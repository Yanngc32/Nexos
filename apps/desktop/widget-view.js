import { samePath } from "./format.js";

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
 * Só o que é do projeto aberto.
 *
 * O daemon é da máquina, não do projeto: ele responde os runs e as conversas de
 * TODOS os projetos. Com dois abertos ao mesmo tempo, o painel mostrava o run
 * do outro — e sem dizer que era de outro, o que é pior que não mostrar nada.
 *
 * Projeto vazio NÃO filtra: pode não haver janela com projeto aberto e o daemon
 * ainda estar trabalhando (disparado pela CLI, por exemplo). Esconder aí faria o
 * painel mentir na direção oposta.
 */
export function doProjeto(itens, projeto) {
  const lista = Array.isArray(itens) ? itens : [];
  if (!projeto) return lista;
  return lista.filter((x) => samePath(x?.projectPath, projeto));
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

/**
 * Linha do run pro painel. `null` quando não há run pra mostrar.
 *
 * Recebe UM run, não a lista: quem escolhe qual é o run do momento é o daemon
 * (`GET /v1/runs/atual`). Escolher aqui obrigava a tela a baixar todos os runs
 * a cada dois segundos só pra jogar quase todos fora.
 */
export function faixaDoRun(run, agora = Date.now()) {
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

/**
 * Atividade de OUTROS projetos, agrupada por pasta — "o que está rodando, em qual projeto"
 * pra quem tem mais de uma pasta aberta ao mesmo tempo. O projeto ABERTO nesta janela já
 * aparece em `bl-run`/`bl-voo`; repeti-lo aqui seria a mesma informação duas vezes.
 */
export function porOutrosProjetos(agentes, projetoAtual) {
  const ocupados = (Array.isArray(agentes) ? agentes : []).filter(
    (a) => a?.busy && a.projectPath && !samePath(a.projectPath, projetoAtual),
  );
  const porPasta = new Map();
  for (const a of ocupados) {
    const grupo = porPasta.get(a.projectPath) ?? { projectPath: a.projectPath, agentes: [] };
    grupo.agentes.push(a);
    porPasta.set(a.projectPath, grupo);
  }
  // mais movimentado primeiro: é o que mais provavelmente merece um clique
  return [...porPasta.values()].sort((a, b) => b.agentes.length - a.agentes.length);
}

/**
 * Retrato do modo mini: só o que responde "está andando?" e "quanto de quota
 * sobrou?", mais o texto do que ficou escondido.
 *
 * A pílula tem ~168px e não cabe objetivo, lista de contas nem custo. Esconder
 * sem devolver nada seria uma perda seca, então tudo que sai da tela volta como
 * `titulo*` — o painel usa esses textos como `title` das peças. Por isso os
 * títulos são montados aqui e não na pintura: é a parte que dá pra esquecer um
 * campo, e teste pega.
 */
export function resumoMini(faixa, emVooAgora = [], aneis = [], outrosProjetos = []) {
  const voo = Array.isArray(emVooAgora) ? emVooAgora : [];
  const outros = Array.isArray(outrosProjetos) ? outrosProjetos : [];
  /** O pior anel já vem primeiro: `aneisDeConta` ordena da conta mais apertada. */
  const pior = (Array.isArray(aneis) ? aneis : [])[0] ?? null;
  const partes = [];
  if (faixa) {
    partes.push(faixa.objetivo || "sem objetivo");
    partes.push(faixa.total ? `${faixa.feitos}/${faixa.total} passos` : "passos ainda não montados");
    partes.push(faixa.rodando ? faixa.agente || "montando…" : faixa.status);
    if (faixa.custoUsd) {
      partes.push(`US$ ${faixa.custoUsd.toFixed(4)}${faixa.tetoUsd ? ` de US$ ${faixa.tetoUsd}` : ""}`);
    }
  }
  if (voo.length) {
    const nomes = voo.map((a) => a.agentName || a.profileId).join(", ");
    partes.push(`${voo.length} ${voo.length === 1 ? "conversa" : "conversas"}: ${nomes}`);
  }
  if (outros.length) {
    const totalConversas = outros.reduce((n, g) => n + g.agentes.length, 0);
    const nomes = outros.map((g) => g.projectPath.replace(/^.*[\\/]/, "")).join(", ");
    partes.push(
      `${totalConversas} ${totalConversas === 1 ? "conversa" : "conversas"} em outro projeto (${nomes})`,
    );
  }
  const pct = pior ? Math.round(pior.uso * 100) : 0;
  const quem = pior ? `${pior.id}${pior.engine ? ` · ${pior.engine}` : ""}` : "";
  const quanto = pior?.bloqueada ? "conta bloqueada" : `${pct}% da janela mais apertada`;
  // Nada NESTE projeto, mas tem gente trabalhando em outro: a pílula usa o espaço do "N/M
  // passos" pra dizer isso — melhor que ficar quieta enquanto algo roda de verdade.
  const semNadaAqui = !faixa && voo.length === 0;
  // Conversa em voo SEM run: antes a pílula só acendia o ponto e ficava com os dois textos em
  // branco — "ligado" sem dizer o quê. Usa os mesmos dois espaços que o run usaria.
  const passos = faixa?.total
    ? `${faixa.feitos}/${faixa.total}`
    : voo.length
      ? `${voo.length} ${voo.length === 1 ? "conversa" : "conversas"}`
      : semNadaAqui && outros.length
        ? `${outros.length} ${outros.length === 1 ? "projeto" : "projetos"}`
        : "";
  return {
    ligado: Boolean(faixa?.rodando) || voo.length > 0 || outros.length > 0,
    erro: faixa?.status === "error",
    passos,
    ms: faixa?.ms ?? 0,
    /**
     * Nome de quem está trabalhando, pro slot de "ms" ter o que mostrar quando não há run
     * (`ms` fica 0 nesse caso — sem os dois, a pílula acendia o ponto e ficava muda).
     */
    quemTrabalha: !faixa && voo.length ? voo.map((a) => a.agentName || a.profileId).join(", ") : "",
    /** Nada de run, conversa NEM projeto alheio: só aí a pílula assume o estado quieto. */
    quieto: semNadaAqui && outros.length === 0,
    quota: pior ? { id: pior.id, pct, uso: pior.uso, bloqueada: pior.bloqueada } : null,
    tituloStatus: partes.length ? partes.join(" · ") : "nada rodando",
    tituloQuota: pior ? `${quem} — ${quanto}` : "",
  };
}
