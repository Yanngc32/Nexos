import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { log } from "./log.ts";
import { dirname, join, resolve, sep } from "node:path";
import type { ThreadEvent } from "@nexos/shared";
import { loadConfig } from "./config.ts";
import { listarBranches } from "./git.ts";
import { ensureHome, threadPath, threadWorktreeDir } from "./home.ts";
import { assertSlug, newThreadId } from "./ids.ts";
import { getProfile, listProfiles } from "./profiles.ts";
import { projectDir, projectSlug, projetosRoot } from "./projeto-dir.ts";
import { abrirWorktree, podeIsolar, removerWorktree, worktreeDaBranch } from "./worktree.ts";

function nowIso(): string {
  return new Date().toISOString();
}

export type CreatedThread = { id: string };

export type CreateThreadInput = {
  /** Ausente = conversa global, sem projeto (chat geral). */
  projectPath?: string;
  profileId: string;
  title?: string;
  agentId?: string;
  runId?: string;
  runStep?: number;
  runTitle?: string;
  mcpConfig?: string;
  mcpTools?: string[];
  mcpRunId?: string;
  /** Branch fixa desta conversa; só grava algo se vier junto de `worktreeDir` (ver `createThreadNaBranch`). */
  branch?: string;
  worktreeDir?: string;
  /** Ver `thread_meta.semRoteamento`. */
  semRoteamento?: boolean;
  /** Ver `thread_meta.origemThreadId`. */
  origemThreadId?: string;
  /** Ver `thread_meta.oculta`. */
  oculta?: boolean;
  /** Ver `thread_meta.planejamento`. */
  planejamento?: { slug: string };
  /** Ver `thread_meta.handoff`. */
  handoff?: { slug: string };
};

export function createThread(input: CreateThreadInput, home: string, opts: { id?: string } = {}): CreatedThread {
  ensureHome(home);
  const profile = getProfile(input.profileId, home);
  if (!profile) throw new Error(`perfil não existe: ${input.profileId}`);
  const id = opts.id ?? newThreadId();
  const meta: ThreadEvent = {
    ts: nowIso(),
    type: "thread_meta",
    threadId: id,
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    profileId: input.profileId,
    ...(input.title ? { title: input.title } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.runStep === undefined ? {} : { runStep: input.runStep }),
    ...(input.runTitle ? { runTitle: input.runTitle } : {}),
    ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
    ...(input.mcpTools?.length ? { mcpTools: input.mcpTools } : {}),
    ...(input.mcpRunId ? { mcpRunId: input.mcpRunId } : {}),
    ...(input.branch && input.worktreeDir ? { branch: input.branch, worktreeDir: input.worktreeDir } : {}),
    ...(input.semRoteamento ? { semRoteamento: true } : {}),
    ...(input.origemThreadId ? { origemThreadId: input.origemThreadId } : {}),
    ...(input.oculta ? { oculta: true } : {}),
    ...(input.planejamento ? { planejamento: { slug: input.planejamento.slug } } : {}),
    ...(input.handoff ? { handoff: { slug: input.handoff.slug } } : {}),
  };
  appendEvent(meta, home);
  return { id };
}

/**
 * Igual a `createThread`, mas com branch fixa: isola numa `git worktree`
 * própria, senão um `git checkout` na pasta compartilhada mudaria a branch de
 * TODA conversa aberta no mesmo projeto, não só desta (ver comentário de
 * worktree.ts). Sem `input.branch`, é idêntico a `createThread`.
 */
