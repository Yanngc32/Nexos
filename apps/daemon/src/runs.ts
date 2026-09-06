import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RUN_GOAL_MAX,
  type Run,
  type RunBudget,
  type RunEvent,
  type RunStep,
  type TeamDef,
} from "@nexo/shared";
import { getAgent } from "./agents.ts";
import { runDir, runsRoot } from "./home.ts";
import { newRunId } from "./ids.ts";
import { abortThread, getLive, postMessage } from "./session.ts";
import {
  lerDecisao,
  listarDisponiveis,
  pedidoDeCorrecao,
  pedidoDeFalha,
  pedidoDeVolta,
  pedidoInicial,
  type Decisao,
  type Disponivel,
} from "./supervisor.ts";
import { getTeam } from "./teams.ts";
import { createThread, readThread, threadUsage } from "./threads.ts";
import { commitarTrabalho, criarWorktree, nomeDoBranch, podeIsolar, removerWorktree, temMudanca } from "./worktree.ts";

/**
 * Execução de um time.
 *
 * O daemon orquestra de FORA: cria a conversa do membro, manda o pedido, espera
 * o turno fechar, lê a saída final e alimenta o próximo. Nada disso exige canal
 * de volta nem ferramenta nova no motor — vale inclusive pro supervisor, que
 * responde a ordem em texto e tem o daemon executando por ele.
 *
 * O que passa entre membros é ARTEFATO, não transcrição: cada passo grava a
 * saída inteira num arquivo do run e o seguinte recebe um trecho no pedido mais
 * o caminho do arquivo. Transcrição inteira encareceria cada passo e ainda
 * arrastaria o ruído do anterior.
 */

export const runsBus = new EventEmitter();

/** Quanto da saída anterior entra no pedido do próximo; o resto fica no arquivo. */
const TRECHO_CHARS = 4000;

/** Teto padrão de passos. Um pipeline não deveria passar do tamanho do time. */
const PASSOS_TETO = 32;

function nowIso(): string {
  return new Date().toISOString();
}

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function emit(run: Run, ev: RunEvent): void {
  runsBus.emit(run.id, ev);
  runsBus.emit("*", ev);
}

/* ---------- persistência ---------- */

function runPath(id: string, home: string): string {
  return join(runDir(id, home), "run.json");
}

export function saveRun(run: Run, home: string): void {
  mkdirSync(runDir(run.id, home), { recursive: true });
  writeFileSync(runPath(run.id, home), JSON.stringify(run, null, 2), "utf8");
}

export function getRun(id: string, home: string): Run | undefined {
  const path = runPath(id, home);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Run;
  } catch {
    return undefined;
  }
}

