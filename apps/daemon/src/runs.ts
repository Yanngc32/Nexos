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
import { getTeam } from "./teams.ts";
import { createThread, readThread, threadUsage } from "./threads.ts";

/**
 * Execução de um time.
 *
 * O daemon orquestra de FORA: cria a conversa do membro, manda o pedido, espera
 * o turno fechar, lê a saída final e alimenta o próximo. Nada disso exige canal
 * de volta nem ferramenta nova no motor — é por isso que o pipeline vem antes do
 * supervisor, que precisaria decidir quem age no meio do turno.
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

  const run: Run = {
    id: newRunId(),
    teamId,
    projectPath,
    goal,
    status: "running",
    createdAt: nowIso(),
    steps: time.members.map((m, index) => ({
      index,
      agentId: m.agentId,
      ...(m.papel ? { papel: m.papel } : {}),
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
 * Pedido de um membro: objetivo do run, o papel dele e o que veio do anterior.
 * O papel entra aqui e não nas instruções do agente porque o mesmo agente pode
 * ocupar papéis diferentes em times diferentes.
 */
function montarPedido(run: Run, step: RunStep, anterior: { texto: string; arquivo: string } | null): string {
  const partes = [`# Objetivo do time\n${run.goal}`];
  if (step.papel) partes.push(`# Seu papel\n${step.papel}`);
  if (anterior) {
    const cortado = anterior.texto.length > TRECHO_CHARS;
    partes.push(
      `# Entrada (saída do passo anterior)\n${anterior.texto.slice(0, TRECHO_CHARS)}` +
        (cortado ? `\n\n[cortado — o texto inteiro está em ${anterior.arquivo}]` : ""),
    );
    partes.push(`Arquivo com a entrada completa: ${anterior.arquivo}`);
  }
  return partes.join("\n\n");
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

/**
 * Roda o pipeline até o fim, até falhar ou até o orçamento acabar.
 *
 * Falha PARA o run em vez de tentar de novo ou pular: o passo seguinte receberia
 * entrada vazia e produziria trabalho sem base, gastando quota pra piorar o
 * resultado. Retomar é decisão de quem está olhando.
 */
export async function executarRun(run: Run, home: string): Promise<Run> {
  vivos.set(run.id, { run, abortado: false });
  emit(run, { type: "run_start", runId: run.id, teamId: run.teamId });

  const teto = Math.min(run.budget?.maxSteps ?? PASSOS_TETO, PASSOS_TETO);
  let anterior: { texto: string; arquivo: string } | null = null;

  try {
    for (const step of run.steps) {
      const vivo = vivos.get(run.id);
      if (!vivo || vivo.abortado) {
        run.status = "aborted";
        break;
      }
      if (step.index >= teto) {
        step.status = "skipped";
        run.status = "error";
        run.error = `teto de ${teto} passos`;
        break;
      }
      const gasto = custoAteAgora(run);
      if (run.budget?.maxUsd !== undefined && gasto >= run.budget.maxUsd) {
        step.status = "skipped";
        run.status = "error";
        run.error = `orçamento de US$ ${run.budget.maxUsd} estourado (US$ ${gasto.toFixed(4)})`;
        break;
      }

      const agente = getAgent(step.agentId, home);
      if (!agente) {
        step.status = "error";
        step.error = `agente não existe: ${step.agentId}`;
        run.status = "error";
        run.error = step.error;
        break;
      }

      const { id: threadId } = createThread(
        { projectPath: run.projectPath, profileId: agente.profileId, agentId: agente.id },
        home,
      );
      step.threadId = threadId;
      step.status = "running";
      step.startedAt = nowIso();
      saveRun(run, home);
      emit(run, { type: "step_start", runId: run.id, index: step.index, agentId: step.agentId, threadId });

      try {
        await postMessage(threadId, montarPedido(run, step, anterior), home);
      } catch (e) {
        step.status = "error";
        step.error = (e as Error).message || "falhou ao mandar o pedido";
        step.endedAt = nowIso();
        run.status = "error";
        run.error = step.error;
        saveRun(run, home);
        emit(run, { type: "step_done", runId: run.id, index: step.index, step });
        break;
      }

      const uso = threadUsage(threadId, home);
      step.costUsd = uso.costUsd;
      step.tokens = uso.input + uso.output;

      if (getLive(threadId)?.lastTerminal !== "done") {
        step.status = "error";
        step.error = motivoDoFim(threadId, home);
        step.endedAt = nowIso();
        run.status = "error";
        run.error = step.error;
        saveRun(run, home);
        emit(run, { type: "step_done", runId: run.id, index: step.index, step });
        break;
      }

      const saida = saidaDaThread(threadId, home);
      step.artifact = gravarArtefato(run, step, saida, home);
      step.outputChars = saida.length;
      step.status = "done";
      step.endedAt = nowIso();
      anterior = { texto: saida, arquivo: step.artifact };
      saveRun(run, home);
      emit(run, { type: "step_done", runId: run.id, index: step.index, step });
    }

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
  const emVoo = vivo.run.steps.find((s) => s.status === "running");
  if (emVoo?.threadId) await abortThread(emVoo.threadId);
  return true;
}

/** Só pra teste: zera o estado em memória entre casos. */
export function resetRunsForTest(): void {
  vivos.clear();
}