export async function createThreadNaBranch(input: CreateThreadInput, home: string): Promise<CreatedThread> {
  const branch = input.branch?.trim();
  if (!branch || !input.projectPath) return createThread(input, home);

  const check = await podeIsolar(input.projectPath);
  if (!check.pode) throw Object.assign(new Error(`não deu pra fixar a branch: ${check.motivo}`), { status: 400 });

  const atual = await listarBranches(input.projectPath);
  if (atual.atual === branch) {
    // já é a branch corrente da pasta principal: nada pra isolar, roda direto nela como sempre
    return createThread(input, home);
  }

  // conversa irmã já isolada nesta mesma branch/projeto? reaproveita a árvore em vez de duplicar.
  const irma = listThreads(input.projectPath, home).find((t) => t.branch === branch && t.worktreeDir);
  if (irma?.worktreeDir) {
    return createThread({ ...input, branch, worktreeDir: irma.worktreeDir }, home);
  }

  // a branch já está numa árvore que esta instalação não criou (ex.: a do `run.bat dev`): o git não
  // deixa abrir outra, então a conversa trabalha nela. Apagar a conversa não remove essa pasta.
  const deFora = await worktreeDaBranch(input.projectPath, branch);
  if (deFora) {
    if (resolve(deFora).toLowerCase() === resolve(input.projectPath).toLowerCase()) return createThread(input, home);
    return createThread({ ...input, branch, worktreeDir: deFora }, home);
  }

  const id = newThreadId();
  const dir = threadWorktreeDir(id, home);
  const wt = await abrirWorktree(input.projectPath, dir, branch);
  if (!wt.ok) {
    throw Object.assign(new Error(`não deu pra isolar a branch \`${branch}\`: ${wt.motivo}`), { status: 400 });
  }
  return createThread({ ...input, branch, worktreeDir: dir }, home, { id });
}

export function appendEvent(event: ThreadEvent, home: string): void {
  const path = threadPath(event.threadId, home);
  mkdirSync(dirname(path), { recursive: true });
  const linha = `${JSON.stringify(event)}\n`;
  appendFileSync(path, linha, "utf8");
  espelharNoProjeto(event, path, linha, home);
}

/** threadId -> projectPath, pra não reler o arquivo da conversa a cada evento. */
const projetoDaConversa = new Map<string, string>();

/** Cópia da conversa em `projetos/<slug>/conversas/<id>.jsonl`, junto de memória/tarefas/repo-map. */
export function conversaEspelhoPath(id: string, projectPath: string, home: string): string {
  return join(projectDir(projectPath, home), "conversas", `${assertSlug(id)}.jsonl`);
}

/**
 * União de duas versões de uma conversa `.jsonl` (cada linha é um evento com `ts`): sem linha
 * repetida, em ordem de `ts`. Linha sem `ts` herda o da anterior pra não pular de lugar.
 */
export function mesclarJsonl(a: string, b: string): string {
  const vistas = new Set<string>();
  const itens: { linha: string; ts: string; ordem: number }[] = [];
  let ordem = 0;
  let tsAnterior = "";
  for (const texto of [a, b]) {
    for (const linha of texto.split("\n")) {
      if (!linha.trim() || vistas.has(linha)) continue;
      vistas.add(linha);
      let ts = tsAnterior;
      try {
        const t = (JSON.parse(linha) as { ts?: unknown }).ts;
        if (typeof t === "string") ts = t;
      } catch {
        // linha quebrada entra mesmo assim, no lugar da anterior
      }
      tsAnterior = ts;
      itens.push({ linha, ts, ordem: ordem++ });
    }
  }
  itens.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : x.ordem - y.ordem));
  return itens.length ? `${itens.map((i) => i.linha).join("\n")}\n` : "";
}

const ehMeta = (linha: string): boolean => {
  try {
    return (JSON.parse(linha) as { type?: unknown }).type === "thread_meta";
  } catch {
    return false;
  }
};

/**
 * O `thread_meta` de uma conversa que nasceu em OUTRA máquina fala de caminhos e perfis de lá:
 * reaponta pro projeto daqui, cai num perfil que existe aqui e larga o que só vale lá (worktree
 * isolada, config de MCP temporário).
 */
function metaParaEstaMaquina(linha: string, projectPath: string, home: string): string {
  try {
    const m = JSON.parse(linha) as Record<string, unknown>;
    if (m.type !== "thread_meta") return linha;
    m.projectPath = projectPath;
    for (const k of ["branch", "worktreeDir", "mcpConfig", "mcpTools"]) delete m[k];
    if (typeof m.profileId !== "string" || !getProfile(m.profileId, home)) {
      const primeiro = listProfiles(home)[0];
      if (primeiro) m.profileId = primeiro.id;
    }
    return JSON.stringify(m);
  } catch {
    return linha;
  }
}

