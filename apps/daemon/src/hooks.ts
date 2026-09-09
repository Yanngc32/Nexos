import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newHookRuleId } from "./ids.ts";
import { ensureHome, hooksPath, projectKey } from "./home.ts";
import { getAgent } from "./agents.ts";
import { ensureGraphifyInstalled } from "./graphify.ts";
import {
  ensureGitignoreEntry,
  GIT_HOOK_FILES,
  installGitHookScript,
  uninstallGitHookScript,
} from "./git-hooks.ts";
import { memoriaPath } from "./memoria.ts";
import { criarRun, executarRun } from "./runs.ts";
import { projetosConhecidos } from "./threads.ts";
import { getTeam, upsertTimeDeHook } from "./teams.ts";
import { consumirVeredito } from "./veredito.ts";

/**
 * Nexo Hooks v2: regra configurável (escopo global ou de um projeto,
 * evento, branch opcional, bloqueio opcional), não mais uma config fixa por
 * projeto. Ver docs/superpowers/specs/2026-09-09-memoria-projeto-design.md.
 *
 * O despacho (`fireHook`) não sabe nada de git — só "acha regra que casa,
 * executa a ação". `git-hooks.ts` cuida da mecânica do lado do `.git/hooks`;
 * este arquivo não sabe disso.
 */

export type EscopoHook = { tipo: "global" } | { tipo: "projeto"; projectPath: string };

export type RegraHook = {
  id: string;
  /** Rótulo livre pra achar a regra na lista — sem isso a UI só tem evento+escopo pra diferenciar. */
  nome?: string;
  descricao?: string;
  escopo: EscopoHook;
  evento: string;
  /** Nome exato de branch — vazio/ausente casa qualquer uma. Só faz sentido nos eventos de push. */
  branch?: string;
  /**
   * Exatamente um dos dois. `agentId` é o caso simples — o daemon embrulha num time-pipeline-de-1
   * oculto (`upsertTimeDeHook`). `teamId` aponta pra um time DE VERDADE já criado (Team Studio) —
   * pipeline com revisão, fan-in, supervisor, o que a pessoa já tiver montado.
   */
  agentId?: string;
  teamId?: string;
  /**
   * Só tem efeito em `git.pre-push` — é o único evento que roda ANTES da ação
   * existir (dá pra abortar). `post-commit`/`post-push` já aconteceram: mesmo
   * marcado, nunca bloqueiam (fisicamente não tem o que abortar).
   */
  bloqueante?: boolean;
};

/**
 * Os eventos que o Nexo dispara hoje. Despacho é genérico (`fireHook` não sabe o que é git) — os
 * três `git.*` têm script em `.git/hooks/` por trás (ver `sincronizarHooksDoProjeto`);
 * `nexo.projeto-novo` não tem script nenhum, é o PRÓPRIO daemon quem detecta e dispara (ver
 * `POST /v1/threads`, http.ts) na primeira vez que um projeto é aberto no Nexo.
 */
export const HOOK_EVENTS = ["git.post-commit", "git.post-push", "git.pre-push", "nexo.projeto-novo"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Só os eventos de push têm branch remota de verdade — post-commit e o evento de projeto não. */
const EVENTOS_COM_BRANCH = new Set<string>(["git.post-push", "git.pre-push"]);

/** `<categoria>.<nome>` — recusa qualquer coisa fora disso, inclusive vindo de fora (HTTP). */
export const HOOK_EVENT_RE = /^[a-z]+\.[a-z-]+$/;

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function notFound(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 404;
  return err;
}

type RulesFile = { rules: RegraHook[] };

function isEscopo(v: unknown): v is EscopoHook {
  if (!v || typeof v !== "object") return false;
  const o = v as { tipo?: unknown; projectPath?: unknown };
  if (o.tipo === "global") return true;
  return o.tipo === "projeto" && typeof o.projectPath === "string" && o.projectPath.trim().length > 0;
}

function readAll(home: string): RegraHook[] {
  ensureHome(home);
  const path = hooksPath(home);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RulesFile>;
    const list = raw?.rules;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (r): r is RegraHook =>
        typeof r?.id === "string" &&
        typeof r?.evento === "string" &&
        (typeof r?.agentId === "string" || typeof r?.teamId === "string") &&
        isEscopo(r?.escopo),
    );
  } catch {
    // Mesma escolha do agents.ts/teams.ts: arquivo corrompido não derruba o daemon.
    return [];
  }
}

