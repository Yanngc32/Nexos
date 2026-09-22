import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { git, type ResultadoGit } from "./git.ts";

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

export type { ResultadoGit };

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

/**
 * Nome do branch de um passo. Previsível de propósito: é por ele que se acha o
 * trabalho depois.
 *
 * A tentativa entra a partir da segunda (`-r2`, `-r3`): o branch da tentativa
 * anterior continua no repositório, com o que aquele agente fez, e reusar o
 * nome faria o `worktree add -b` recusar — ou, pior, sobrescrever trabalho que
 * ninguém olhou ainda.
 */
export function nomeDoBranch(runId: string, index: number, agentId: string, tentativa = 1): string {
  const base = `nexo/${runId}/${index + 1}-${agentId}`;
  return tentativa > 1 ? `${base}-r${tentativa}` : base;
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
  // `worktree add` copia a árvore inteira pro disco: num monorepo grande passa
  // dos 30s padrão de `git()`, e morrer no meio deixaria o passo sem árvore por
  // um teto que é pra comando de leitura, não pra cópia de repositório.
  const r = await git(["worktree", "add", "-b", branch, dir, "HEAD"], repo, 10 * 60_000);
  if (!r.ok) return { ok: false, motivo: r.saida || "git worktree add falhou" };
  return { ok: true, wt: { dir, branch } };
}

/**
 * Abre a árvore numa branch que JÁ EXISTE (ao contrário de `criarWorktree`,
 * que sempre nasce uma nova a partir do HEAD) — é o que uma conversa com
 * branch fixa escolhida pela pessoa precisa: `git worktree add <dir> <branch>`,
 * sem `-b`.
 *
 * O git recusa isto se a branch já estiver em checkout noutra árvore viva
 * (inclusive a pasta principal do projeto) — quem chama decide o que fazer
 * com esse erro (threads.ts reaproveita a árvore existente quando é o caso).
 */
export async function abrirWorktree(
  projectPath: string,
  dir: string,
  branch: string,
): Promise<{ ok: true; wt: Worktree } | { ok: false; motivo: string }> {
  const repo = resolve(projectPath);
  const r = await git(["worktree", "add", dir, branch], repo, 10 * 60_000);
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

/**
 * A limpeza dos branches que o fan-in deixa.
 *
 * O `removerWorktree` tira a árvore e DEIXA o branch, de propósito — é ele que
 * guarda o que o agente fez. O efeito acumulado é que um repositório com uso
 * regular de time junta um branch por membro por run, pra sempre, e ninguém tem
 * paciência de apagar dezenas à mão.
 *
 * O que faz isto ser seguro é o critério: só sai o que JÁ ESTÁ no HEAD, ou seja
 * o que apagar não perde commit nenhum. O resto continua listado, com a idade,
 * pra você decidir.
 */

export type BranchNexo = {
  branch: string;
  /** `nexo/<run>/<n>-<agente>`: o segundo pedaço é o run que o criou. */
  runId: string;
  /** Já está no HEAD — apagar não perde commit. */
  mesclado: boolean;
  /** Data do último commit, ISO. É o que diz a idade do trabalho parado ali. */
  ultimo: string;
};

function runIdDoBranch(branch: string): string {
  return branch.split("/")[1] ?? "";
}

/**
 * Lista os branches `nexo/*` do repositório, dizendo quais já estão no HEAD.
 *
 * **"Mesclado" é sempre em relação ao HEAD atual**, e isso erra pro lado seguro:
 * se você está num branch qualquer, trabalho que já entrou no `main` mas não
 * neste HEAD aparece como não mesclado e é PRESERVADO. O contrário — apagar
 * porque estava mesclado em outro lugar — é que seria perda.
 */
export async function listarBranchesNexo(projectPath: string): Promise<BranchNexo[]> {
  const repo = resolve(projectPath);
  const todos = await git(["for-each-ref", "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads/nexo"], repo);
  if (!todos.ok || !todos.saida) return [];
  const mesclados = await git(["for-each-ref", "--merged", "HEAD", "--format=%(refname:short)", "refs/heads/nexo"], repo);
  const noHead = new Set(mesclados.ok ? mesclados.saida.split("\n").map((l) => l.trim()).filter(Boolean) : []);

  return todos.saida
    .split("\n")
    .map((linha) => linha.split("\t"))
    .filter(([branch]) => Boolean(branch))
    .map(([branch, data]) => ({
      branch: branch!,
      runId: runIdDoBranch(branch!),
      mesclado: noHead.has(branch!),
      ultimo: data ?? "",
    }));
}

export type Apagado = { branch: string; ok: boolean; saida: string };

/**
 * Apaga os branches pedidos, um por vez.
 *
 * Um por vez, e não numa chamada só, porque com vários nomes o git devolve UM
 * código de saída pro lote: dava pra saber que algo falhou, não o quê. Aqui a
 * lista é curta e cada resposta fica atrelada ao seu branch.
 *
 * `-d` (minúsculo) sempre: é o próprio git quem recusa branch com commit fora
 * do HEAD e branch em checkout numa árvore viva — inclusive de run que está
 * rodando agora. Duplicar essa checagem aqui seria arriscar discordar dele.
 * Quem quer forçar usa `git branch -D` e assume.
 */
export async function apagarBranchesNexo(projectPath: string, branches: string[]): Promise<Apagado[]> {
  const repo = resolve(projectPath);
  const feitos: Apagado[] = [];
  for (const branch of branches) {
    // só o que este módulo cria: um nome vindo de fora não apaga branch de pessoa
    if (!branch.startsWith("nexo/")) {
      feitos.push({ branch, ok: false, saida: "não é branch do Nexo" });
      continue;
    }
    const r = await git(["branch", "-d", branch], repo);
    feitos.push({ branch, ok: r.ok, saida: r.saida });
  }
  return feitos;
}