/**
 * Traz pra `~/.nexos/threads` as conversas que chegaram pela pasta do projeto (sync do Drive,
 * ver drive-sync.ts) e ainda não estão — ou estão incompletas — nesta máquina. Só pra projeto que
 * esta máquina conhece (é dele que sai o `projectPath` certo). Devolve quantas conversas mexeu.
 * A fonte de verdade local segue sendo `threadPath`; o espelho só alimenta.
 */
export function importarConversas(home: string): number {
  const root = projetosRoot(home);
  if (!existsSync(root)) return 0;
  const porSlug = new Map<string, string>();
  for (const p of projetosConhecidos(home)) porSlug.set(projectSlug(p, home).slug, p);
  let mexeu = 0;
  for (const slug of readdirSync(root)) {
    const projectPath = porSlug.get(slug);
    const dir = join(root, slug, "conversas");
    if (!projectPath || !existsSync(dir)) continue;
    for (const arquivo of readdirSync(dir)) {
      if (!arquivo.endsWith(".jsonl")) continue;
      const id = arquivo.slice(0, -".jsonl".length);
      try {
        assertSlug(id);
        const linhas = readFileSync(join(dir, arquivo), "utf8")
          .split("\n")
          .filter((l) => l.trim());
        const alvo = threadPath(id, home);
        if (!existsSync(alvo)) {
          if (!linhas.some(ehMeta)) continue; // sem meta não é conversa que a gente consiga abrir
          ensureHome(home);
          writeFileSync(alvo, `${linhas.map((l) => metaParaEstaMaquina(l, projectPath, home)).join("\n")}\n`, "utf8");
          mexeu++;
          continue;
        }
        const atual = readFileSync(alvo, "utf8");
        const conhecidas = new Set(atual.split("\n"));
        const novas = linhas.filter((l) => !ehMeta(l) && !conhecidas.has(l));
        if (!novas.length) continue;
        writeFileSync(alvo, mesclarJsonl(atual, novas.join("\n")), "utf8");
        mexeu++;
      } catch (e) {
        log.erro("sync", "falha ao importar conversa", { threadId: id, erro: (e as Error).message });
      }
    }
  }
  return mexeu;
}

/**
 * Espelha o evento na pasta do projeto. A fonte de verdade continua sendo `threadPath`;
 * o espelho existe pra viajar junto da pasta do projeto (sync entre máquinas). Conversa
 * antiga sem espelho é copiada inteira no primeiro evento novo. Best-effort: nunca lança,
 * senão uma pasta de projeto indisponível derrubaria o turno.
 */
function espelharNoProjeto(event: ThreadEvent, path: string, linha: string, home: string): void {
  try {
    let projectPath = projetoDaConversa.get(event.threadId);
    if (!projectPath) {
      const meta =
        event.type === "thread_meta" ? event : readThread(event.threadId, home).find((e) => e.type === "thread_meta");
      if (!meta || meta.type !== "thread_meta" || !meta.projectPath) return; // conversa global: sem projeto, sem espelho
      projectPath = meta.projectPath;
      projetoDaConversa.set(event.threadId, projectPath);
    }
    const espelho = conversaEspelhoPath(event.threadId, projectPath, home);
    mkdirSync(dirname(espelho), { recursive: true });
    if (existsSync(espelho)) appendFileSync(espelho, linha, "utf8");
    else copyFileSync(path, espelho);
  } catch (e) {
    log.erro("sync", "falha ao espelhar conversa", { threadId: event.threadId, erro: (e as Error).message });
  }
}

/**
 * Apaga a conversa e, se ela tinha uma `git worktree` isolada própria (branch
 * fixa) que nenhuma OUTRA conversa ainda usa, tira a árvore do disco também
 * (o branch em si fica — ver `removerWorktree`).
 */
export async function removeThread(id: string, home: string): Promise<void> {
  const path = threadPath(id, home);
  if (!existsSync(path)) throw new Error(`thread não existe: ${id}`);
  const head = threadHead(id, home);
  rmSync(path);
  if (head?.projectPath) {
    projetoDaConversa.delete(id);
    try {
      rmSync(conversaEspelhoPath(id, head.projectPath, home), { force: true });
    } catch {
      // espelho é best-effort
    }
  }
  if (head?.projectPath && head.worktreeDir) {
    const aindaUsada = listThreads(head.projectPath, home).some((t) => t.worktreeDir === head.worktreeDir);
    // só a árvore que ESTA instalação criou (dentro de `<home>/worktrees`): a de fora é de outro dono
    const nossa = resolve(head.worktreeDir).toLowerCase().startsWith(resolve(home, "worktrees").toLowerCase() + sep);
    if (!aindaUsada && nossa) await removerWorktree(head.projectPath, head.worktreeDir).catch(() => {});
  }
}