export function listRuns(home: string, projectPath?: string): Run[] {
  const raiz = runsRoot(home);
  if (!existsSync(raiz)) return [];
  const out: Run[] = [];
  for (const dir of readdirSync(raiz)) {
    const run = getRun(dir, home);
    if (!run) continue;
    if (projectPath && run.projectPath !== projectPath) continue;
    out.push(run);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/* ---------- execução ---------- */

/** Runs em voo, por id: é o que o abort alcança. */
const vivos = new Map<string, { run: Run; abortado: boolean }>();

export function runAtivo(id: string): boolean {
  return vivos.has(id);
}

/** Alguém pediu pra parar? O run some de `vivos` só quando termina de verdade. */
function abortado(id: string): boolean {
  return vivos.get(id)?.abortado === true;
}

function texto(value: unknown, campo: string, max: number): string {
  if (typeof value !== "string") throw badRequest(`${campo} inválido`);
  const t = value.trim();
  if (!t) throw badRequest(`${campo} obrigatório`);
  if (t.length > max) throw badRequest(`${campo} passa de ${max} caracteres`);
  return t;
}

function limparBudget(value: unknown): RunBudget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as { maxUsd?: unknown; maxSteps?: unknown };
  const out: RunBudget = {};
  if (typeof o.maxUsd === "number" && o.maxUsd > 0) out.maxUsd = o.maxUsd;
  if (typeof o.maxSteps === "number" && o.maxSteps > 0) out.maxSteps = Math.floor(o.maxSteps);
  return Object.keys(out).length ? out : undefined;
}

export type StartRunInput = {
  teamId: string;
  projectPath: string;
  goal: string;
  budget?: unknown;
};

/** Monta o run parado, com todos os passos pendentes. Não executa nada. */
export function criarRun(input: StartRunInput, home: string): Run {
  const teamId = texto(input.teamId, "teamId", 40);
  const time = getTeam(teamId, home);
  if (!time) throw badRequest(`time não existe: ${teamId}`);
  const projectPath = texto(input.projectPath, "projectPath", 4000);
  const goal = texto(input.goal, "goal", RUN_GOAL_MAX);

  for (const m of time.members) {
    if (!getAgent(m.agentId, home)) throw badRequest(`agente não existe: ${m.agentId}`);
  }

  /**
   * No supervisor a lista de passos NÃO sai pronta: quem trabalha, e quantas
   * vezes, é ele que decide durante o run. O único passo conhecido de antemão é
   * o dele, e os demais são anexados conforme ele chama (evento `step_add`).
   */
  const membros = time.topology === "supervisor" ? time.members.slice(0, 1) : time.members;

  const run: Run = {
    id: newRunId(),
    teamId,
    projectPath,
    goal,
    status: "running",
    createdAt: nowIso(),
    steps: membros.map((m, index) => ({
      index,
      agentId: m.agentId,
      ...(m.papel ? { papel: m.papel } : {}),
      ...(time.topology === "supervisor" ? { supervisor: true as const } : {}),
      status: "pending" as const,
    })),
  };
  const budget = limparBudget(input.budget);
  if (budget) run.budget = budget;
  saveRun(run, home);
  return run;
}

/** Última fala do assistente na conversa — é a saída do passo. */
function saidaDaThread(threadId: string, home: string): string {
  const eventos = readThread(threadId, home);
  for (let i = eventos.length - 1; i >= 0; i--) {
    const e = eventos[i];
    if (e?.type === "assistant") return e.text;
  }
  return "";
}

/** Motivo legível quando o turno não fechou em `done`. */
function motivoDoFim(threadId: string, home: string): string {
  const terminal = getLive(threadId)?.lastTerminal;
  if (terminal === "quota") return "quota estourou";
  if (terminal === "auth") return "conta precisa de login";
  if (terminal === "error") return "motor falhou";
  const eventos = readThread(threadId, home);
  for (let i = eventos.length - 1; i >= 0; i--) {
    const e = eventos[i];
    if (e?.type === "error") return e.message;
  }
  return "turno não terminou";
}

/**
 * O que um passo produziu, pronto pra virar entrada de outro. O supervisor usa
 * a mesma estrutura pro pedido que ele mesmo escreve — daí `arquivo` poder vir
 * vazio (não há artefato de uma ordem) e `titulo` poder trocar o rótulo.
 */
type Entrada = { agentId: string; papel?: string; texto: string; arquivo: string; titulo?: string };

/**
 * Pedido de um membro: objetivo do run, o papel dele e o que veio antes.
 * O papel entra aqui e não nas instruções do agente porque o mesmo agente pode
 * ocupar papéis diferentes em times diferentes.
 *
 * No pipeline chega uma entrada; no fan-in, o agregador recebe uma por membro
 * paralelo, cada uma identificada — sem isso ele não teria como saber quem
 * disse o quê.
 */
function montarPedido(run: Run, step: RunStep, entradas: Entrada[]): string {
  const partes = [`# Objetivo do time\n${run.goal}`];
  if (step.papel) partes.push(`# Seu papel\n${step.papel}`);
  if (entradas.length === 1) {
    const unica = entradas[0] as Entrada;
    partes.push(blocoDeEntrada(unica, unica.titulo ?? "Entrada (saída do passo anterior)"));
  } else if (entradas.length > 1) {
    partes.push(`# Entradas (${entradas.length} membros trabalharam em paralelo)`);
    for (const e of entradas) {
      partes.push(blocoDeEntrada(e, `## ${e.agentId}${e.papel ? ` — ${e.papel}` : ""}`));
    }
  }
  return partes.join("\n\n");
}

function blocoDeEntrada(e: Entrada, titulo: string): string {
  const cortado = e.texto.length > TRECHO_CHARS;
  return (
    `${titulo}\n${e.texto.slice(0, TRECHO_CHARS)}` +
    // sem artefato (pedido do supervisor) não há caminho pra apontar
    (cortado && e.arquivo ? `\n\n[cortado — o texto inteiro está em ${e.arquivo}]` : "") +
    (e.arquivo ? `\n\nArquivo com a entrada completa: ${e.arquivo}` : "")
  );
}

function gravarArtefato(run: Run, step: RunStep, saida: string, home: string): string {
  const dir = runDir(run.id, home);
  mkdirSync(dir, { recursive: true });
  const arquivo = join(dir, `passo-${step.index + 1}-${step.agentId}.md`);
  writeFileSync(arquivo, saida, "utf8");
  return arquivo;
}

/** Soma o que os passos já custaram — é contra isso que o orçamento é medido. */
function custoAteAgora(run: Run): number {
  return run.steps.reduce((total, s) => total + (s.costUsd ?? 0), 0);
}

/** Um passo do zero ao fim: conversa, pedido, espera, uso e artefato. */
async function executarPasso(
  run: Run,
  step: RunStep,
  entradas: Entrada[],
  home: string,
  /** Onde o passo trabalha; vazio = a pasta do projeto. */
  cwd?: string,
): Promise<Entrada | null> {
  const agente = getAgent(step.agentId, home);
  if (!agente) {
    return falharPasso(run, step, `agente não existe: ${step.agentId}`, home);
  }

  const { id: threadId } = createThread(
    { projectPath: cwd ?? run.projectPath, profileId: agente.profileId, agentId: agente.id },
    home,
  );
  step.threadId = threadId;
  step.status = "running";
  step.startedAt = nowIso();
  saveRun(run, home);
  emit(run, { type: "step_start", runId: run.id, index: step.index, agentId: step.agentId, threadId });

  try {
    await postMessage(threadId, montarPedido(run, step, entradas), home);
  } catch (e) {
    return falharPasso(run, step, (e as Error).message || "falhou ao mandar o pedido", home);
  }

  const uso = threadUsage(threadId, home);
  step.costUsd = uso.costUsd;
  step.tokens = uso.input + uso.output;

  if (getLive(threadId)?.lastTerminal !== "done") {
    return falharPasso(run, step, motivoDoFim(threadId, home), home);
  }

  const saida = saidaDaThread(threadId, home);
  step.artifact = gravarArtefato(run, step, saida, home);
  step.outputChars = saida.length;
  step.status = "done";
  step.endedAt = nowIso();
  saveRun(run, home);
  emit(run, { type: "step_done", runId: run.id, index: step.index, step });
  return {
    agentId: step.agentId,
    ...(step.papel ? { papel: step.papel } : {}),
    texto: saida,
    arquivo: step.artifact,
  };
}

function falharPasso(run: Run, step: RunStep, motivo: string, home: string): null {
  step.status = "error";
  step.error = motivo;
  step.endedAt = nowIso();
  saveRun(run, home);
  emit(run, { type: "step_done", runId: run.id, index: step.index, step });
  return null;
}

/** Motivo pra parar antes de gastar mais: abort, teto de passos ou orçamento. */
function motivoDeParar(run: Run, indice: number, teto: number): string | null {
  const vivo = vivos.get(run.id);
  if (!vivo || vivo.abortado) return "abortado";
  if (indice >= teto) return `teto de ${teto} passos`;
  const gasto = custoAteAgora(run);
  if (run.budget?.maxUsd !== undefined && gasto >= run.budget.maxUsd) {
    return `orçamento de US$ ${run.budget.maxUsd} estourado (US$ ${gasto.toFixed(4)})`;
  }
  return null;
}

/**
 * Pipeline: um por vez, a saída de um é a entrada do próximo.
 *
 * Falha PARA o run em vez de tentar de novo ou pular: o passo seguinte receberia
 * entrada vazia e produziria trabalho sem base, gastando quota pra piorar o
 * resultado. Retomar é decisão de quem está olhando.
 */
async function rodarPipeline(run: Run, teto: number, home: string): Promise<void> {
  let anterior: Entrada | null = null;
  for (const step of run.steps) {
    const parar = motivoDeParar(run, step.index, teto);
    if (parar) return pararRun(run, step, parar);
    const saida = await executarPasso(run, step, anterior ? [anterior] : [], home);
    if (!saida) {
      run.status = "error";
      run.error = step.error;
      return;
    }
    anterior = saida;
  }
}

/**
 * Fan-in: todos menos o último ao mesmo tempo, o último junta.
 *
 * Cada paralelo ganha uma árvore de trabalho própria quando o projeto é
 * repositório git (ver `prepararArvores`). Sem git eles dividem a pasta e quem
 * escreve arquivo sobrescreve o vizinho — o run registra isso em `isolationOff`.
 *
 * Falha de um paralelo não cancela os outros: eles já estão em voo e a quota já
 * foi gasta. Deixa terminar, e só então o agregador é pulado.
 */
async function rodarFanIn(run: Run, teto: number, home: string): Promise<void> {
  const paralelos = run.steps.slice(0, -1);
  const agregador = run.steps.at(-1);
  if (!agregador) return;

  // time de um membro só: não há o que juntar, roda igual ao pipeline
  if (!paralelos.length) return rodarPipeline(run, teto, home);

  const parar = motivoDeParar(run, paralelos.length, teto);
  if (parar) return pararRun(run, run.steps[0] as RunStep, parar);

  const arvores = await prepararArvores(run, paralelos, home);
  const saidas = await Promise.all(
    paralelos.map((step) => executarPasso(run, step, [], home, arvores.get(step.index))),
  );
  await fecharArvores(run, paralelos, home);
  const entradas = saidas.filter((e): e is Entrada => e !== null);

  if (entradas.length !== paralelos.length) {
    const quebrado = paralelos.find((s) => s.status === "error");
    agregador.status = "skipped";
    run.status = "error";
    run.error = quebrado?.error ?? "um membro em paralelo falhou";
    return;
  }

  const depois = motivoDeParar(run, run.steps.length - 1, teto);
  if (depois) return pararRun(run, agregador, depois);

  if (!(await executarPasso(run, agregador, entradas, home))) {
    run.status = "error";
    run.error = agregador.error;
  }
}


/* ---------- supervisor ---------- */

/** Anexa um passo que nasceu no meio do run. Só o supervisor produz isso. */
function anexarPasso(run: Run, agentId: string, papel: string | undefined, home: string): RunStep {
  const step: RunStep = {
    index: run.steps.length,
    agentId,
    ...(papel ? { papel } : {}),
    status: "pending",
  };
  run.steps.push(step);
  saveRun(run, home);
  emit(run, { type: "step_add", runId: run.id, step });
  return step;
}

/**
 * Um turno do supervisor, na conversa dele. A conversa é a MESMA do começo ao
 * fim: é o que faz ele lembrar do que já mandou fazer sem o daemon reenviar o
 * histórico a cada decisão.
 *
 * O uso é relido inteiro a cada turno porque `threadUsage` soma a conversa —
 * então `costUsd` do passo do supervisor é o acumulado das decisões, não o da
 * última.
 */
async function turnoDoSupervisor(run: Run, step: RunStep, pedido: string, home: string): Promise<string | null> {
  try {
    await postMessage(step.threadId as string, pedido, home);
  } catch (e) {
    step.error = (e as Error).message || "falhou ao pedir a decisão";
    return null;
  }
  const uso = threadUsage(step.threadId as string, home);
  step.costUsd = uso.costUsd;
  step.tokens = uso.input + uso.output;
  step.decisoes = (step.decisoes ?? 0) + 1;
  saveRun(run, home);
  if (getLive(step.threadId as string)?.lastTerminal !== "done") {
    step.error = motivoDoFim(step.threadId as string, home);
    return null;
  }
  return saidaDaThread(step.threadId as string, home);
}

/**
 * Pede uma decisão e insiste UMA vez se a resposta não der pra usar.
 *
 * Uma, e não zero: modelo que devolve o JSON dentro de uma explicação é comum, e
 * derrubar o run inteiro por formatação desperdiçaria tudo que já foi gasto.
 * Uma, e não N: se ele não acerta com o pedido de correção na mão, insistir só
 * queima quota — a decisão do que fazer volta pra quem está olhando.
 */
async function pedirDecisao(
  run: Run,
  step: RunStep,
  pedido: string,
  membros: Disponivel[],
  home: string,
): Promise<{ ok: true; d: Decisao } | { ok: false; motivo: string }> {
  let texto = await turnoDoSupervisor(run, step, pedido, home);
  if (texto === null) return { ok: false, motivo: step.error ?? "o supervisor não respondeu" };
  let lido = lerDecisao(texto, membros);
  if (lido.ok) return lido;

  texto = await turnoDoSupervisor(run, step, pedidoDeCorrecao(lido.erro), home);
  if (texto === null) return { ok: false, motivo: step.error ?? "o supervisor não respondeu" };
  lido = lerDecisao(texto, membros);
  if (lido.ok) return lido;
  return { ok: false, motivo: `o supervisor não respondeu no formato: ${lido.erro}` };
}

/**
 * Supervisor: o primeiro membro decide quem trabalha, um de cada vez, até
 * encerrar.
 *
 * Diferente das outras topologias, o teto de passos aqui é a única coisa entre
 * um objetivo mal escrito e um laço que gira gastando quota — o supervisor pode
 * chamar o mesmo membro pra sempre. Por isso ele vê quantas chamadas restam, e
 * o run para no teto mesmo que ele não queira parar.
 *
 * Falha de membro NÃO derruba o run: quem decide o que fazer com ela é o
 * supervisor, que é justamente quem tem contexto pra isso. É o oposto do
 * pipeline, onde não há ninguém pra decidir e seguir seria produzir sobre nada.
 */
async function rodarSupervisor(run: Run, teto: number, home: string): Promise<void> {
  const chefe = run.steps[0];
  const time = getTeam(run.teamId, home);
  if (!chefe || !time) return;

  const equipe = time.members.slice(1);
  const membros = listarDisponiveis(
    equipe.map((m) => getAgent(m.agentId, home)),
    equipe.map((m) => m.papel),
  );
  if (!membros.length) {
    falharPasso(run, chefe, "o time não tem ninguém pro supervisor chamar", home);
    run.status = "error";
    run.error = chefe.error;
    return;
  }

  const agente = getAgent(chefe.agentId, home);
  if (!agente) {
    falharPasso(run, chefe, `agente não existe: ${chefe.agentId}`, home);
    run.status = "error";
    run.error = chefe.error;
    return;
  }

  const { id: threadId } = createThread(
    { projectPath: run.projectPath, profileId: agente.profileId, agentId: agente.id },
    home,
  );
  chefe.threadId = threadId;
  chefe.status = "running";
  chefe.startedAt = nowIso();
  saveRun(run, home);
  emit(run, { type: "step_start", runId: run.id, index: 0, agentId: chefe.agentId, threadId });

  const restam = (): number => Math.max(0, teto - run.steps.length);
  let pedido = pedidoInicial(run.goal, chefe.papel, membros, restam());

  for (;;) {
    const parar = motivoDeParar(run, run.steps.length, teto);
    if (parar) return fecharSupervisor(run, chefe, parar, home);

    const decisao = await pedirDecisao(run, chefe, pedido, membros, home);
    if (!decisao.ok) {
      // abort derruba o turno em voo, e a resposta truncada chega aqui como
      // erro de formato: o motivo verdadeiro é o abort, não o JSON quebrado
      return fecharSupervisor(run, chefe, abortado(run.id) ? "abortado" : decisao.motivo, home);
    }

    const d = decisao.d;
    if (d.acao === "encerrar") {
      chefe.artifact = gravarArtefato(run, chefe, d.resumo, home);
      chefe.outputChars = d.resumo.length;
      chefe.status = "done";
      chefe.endedAt = nowIso();
      // O supervisor decidir seguir depois de um membro falhar é trabalho dele,
      // não sobra de erro: o run fecha em `done` mesmo com passo `error` no meio.
      run.status = "done";
      saveRun(run, home);
      emit(run, { type: "step_done", runId: run.id, index: 0, step: chefe });
      return;
    }

    const alvo = equipe.find((m) => m.agentId === d.membro);
    const step = anexarPasso(run, d.membro, alvo?.papel, home);
    const ordem: Entrada = {
      agentId: chefe.agentId,
      texto: d.pedido,
      arquivo: "",
      titulo: "# Pedido do supervisor",
    };
    const saida = await executarPasso(run, step, [ordem], home);
    pedido = saida
      ? pedidoDeVolta(step.agentId, saida.texto, saida.arquivo, restam(), TRECHO_CHARS)
      : pedidoDeFalha(step.agentId, step.error ?? "falhou sem motivo", restam());
  }
}

/**
 * Fecha o passo do supervisor quando o run parou por fora da vontade dele —
 * teto, orçamento, abort ou resposta inutilizável. `pararRun` não serve aqui:
 * ele marca o passo como `skipped`, e o supervisor rodou.
 */
function fecharSupervisor(run: Run, chefe: RunStep, motivo: string, home: string): void {
  chefe.endedAt = nowIso();
  if (motivo === "abortado") {
    chefe.status = "done";
    run.status = "aborted";
  } else {
    chefe.status = "error";
    chefe.error = motivo;
    run.status = "error";
    run.error = motivo;
  }
  saveRun(run, home);
  emit(run, { type: "step_done", runId: run.id, index: chefe.index, step: chefe });
}

/**
 * Uma árvore de trabalho por membro paralelo.
 *
 * Só no fan-in: no pipeline, compartilhar a árvore costuma ser o ponto — se o
 * primeiro escreve e o segundo revisa, separá-los faria o revisor não enxergar
 * nada. O problema de dois agentes escrevendo o mesmo arquivo só existe quando
 * eles rodam ao mesmo tempo.
 *
 * Projeto sem git ou sem commit não dá pra isolar; o run registra isso em
 * `isolationOff` em vez de fingir que isolou.
 */
async function prepararArvores(run: Run, passos: RunStep[], home: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const veredito = await podeIsolar(run.projectPath);
  if (!veredito.pode) {
    run.isolated = false;
    if (veredito.motivo) run.isolationOff = veredito.motivo;
    saveRun(run, home);
    return out;
  }
  for (const step of passos) {
    const dir = join(runDir(run.id, home), "wt", `${step.index + 1}-${step.agentId}`);
    const branch = nomeDoBranch(run.id, step.index, step.agentId);
    const r = await criarWorktree(run.projectPath, dir, branch);
    if (!r.ok) {
      // uma árvore que não nasce derruba o isolamento do lote inteiro: rodar
      // metade isolado e metade junto seria pior que não isolar
      for (const feito of out.values()) await removerWorktree(run.projectPath, feito);
      out.clear();
      run.isolated = false;
      run.isolationOff = r.motivo;
      saveRun(run, home);
      return out;
    }
    out.set(step.index, dir);
    step.worktree = dir;
    step.branch = branch;
  }
  run.isolated = true;
  delete run.isolationOff;
  saveRun(run, home);
  return out;
}

/**
 * Commita o que cada membro deixou e tira a árvore do disco. O BRANCH FICA —
 * é onde está o trabalho, e apagar sem ninguém ter olhado é o que não se faz.
 * Sem o commit, o `remove --force` levaria a mudança junto e o branch existiria
 * vazio.
 */
async function fecharArvores(run: Run, passos: RunStep[], home: string): Promise<void> {
  if (!run.isolated) return;
  for (const step of passos) {
    if (!step.worktree) continue;
    if (await temMudanca(step.worktree)) {
      await commitarTrabalho(step.worktree, `nexo: ${step.agentId} — ${run.goal.slice(0, 60)}`);
    }
    await removerWorktree(run.projectPath, step.worktree);
  }
  saveRun(run, home);
}

function pararRun(run: Run, step: RunStep, motivo: string): void {
  if (motivo === "abortado") {
    run.status = "aborted";
    return;
  }
  step.status = "skipped";
  run.status = "error";
  run.error = motivo;
}

/** Roda o time até o fim, até falhar ou até o orçamento acabar. */
export async function executarRun(run: Run, home: string): Promise<Run> {
  vivos.set(run.id, { run, abortado: false });
  emit(run, { type: "run_start", runId: run.id, teamId: run.teamId });

  const teto = Math.min(run.budget?.maxSteps ?? PASSOS_TETO, PASSOS_TETO);
  const time = getTeam(run.teamId, home);

  try {
    if (time?.topology === "fanin") await rodarFanIn(run, teto, home);
    else if (time?.topology === "supervisor") await rodarSupervisor(run, teto, home);
    else await rodarPipeline(run, teto, home);

    if (run.status === "running") {
      run.status = run.steps.every((s) => s.status === "done") ? "done" : "error";
      if (run.status === "error" && !run.error) run.error = "run terminou incompleto";
    }
  } finally {
    vivos.delete(run.id);
    run.endedAt = nowIso();
    saveRun(run, home);
    emit(run, {
      type: "run_end",
      runId: run.id,
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
    });
  }
  return run;
}

/** Para o run: marca a intenção e derruba o turno em voo do passo atual. */
export async function abortarRun(id: string): Promise<boolean> {
  const vivo = vivos.get(id);
  if (!vivo) return false;
  vivo.abortado = true;
  // no fan-in há vários em voo ao mesmo tempo: derruba todos
  const emVoo = vivo.run.steps.filter((s) => s.status === "running" && s.threadId);
  await Promise.all(emVoo.map((s) => abortThread(s.threadId as string)));
  return true;
}

/** Só pra teste: zera o estado em memória entre casos. */
export function resetRunsForTest(): void {
  vivos.clear();
}
