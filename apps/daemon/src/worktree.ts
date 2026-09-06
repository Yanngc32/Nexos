import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Isolamento de árvore de trabalho para membros que rodam em paralelo.
 *
 * O problema: no fan-in, N membros rodam ao mesmo tempo no MESMO diretório do
 * projeto. Dois agentes editando o mesmo arquivo se destroem — e o prejuízo é
 * silencioso, porque cada um acha que escreveu.
 *
 * A solução é `git worktree`: cada membro paralelo ganha uma árvore própria do
 * mesmo repositório, num branch próprio. Eles compartilham o histórico e não
 * compartilham arquivo nenhum.
 *
 * O que este módulo NÃO faz, de propósito: merge. Juntar trabalho de agente
 * automaticamente é onde se perde confiança rápido — o branch fica lá, com nome
 * previsível, e quem decide o que fazer com ele é uma pessoa.
 */

export type ResultadoGit = { ok: boolean; saida: string };

/** git assíncrono: `worktree add` copia a árvore e pode levar segundos num repo grande. */
function git(args: string[], cwd: string): Promise<ResultadoGit> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let saida = "";
    child.stdout.on("data", (b: Buffer) => (saida += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (saida += b.toString("utf8")));
    child.on("error", (e) => resolvePromise({ ok: false, saida: e.message }));
    child.on("close", (code) => resolvePromise({ ok: code === 0, saida: saida.trim() }));
  });
}

/**
 * Dá pra isolar aqui? Precisa ser repositório git E ter pelo menos um commit —
 * `worktree add` parte de um ponto do histórico, e repo recém-criado não tem
 * ponto nenhum.
 */
export async function podeIsolar(projectPath: string): Promise<{ pode: boolean; motivo?: string }> {
  const dir = resolve(projectPath);
  if (!existsSync(dir)) return { pode: false, motivo: "a pasta do projeto não existe" };
  const repo = await git(["rev-parse", "--is-inside-work-tree"], dir);
  if (!repo.ok || repo.saida.trim() !== "true") {
    return { pode: false, motivo: "o projeto não é um repositório git" };
  }
  const head = await git(["rev-parse", "--verify", "HEAD"], dir);
  if (!head.ok) return { pode: false, motivo: "o repositório ainda não tem commit" };
  return { pode: true };
}

/** Nome do branch de um passo. Previsível de propósito: é por ele que se acha o trabalho depois. */
export function nomeDoBranch(runId: string, index: number, agentId: string): string {
  return `nexo/${runId}/${index + 1}-${agentId}`;
}

export type Worktree = { dir: string; branch: string };

/**
 * Cria a árvore do passo. O branch nasce do HEAD atual, então todo membro
 * paralelo parte do mesmo ponto — que é o que faz o resultado deles ser
 * comparável.
 */
export async function criarWorktree(
  projectPath: string,
  dir: string,
  branch: string,
): Promise<{ ok: true; wt: Worktree } | { ok: false; motivo: string }> {
  const repo = resolve(projectPath);
  const r = await git(["worktree", "add", "-b", branch, dir, "HEAD"], repo);
  if (!r.ok) return { ok: false, motivo: r.saida || "git worktree add falhou" };
  return { ok: true, wt: { dir, branch } };
}

/**
 * Tira a árvore do disco. O BRANCH FICA: é ele que guarda o que o agente fez, e
 * apagar trabalho sem alguém ter olhado é exatamente o que não se deve fazer.
 */
export async function removerWorktree(projectPath: string, dir: string): Promise<ResultadoGit> {
  const repo = resolve(projectPath);
  // --force porque o agente quase sempre deixa mudança não commitada
  const r = await git(["worktree", "remove", "--force", dir], repo);
  if (r.ok) return r;
  // árvore já sumiu do disco por fora: `prune` limpa o registro e não é erro
  await git(["worktree", "prune"], repo);
  return r;
}

/** Houve mudança na árvore? É o que diz se o branch tem algo pra olhar. */
export async function temMudanca(dir: string): Promise<boolean> {
  const r = await git(["status", "--porcelain"], dir);
  return r.ok && r.saida.length > 0;
}

/**
 * Commita o que o agente deixou, pra mudança não ficar solta numa árvore que
 * vai ser removida. Sem isso o `worktree remove --force` levaria o trabalho
 * junto — o branch existiria e estaria vazio.
 */
export async function commitarTrabalho(dir: string, mensagem: string): Promise<ResultadoGit> {
  const add = await git(["add", "-A"], dir);
  if (!add.ok) return add;
  return git(["commit", "--no-verify", "-m", mensagem], dir);
}