export function readThread(id: string, home: string): ThreadEvent[] {
  const path = threadPath(id, home);
  if (!existsSync(path)) throw new Error(`thread não existe: ${id}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ThreadEvent);
}

export type ThreadHead = {
  id: string;
  /** Ausente = conversa global, sem projeto. */
  projectPath?: string;
  profileId: string;
  preview: string;
  updatedAt: string;
  /** Agente personalizado da conversa, quando ela nasceu de um. */
  agentId?: string;
  /** Run de time que criou esta conversa; a lista agrupa os passos por ele. */
  runId?: string;
  runStep?: number;
  runTitle?: string;
  /** Branch fixa desta conversa e a `git worktree` que a isola — ver `createThreadNaBranch`. */
  branch?: string;
  worktreeDir?: string;
  /** Passo de time chamado de dentro deste chat — ver `thread_meta.origemThreadId`. */
  origemThreadId?: string;
  oculta?: boolean;
  /** Conversa do Agent Manager do plano `<slug>`: a barra lateral abre a Tela de Planejamento. */
  planejamento?: { slug: string };
};

/**
 * Cabeçalho por arquivo, válido enquanto `mtime`+`size` não mudarem (append sempre muda o
 * size; reescrita muda o mtime). Sem isso, cada GET /v1/threads e /v1/projects relia e
 * parseava TODAS as conversas — o poll de 4s do app fazia isso ~10x e travava o daemon.
 */
const cacheDeCabecalho = new Map<string, { mtimeMs: number; size: number; head: ThreadHead | undefined }>();

/** Cabeçalho de uma conversa só. `undefined` = arquivo ilegível ou sem meta. */
export function threadHead(id: string, home: string): ThreadHead | undefined {
  let path: string;
  let st: { mtimeMs: number; size: number };
  try {
    path = threadPath(id, home);
    st = statSync(path);
  } catch {
    return undefined;
  }
  const hit = cacheDeCabecalho.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.head;
  const head = lerCabecalho(id, home);
  cacheDeCabecalho.set(path, { mtimeMs: st.mtimeMs, size: st.size, head });
  return head;
}

function lerCabecalho(id: string, home: string): ThreadHead | undefined {
  let events: ThreadEvent[];
  try {
    events = readThread(id, home);
  } catch {
    return undefined;
  }
  const meta = events.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") return undefined;
  const firstUser = events.find((e) => e.type === "user");
  const last = events.at(-1);
  return {
    id,
    projectPath: meta.projectPath,
    profileId: activeProfileId(events),
    /*
     * Título posto na criação ganha do primeiro pedido. Vale pros passos de
     * time: o pedido deles é o bloco inteiro de instruções, e mostrá-lo deixava
     * a lista com várias linhas idênticas começando em "# Objetivo do time".
     */
    preview:
      meta.title ||
      (firstUser && firstUser.type === "user" ? firstUser.text.replace(/\s+/g, " ").slice(0, 72) : "Conversa nova"),
    updatedAt: last?.ts ?? meta.ts,
    ...(activeAgentId(events) ? { agentId: activeAgentId(events) } : {}),
    ...(meta.runId ? { runId: meta.runId } : {}),
    ...(meta.runStep === undefined ? {} : { runStep: meta.runStep }),
    ...(meta.runTitle ? { runTitle: meta.runTitle } : {}),
    ...(meta.branch ? { branch: meta.branch } : {}),
    ...(meta.worktreeDir ? { worktreeDir: meta.worktreeDir } : {}),
    ...(meta.origemThreadId ? { origemThreadId: meta.origemThreadId } : {}),
    // `semRoteamento` também: só a geração do DS cria conversa assim, e as criadas antes do
    // `oculta` existir não têm a marca nova
    ...(meta.oculta || meta.semRoteamento ? { oculta: true } : {}),
    ...(meta.planejamento ? { planejamento: meta.planejamento } : {}),
  };
}

/** `projectPath` ausente lista as conversas globais (sem projeto), não todas. */
export function listThreads(projectPath: string | undefined, home: string): ThreadHead[] {
  ensureHome(home);
  const threadsDir = dirname(threadPath("placeholder", home));
  if (!existsSync(threadsDir)) return [];
  const out: ThreadHead[] = [];
  for (const file of readdirSync(threadsDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const head = threadHead(file.slice(0, -".jsonl".length), home);
    if (!head || head.projectPath !== projectPath) continue;
    // passo de time chamado de um chat pertence àquele chat; conversa de trabalho do Nexos
    // (geração do DS) pertence à tela dela — nenhuma das duas é conversa da pessoa
    if (head.origemThreadId || head.oculta) continue;
    out.push(head);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export type ThreadUsage = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking: number;
  costUsd: number;
  /** Do último turno: é isso que ocupa a janela de contexto agora. */
  contextTokens: number;
  model?: string;
};

/** Soma os eventos usage do JSONL: total da conversa + foto do último turno. */
export function threadUsage(id: string, home: string): ThreadUsage {
  const totals: ThreadUsage = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    thinking: 0,
    costUsd: 0,
    contextTokens: 0,
  };
  for (const e of readThread(id, home)) {
    if (e.type !== "usage") continue;
    totals.turns += 1;
    totals.input += e.input;
    totals.output += e.output;
    totals.cacheRead += e.cacheRead;
    totals.cacheCreate += e.cacheCreate;
    totals.thinking += e.thinking ?? 0;
    totals.costUsd += e.costUsd ?? 0;
    totals.contextTokens = e.contextTokens;
    if (e.model) totals.model = e.model;
  }
  return totals;
}

/**
 * Pastas que aparecem nas conversas do disco. É a rede de segurança da lista de
 * projetos: mesmo que o app perca o cache local, as conversas sabem onde moram.
 */
export function projectsFromThreads(home: string): string[] {
  ensureHome(home);
  const dir = dirname(threadPath("placeholder", home));
  if (!existsSync(dir)) return [];
  const vistos = new Map<string, { path: string; ts: string }>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const head = threadHead(file.slice(0, -".jsonl".length), home);
    if (!head?.projectPath) continue;
    const chave = head.projectPath.replace(/[\u005c]/g, "/").replace(/\/+$/, "").toLowerCase();
    const atual = vistos.get(chave);
    if (!atual || atual.ts < head.updatedAt) vistos.set(chave, { path: head.projectPath, ts: head.updatedAt });
  }
  return [...vistos.values()]
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .map((v) => v.path);
}

/**
 * Todo projeto que o Nexos já conhece: o que o app salvou (`config.repos`) mais o que as
 * conversas gravadas revelam, sem o que o usuário escondeu (`hiddenRepos`). Mesma dedução de
 * `GET /v1/projects` (http.ts) — reexportada aqui pra `sincronizarHooksGlobal` (hooks.ts) não
 * duplicar a lógica de "quais projetos existem" com um critério que pode divergir do endpoint.
 */
export function projetosConhecidos(home: string): string[] {
  const cfg = loadConfig(home);
  const chave = (p: string) => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  const escondidas = new Set(cfg.hiddenRepos.map(chave));
  const merged = cfg.repos.filter((p) => !escondidas.has(chave(p)));
  const vistos = new Set(merged.map(chave));
  for (const p of projectsFromThreads(home)) {
    if (vistos.has(chave(p)) || escondidas.has(chave(p))) continue;
    vistos.add(chave(p));
    merged.push(p);
  }
  return merged;
}

export function activeProfileId(events: ThreadEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "switched") return e.toProfileId;
    if (e?.type === "thread_meta") return e.profileId;
  }
  throw new Error("thread sem profileId");
}

/**
 * Agente vigente da conversa. Mesmo padrão de `activeProfileId`: um
 * `agent_assigned` posterior (atribuído pelo roteamento por typesafe.ai, na
 * ausência de agente explícito na criação) sobrescreve o `thread_meta` inicial.
 * `undefined` = conversa sem agente (nasceu sem um e nunca recebeu atribuição).
 */
export function activeAgentId(events: ThreadEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "agent_assigned") return e.agentId;
    if (e?.type === "thread_meta") return e.agentId;
  }
  return undefined;
}