function writeAll(list: RegraHook[], home: string): void {
  ensureHome(home);
  writeFileSync(hooksPath(home), JSON.stringify({ rules: list }, null, 2), "utf8");
}

export function listarRegras(home: string): RegraHook[] {
  return readAll(home);
}

export function getRegra(id: string, home: string): RegraHook | undefined {
  return readAll(home).find((r) => r.id === id);
}

/** O que o cliente manda pra criar/editar. Mesmo formato de `TeamInput`: `id` só existe já criado. */
export type RegraInput = {
  nome?: string;
  descricao?: string;
  escopo?: { tipo?: string; projectPath?: string };
  evento?: string;
  branch?: string;
  agentId?: string;
  teamId?: string;
  bloqueante?: boolean;
};

const NOME_MAX = 60;
const DESCRICAO_MAX = 200;

function limparTexto(v: unknown, campo: string, max: number): string {
  if (typeof v !== "string") throw badRequest(`${campo} inválido`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${campo} passa de ${max} caracteres`);
  return t;
}

function limparEscopo(v: RegraInput["escopo"]): EscopoHook {
  if (!v || typeof v !== "object") throw badRequest("escopo obrigatório");
  if (v.tipo === "global") return { tipo: "global" };
  if (v.tipo === "projeto") {
    const projectPath = typeof v.projectPath === "string" ? v.projectPath.trim() : "";
    if (!projectPath) throw badRequest("escopo de projeto precisa de projectPath");
    return { tipo: "projeto", projectPath };
  }
  throw badRequest(`escopo inválido: ${String(v.tipo)}`);
}

function limparEvento(v: unknown): string {
  if (typeof v !== "string" || !(HOOK_EVENTS as readonly string[]).includes(v)) {
    throw badRequest(`evento inválido: ${String(v)}`);
  }
  return v;
}

function limparBranch(v: unknown, evento: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !BRANCH_RE.test(v)) throw badRequest("branch inválido");
  // Recusa em vez de aceitar e ignorar em silêncio — passaria confiança de um filtro que nunca vale.
  if (!EVENTOS_COM_BRANCH.has(evento)) throw badRequest(`branch não se aplica a ${evento}`);
  return v;
}

function limparAgentId(v: unknown, home: string): string {
  if (typeof v !== "string" || !v.trim()) throw badRequest("agentId obrigatório");
  const agentId = v.trim();
  if (!getAgent(agentId, home)) throw badRequest(`agente não existe: ${agentId}`);
  return agentId;
}

function limparTeamId(v: unknown, home: string): string {
  if (typeof v !== "string" || !v.trim()) throw badRequest("teamId obrigatório");
  const teamId = v.trim();
  if (!getTeam(teamId, home)) throw badRequest(`time não existe: ${teamId}`);
  return teamId;
}

/** Cria ou atualiza (com `id` já existente). Sem teto de regra: risco de segurança não deve competir por vaga. */
export function saveRegra(input: RegraInput & { id?: string }, home: string): RegraHook {
  const list = readAll(home);
  const atual = input.id ? list.find((r) => r.id === input.id) : undefined;
  if (input.id && !atual) throw notFound(`regra não existe: ${input.id}`);

  const evento = input.evento === undefined ? atual?.evento : limparEvento(input.evento);
  if (!evento) throw badRequest("evento obrigatório");
  const escopo = input.escopo === undefined ? atual?.escopo : limparEscopo(input.escopo);
  if (!escopo) throw badRequest("escopo obrigatório");

  // Exatamente um dos dois: trocar de agentId pra teamId (ou vice-versa) apaga o outro, não
  // acumula os dois pendurados na regra depois de uma edição.
  if (input.agentId !== undefined && input.teamId !== undefined) {
    throw badRequest("escolha agentId OU teamId, não os dois");
  }
  let agentId = atual?.agentId;
  let teamId = atual?.teamId;
  if (input.agentId !== undefined) {
    agentId = limparAgentId(input.agentId, home);
    teamId = undefined;
  } else if (input.teamId !== undefined) {
    teamId = limparTeamId(input.teamId, home);
    agentId = undefined;
  }
  if (!agentId && !teamId) throw badRequest("agentId ou teamId obrigatório");

  const branch = input.branch === undefined ? atual?.branch : limparBranch(input.branch, evento);
  const nome = input.nome === undefined ? atual?.nome : limparTexto(input.nome, "nome", NOME_MAX);
  const descricao =
    input.descricao === undefined ? atual?.descricao : limparTexto(input.descricao, "descrição", DESCRICAO_MAX);
  // Bloqueio só existe fisicamente em pre-push — guardar `true` noutro evento seria um campo que
  // mente sobre o que a regra faz.
  const bloqueanteBruto = input.bloqueante === undefined ? atual?.bloqueante : Boolean(input.bloqueante);
  const bloqueante = evento === "git.pre-push" ? bloqueanteBruto : undefined;

  const def: RegraHook = {
    id: atual?.id ?? newHookRuleId(),
    ...(nome ? { nome } : {}),
    ...(descricao ? { descricao } : {}),
    escopo,
    evento,
    ...(agentId ? { agentId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(branch ? { branch } : {}),
    ...(bloqueante ? { bloqueante: true } : {}),
  };
  writeAll(atual ? list.map((r) => (r.id === def.id ? def : r)) : [...list, def], home);
  sincronizarAposMudanca(escopo, atual?.escopo, home);
  // Regra NOVA (não edição) de post-commit/post-push: provavelmente alguém quer o agente
  // rodando `graphify` depois do commit — best-effort, fire-and-forget, nunca lança.
  if (!atual && (evento === "git.post-commit" || evento === "git.post-push")) {
    void ensureGraphifyInstalled();
  }
  return def;
}

export function apagarRegra(id: string, home: string): void {
  const list = readAll(home);
  const alvo = list.find((r) => r.id === id);
  if (!alvo) throw notFound(`regra não existe: ${id}`);
  writeAll(
    list.filter((r) => r.id !== id),
    home,
  );
  sincronizarAposMudanca(undefined, alvo.escopo, home);
}

/** Regras cujo escopo bate (global OU este projeto) — evento/branch entram por fora, em `fireHook`/`dispararPrePush`. */
export function regrasDoEscopo(regras: RegraHook[], projectPath: string): RegraHook[] {
  const alvo = projectKey(projectPath);
  return regras.filter((r) => r.escopo.tipo === "global" || projectKey(r.escopo.projectPath) === alvo);
}

function regrasCasando(regras: RegraHook[], projectPath: string, event: string, branch: string): RegraHook[] {
  return regrasDoEscopo(regras, projectPath).filter(
    (r) => r.evento === event && (!r.branch || r.branch === branch),
  );
}

/**
 * Garante em `.git/hooks/` exatamente os scripts que as regras deste projeto (globais + dele)
 * ainda precisam — instala o que falta, remove o que nenhuma regra mais pede. Chamada sempre que
 * uma regra muda (ver `sincronizarAposMudanca`) e quando um projeto é aberto/adicionado (ver
 * `POST /v1/threads`, http.ts) — cobre o caso de regra global criada antes deste projeto existir
 * pro Nexo. Silenciosa fora de um repositório git: nada a instalar.
 */
export function sincronizarHooksDoProjeto(projectPath: string, home: string): void {
  if (!existsSync(join(projectPath, ".git"))) return;
  const necessarios = new Set(regrasDoEscopo(readAll(home), projectPath).map((r) => r.evento));
  for (const event of Object.keys(GIT_HOOK_FILES)) {
    if (necessarios.has(event)) installGitHookScript(projectPath, event);
    else uninstallGitHookScript(projectPath, event);
  }
  ensureGitignoreEntry(projectPath, "graphify-out/");
}

/**
 * Regra global mudou: toda a base de projetos conhecidos precisa ser reconferida.
 *
 * Por projeto, não em bloco: um projeto com problema no `.git/hooks/` (pasta apagada, sem
 * permissão de escrita, disco removível desconectado) não pode derrubar a sincronização dos
 * OUTROS — isso já aconteceu como efeito colateral de ligar um módulo (`grafoAuto`) que cria
 * regra global: um projeto ruim jogava a exceção até o `PUT /v1/config`, que devolvia erro, e o
 * checkbox na tela desfazia sozinho (o front reverte no erro) mesmo a regra tendo sido criada.
 */
export function sincronizarHooksGlobal(home: string): void {
  for (const projectPath of projetosConhecidos(home)) {
    try {
      sincronizarHooksDoProjeto(projectPath, home);
    } catch (e) {
      console.error(`sincronizar hooks (${projectPath}):`, (e as Error).message || e);
    }
  }
}

/**
 * Uma regra global (criada, editada ou apagada) exige varrer TODOS os projetos conhecidos — o
 * gate pode ter passado a valer (ou parado de valer) em qualquer um deles. Uma regra de projeto
 * só mexe naquele projeto — e no antigo também, se `atualizarRegra` trocou o escopo dela pra
 * outro projeto (senão o antigo ficaria com um script órfão que nenhuma regra mais pede).
 */
function sincronizarAposMudanca(novo: EscopoHook | undefined, antigo: EscopoHook | undefined, home: string): void {
  if (novo?.tipo === "global" || antigo?.tipo === "global") {
    sincronizarHooksGlobal(home);
    return;
  }
  const novoPath = novo?.tipo === "projeto" ? novo.projectPath : undefined;
  const antigoPath = antigo?.tipo === "projeto" ? antigo.projectPath : undefined;
  // Mesma razão do `sincronizarHooksGlobal`: problema no `.git/hooks/` de UM projeto não pode
  // derrubar a resposta de quem só queria criar/editar/apagar a regra.
  for (const p of antigoPath && antigoPath !== novoPath ? [novoPath, antigoPath] : [novoPath]) {
    if (!p) continue;
    try {
      sincronizarHooksDoProjeto(p, home);
    } catch (e) {
      console.error(`sincronizar hooks (${p}):`, (e as Error).message || e);
    }
  }
}

/**
 * Meta (o "pedido") que o run de uma regra recebe. Genérica de propósito — uma regra pode apontar
 * pra QUALQUER agente, não só o de memória, e o `goal` não pode presumir o papel de quem vai ler.
 * O caminho de memória entra como dica condicional ("se você for..."), não como ordem: é o único
 * fato que só o daemon sabe (fora do projeto, varia por instalação — `memoriaDir` configurável) e
 * que faz sentido pra um agente de memória, mas é ruído inofensivo pra qualquer outro.
 */
function metaDoEvento(event: string, projectPath: string, branch: string, home: string): string {
  const contexto = `Evento \`${event}\` disparado no projeto ${projectPath}${branch ? ` (branch \`${branch}\`)` : ""}.`;
  const dica = `Se você for o agente de memória de projeto: escreva/atualize ${memoriaPath(projectPath, home)} (crie o arquivo se não existir).`;
  return `${contexto}\n\n${dica}`;
}

/** Mesma meta do evento, com a instrução de veredito obrigatória — só pra regra BLOQUEANTE de pre-push. */
function metaDePrePushBloqueante(projectPath: string, branch: string, home: string): string {
  return `${metaDoEvento("git.pre-push", projectPath, branch, home)}

Ao terminar sua análise, chame OBRIGATORIAMENTE a ferramenta \`nexo_veredito\` com
\`{ aprovado: boolean, motivo: string }\` — é como você decide se o \`git push\` é liberado ou
barrado. Sem essa chamada, o push é reprovado por padrão.`;
}

/**
 * Instruções do agente "memória" — usadas quando a UI cria esse agente pela
 * primeira vez ao configurar uma regra. Mesmo critério de "o que vale
 * memorizar" que orienta a própria memória do Claude Code.
 */
export const MEMORIA_AGENT_INSTRUCTIONS = `Leia o \`git diff\` desde o último commit que você já registrou (o hash fica
numa linha \`<!-- commit: <hash> -->\` no fim do MEMORIA.md atual, se existir) e,
se existir, \`graphify-out/GRAPH_REPORT.md\`.

Escreva ou atualize o MEMORIA.md só com fatos NOVOS ou DIFERENTES do que já
está lá: arquitetura, convenção do projeto, decisão não-óbvia, causa-raiz de
bug corrigido. Não resuma o diff linha a linha — isso é o que \`git log\` já
mostra. Termine o arquivo com uma linha \`<!-- commit: <hash> -->\` marcando até
onde você leu.`;

/** Chave de coalescência: por projeto+evento, não por regra — várias regras do mesmo par disparam juntas. */
function chaveDe(projectPath: string, event: string): string {
  return `${projectKey(projectPath)}::${event}`;
}

/** Projetos+evento com uma execução de hook em voo agora. */
const emVoo = new Set<string>();
/** Fire que chegou enquanto já tinha um em voo — roda de novo uma vez ao terminar. */
const pendente = new Map<string, { regras: RegraHook[]; branch: string }>();

/**
 * O time que uma regra roda: `teamId` já é um time de verdade; `agentId` é embrulhado num
 * time-pipeline-de-1 oculto na hora (idempotente — chamar de novo pro mesmo agente atualiza o
 * MESMO registro, não duplica). Uma regra sempre tem exatamente um dos dois (`saveRegra` garante).
 */
function teamIdDaRegra(regra: RegraHook, home: string): string {
  if (regra.teamId) return regra.teamId;
  return upsertTimeDeHook(regra.agentId as string, home).id;
}

/** Roda cada regra (uma run por regra), nunca rejeita — ver `dispararFireAndForget`. */
async function executarRegras(
  regras: RegraHook[],
  projectPath: string,
  event: string,
  branch: string,
  home: string,
  chave: string,
): Promise<void> {
  try {
    const goal = metaDoEvento(event, projectPath, branch, home);
    for (const regra of regras) {
      const run = criarRun({ teamId: teamIdDaRegra(regra, home), projectPath, goal }, home);
      await executarRun(run, home);
    }
  } catch (e) {
    console.error(`nexo hook (${chave}):`, (e as Error).message || e);
  } finally {
    emVoo.delete(chave);
    // Commit em cima de commit enquanto o agente ainda rodava: o diff mais recente só é lido do
    // zero na PRÓXIMA rodada, então uma execução extra (não uma por fire) já cobre tudo que
    // chegou no meio.
    const atrasada = pendente.get(chave);
    if (atrasada) {
      pendente.delete(chave);
      emVoo.add(chave);
      void executarRegras(atrasada.regras, projectPath, event, atrasada.branch, home, chave);
    }
  }
}

/**
 * Dispara regras SEM esperar (post-commit/post-push, e as `pre-push` não-bloqueantes) — quem
 * chama (endpoint HTTP, chamado por um `curl` de hook de git com timeout curto) precisa responder
 * rápido. Coalescido por `projeto::evento`.
 */
function dispararFireAndForget(
  regras: RegraHook[],
  projectPath: string,
  event: string,
  branch: string,
  home: string,
): boolean {
  if (!regras.length) return false;
  const chave = chaveDe(projectPath, event);
  if (emVoo.has(chave)) {
    pendente.set(chave, { regras, branch });
    return false;
  }
  emVoo.add(chave);
  void executarRegras(regras, projectPath, event, branch, home, chave);
  return true;
}

/**
 * Despacha `git.post-commit`/`git.post-push` (sempre fire-and-forget — já aconteceram, não tem o
 * que bloquear) e `git.pre-push` (delega pra `dispararPrePush`, que é quem decide o veredito).
 */
export function fireHook(event: string, projectPath: string, home: string, branch = ""): { disparado: boolean } {
  if (!HOOK_EVENT_RE.test(event)) throw badRequest(`evento inválido: ${event}`);
  const regras = regrasCasando(readAll(home), projectPath, event, branch);
  return { disparado: dispararFireAndForget(regras, projectPath, event, branch, home) };
}

/**
 * Fluxo bloqueante de `git.pre-push`: roda cada regra BLOQUEANTE em série, síncrono, parando na
 * primeira reprovação; as não-bloqueantes (mesmo casando `pre-push`) só disparam em segundo
 * plano, sem atrasar a resposta. Só libera o push se TODA regra bloqueante aprovar.
 */
export async function dispararPrePush(
  projectPath: string,
  branch: string,
  home: string,
): Promise<{ aprovado: boolean; motivo: string }> {
  const casando = regrasCasando(readAll(home), projectPath, "git.pre-push", branch);
  const bloqueantes = casando.filter((r) => r.bloqueante);
  const naoBloqueantes = casando.filter((r) => !r.bloqueante);

  if (naoBloqueantes.length) dispararFireAndForget(naoBloqueantes, projectPath, "git.pre-push", branch, home);
  if (!bloqueantes.length) return { aprovado: true, motivo: "sem regra bloqueante" };

  const goal = metaDePrePushBloqueante(projectPath, branch, home);
  for (const regra of bloqueantes) {
    const run = criarRun({ teamId: teamIdDaRegra(regra, home), projectPath, goal }, home);
    try {
      await executarRun(run, home);
    } catch (e) {
      return { aprovado: false, motivo: `erro na regra ${regra.id}: ${(e as Error).message || e}` };
    }
    const veredito = consumirVeredito(run.id);
    if (!veredito.aprovado) return veredito;
  }
  return { aprovado: true, motivo: "todas as regras bloqueantes aprovaram" };
}

/** Só pra teste: o estado de coalescência é de módulo e vaza entre casos (veredito é `resetVereditoForTest`, em veredito.ts). */
export function resetHooksForTest(): void {
  emVoo.clear();
  pendente.clear();
}
