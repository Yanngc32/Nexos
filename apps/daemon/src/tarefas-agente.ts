/**
 * Lista de tarefas do motor (TaskCreate/TaskUpdate/TodoWrite do CLI do Claude) virando cards no
 * Quadro, a camada do PO por cima deles, e os dois passos determinísticos de turno.
 *
 * Cada card do agente tem duas camadas (ver `FonteAgente`/`CamadaPO` em tarefas.ts): `fonte` = o
 * item como o motor deixou; `po` = o que o PO reescreveu. O status que vale é `statusEfetivo`
 * (po ?? fonte ?? coluna) e a coluna segue ele. Regras de quem ganha:
 * - o agente MUDOU o status do item → o status do PO cai (título/resumo do PO ficam);
 * - nada mudou no item → o sync nem grava (a coluna que a pessoa arrastou fica onde está);
 * - card `criadoPor: "po"` nunca é apagado pelo sync; card do agente que sumiu da lista é.
 *
 * Tudo aqui é best-effort do lado do chat: um erro do quadro nunca derruba um turno.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import {
  STATUS_FONTE,
  adicionarComentario,
  apagarTarefa,
  colunaDoStatus,
  comoAutor,
  getQuadro,
  getTarefa,
  listarTarefas,
  salvarTarefa,
  statusEfetivo,
  type CamadaPO,
  type FonteAgente,
  type StatusFonte,
  type Tarefa,
} from "./tarefas.ts";

/** Um item da lista do motor, já normalizado. `id` é o da lista ("1", "2"… ou `todo-N`). */
export type ItemDoAgente = { id: string; titulo: string; status: StatusFonte };

/** Ferramentas do motor que mexem na lista — o evento delas dispara o sync. */
export const FERRAMENTAS_DE_TAREFA = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

/** Motivo que o fim de turno grava no PO — é por ele que `retomarTurno` sabe o que devolver. */
export const MARCA_FIM_DE_TURNO = "fim do turno: ficou em andamento sem o agente trabalhando";

const TITULO_MAX = 140;
const RESUMO_MAX = 2000;
const MOTIVO_MAX = 2000;
/** O evento de ferramenta chega antes de o CLI gravar o arquivo da tarefa — espera um tico. */
const ATRASO_SYNC_MS = 300;
const SESSAO_RE = /^[A-Za-z0-9_-]{1,128}$/;

function erro(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function agora(): string {
  return new Date().toISOString();
}

function ehStatus(v: unknown): v is StatusFonte {
  return typeof v === "string" && (STATUS_FONTE as readonly string[]).includes(v);
}

/** Título de uma linha, no limite do card. Vazio = item que não dá pra mostrar. */
function tituloCurto(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, TITULO_MAX) : "";
}

function quadroLigado(home: string): boolean {
  return loadConfig(home).modulos.quadroTarefas;
}

function msgDoErro(e: unknown): string {
  return (e as Error)?.message || String(e);
}

/** Id do card: estável por (conversa, id na lista) — o mesmo item sempre cai no mesmo card. */
export function idDoCard(threadId: string, idFonte: string): string {
  return "tk-ag-" + createHash("sha1").update(`${threadId}\u001f${idFonte}`).digest("hex").slice(0, 20);
}

/**
 * Lê `<configDir>/tasks/<sessionId>/*.json` (um arquivo por tarefa, gravado pelo CLI). `null` =
 * a pasta não existe (o motor nunca usou TaskCreate nesta sessão) — diferente de lista vazia, que
 * apaga os cards. Arquivo ilegível é pulado, não derruba a lista.
 */
export function lerTarefasDoAgente(configDir: string, sessionId: string): ItemDoAgente[] | null {
  if (!SESSAO_RE.test(sessionId)) return null;
  const dir = join(configDir, "tasks", sessionId);
  if (!existsSync(dir)) return null;
  let arquivos: string[];
  try {
    arquivos = readdirSync(dir).filter((a) => a.endsWith(".json"));
  } catch {
    return null;
  }
  const itens: ItemDoAgente[] = [];
  for (const arquivo of arquivos) {
    try {
      const d = JSON.parse(readFileSync(join(dir, arquivo), "utf8")) as Record<string, unknown>;
      const id = typeof d.id === "string" || typeof d.id === "number" ? String(d.id) : basename(arquivo, ".json");
      const titulo = tituloCurto(d.subject);
      if (!id || !titulo || !ehStatus(d.status)) continue;
      itens.push({ id, titulo, status: d.status });
    } catch {
      // gravação pela metade ou lixo na pasta — fica de fora desta leitura
    }
  }
  return itens.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

/** O `todos` do TodoWrite (lista inteira a cada chamada). `null` = entrada que não é uma lista. */
export function itensDoTodoWrite(input: unknown): ItemDoAgente[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  const itens: ItemDoAgente[] = [];
  todos.forEach((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const titulo = tituloCurto(o.content);
    if (titulo && ehStatus(o.status)) itens.push({ id: `todo-${i + 1}`, titulo, status: o.status });
  });
  return itens;
}

/** PO sem o status e o que vem com ele — o que sobra quando o agente muda o status do item. */
function poSemStatus(po: CamadaPO | undefined): CamadaPO | undefined {
  if (!po) return undefined;
  const { status: _s, motivo: _m, acaoVoce: _a, tipoResposta: _t, ...resto } = po;
  return resto.titulo || resto.resumo ? resto : undefined;
}

export type ResultadoDoSync = { criados: string[]; atualizados: string[]; apagados: string[] };

/**
 * Upsert dos itens da lista do motor como cards da conversa `threadId`, e apaga os cards do
 * agente daquela conversa que sumiram da lista. Idempotente: rodar de novo com a mesma lista não
 * grava nada. Erro num card é logado e o resto segue.
 */
export function sincronizarTarefasDoAgente(
  projectPath: string,
  home: string,
  threadId: string,
  sessaoId: string | undefined,
  itens: ItemDoAgente[],
): ResultadoDoSync {
  const r: ResultadoDoSync = { criados: [], atualizados: [], apagados: [] };
  const quadro = getQuadro(projectPath, home);
  const daConversa = listarTarefas(projectPath, home).filter((t) => t.threadId === threadId);
  const porId = new Map(daConversa.map((t) => [t.id, t]));
  const vistos = new Set<string>();

  for (const item of itens) {
    const id = idDoCard(threadId, item.id);
    if (vistos.has(id)) continue;
    vistos.add(id);
    try {
      const atual = porId.get(id) ?? getTarefa(projectPath, home, id);
      if (atual && atual.fonte?.status === item.status && atual.fonte.titulo === item.titulo) continue;

      const fonte: FonteAgente = {
        conversa: threadId,
        ...(sessaoId ? { sessaoId } : {}),
        id: item.id,
        status: item.status,
        titulo: item.titulo,
        em: agora(),
      };
      const antes = atual?.fonte;
      const caiStatusDoPO =
        !!atual?.po?.status &&
        !!antes &&
        (antes.status !== item.status || (atual.po.status === "pending" && item.status === "in_progress"));
      const po = caiStatusDoPO ? poSemStatus(atual?.po) : atual?.po;

      const depois = statusEfetivo({ colunaId: atual?.colunaId ?? "", fonte, po }, quadro);
      const mover = !atual || statusEfetivo(atual, quadro) !== depois;
      const colunaId = mover ? colunaDoStatus(quadro, depois) : undefined;

      comoAutor("agente", () =>
        salvarTarefa(
          {
            ...(atual ? { id: atual.id } : {}),
            projectPath,
            titulo: po?.titulo ?? item.titulo,
            ...(colunaId ? { colunaId } : {}),
            threadId,
          },
          home,
          "agente",
          { idNovo: id, fonte, ...(caiStatusDoPO ? { po: po ?? null } : {}) },
        ),
      );
      (atual ? r.atualizados : r.criados).push(id);
    } catch (e) {
      log.avisoUmaVez(`tarefas-agente:sync:${id}`, "turno", "card da lista do agente não gravou", {
        tarefa: id,
        erro: msgDoErro(e),
      });
    }
  }

  for (const t of daConversa) {
    if (t.criadoPor !== "agente" || !t.fonte || vistos.has(t.id)) continue;
    try {
      comoAutor("agente", () => apagarTarefa(projectPath, home, t.id));
      r.apagados.push(t.id);
    } catch (e) {
      log.avisoUmaVez(`tarefas-agente:apagar:${t.id}`, "turno", "card do agente que saiu da lista não apagou", {
        tarefa: t.id,
        erro: msgDoErro(e),
      });
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Ligação com a sessão (session.ts): evento de ferramenta e fim do turno.

/** O que a sessão sabe de um turno pra achar a lista: `configDir`/`sessionId` só no motor claude. */
export type ContextoDoTurno = { threadId: string; projectPath?: string; configDir?: string; sessionId?: string };

/** Última lista do TodoWrite de cada conversa — o TodoWrite não grava arquivo, só manda a entrada. */
const ultimosTodos = new Map<string, ItemDoAgente[]>();
const syncsAgendados = new Map<string, NodeJS.Timeout>();

function sincronizarAgora(home: string, ctx: ContextoDoTurno): void {
  try {
    if (!ctx.projectPath || !quadroLigado(home)) return;
    const itens =
      (ctx.configDir && ctx.sessionId ? lerTarefasDoAgente(ctx.configDir, ctx.sessionId) : null) ??
      ultimosTodos.get(ctx.threadId) ??
      null;
    if (!itens) return;
    sincronizarTarefasDoAgente(ctx.projectPath, home, ctx.threadId, ctx.sessionId, itens);
  } catch (e) {
    log.avisoUmaVez(`tarefas-agente:turno:${ctx.threadId}`, "turno", "sync da lista do agente falhou", {
      threadId: ctx.threadId,
      erro: msgDoErro(e),
    });
  }
}

/** Evento de ferramenta do motor: se for de lista, agenda o sync (o arquivo ainda está sendo gravado). */
export function aoUsarFerramentaDeTarefa(home: string, ctx: ContextoDoTurno, nome: string, input: unknown): void {
  if (!FERRAMENTAS_DE_TAREFA.has(nome)) return;
  if (nome === "TodoWrite") {
    const itens = itensDoTodoWrite(input);
    if (itens) ultimosTodos.set(ctx.threadId, itens);
  }
  clearTimeout(syncsAgendados.get(ctx.threadId));
  const timer = setTimeout(() => {
    syncsAgendados.delete(ctx.threadId);
    sincronizarAgora(home, ctx);
  }, ATRASO_SYNC_MS);
  timer.unref?.();
  syncsAgendados.set(ctx.threadId, timer);
}

/** Fim do turno (`done`): sync na hora, sem esperar o agendado. */
export function sincronizarNoFimDoTurno(home: string, ctx: ContextoDoTurno): void {
  const agendado = syncsAgendados.get(ctx.threadId);
  if (agendado) {
    clearTimeout(agendado);
    syncsAgendados.delete(ctx.threadId);
  }
  sincronizarAgora(home, ctx);
}

/** Só pra teste: esquece listas do TodoWrite e syncs agendados. */
export function resetTarefasAgenteForTest(): void {
  for (const t of syncsAgendados.values()) clearTimeout(t);
  syncsAgendados.clear();
  ultimosTodos.clear();
  memoriaDoFim.clear();
  filas.clear();
}

// ---------------------------------------------------------------------------------------------
// API do PO (T2 monta o motor do PO em cima disto).

export type PatchPO = {
  titulo?: string | null;
  resumo?: string | null;
  status?: StatusFonte | null;
  acaoVoce?: string | null;
  tipoResposta?: "botao" | "responder" | null;
};

function exigirMotivo(motivo: unknown): string {
  if (typeof motivo !== "string" || !motivo.trim()) throw erro(400, "motivo obrigatório");
  const m = motivo.trim();
  if (m.length > MOTIVO_MAX) throw erro(400, `motivo passa de ${MOTIVO_MAX} caracteres`);
  return m;
}

function exigirQuadro(home: string): void {
  if (!quadroLigado(home)) throw erro(409, "o quadro de tarefas está desligado");
}

function texto(v: unknown, campo: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw erro(400, `${campo} inválido`);
  const t = v.trim();
  if (t.length > max) throw erro(400, `${campo} passa de ${max} caracteres`);
  return t || undefined;
}

function tipoResposta(v: unknown): CamadaPO["tipoResposta"] {
  if (v === undefined || v === null) return undefined;
  if (v !== "botao" && v !== "responder") throw erro(400, "tipoResposta inválido — use botao|responder");
  return v;
}

/**
 * O PO mexe num card: campo com valor grava, `null` limpa, ausente fica. Motivo é obrigatório
 * (vira comentário de autor "PO"); a coluna segue o status efetivo se ele mudou.
 */
export function aplicarPO(projectPath: string, home: string, tarefaId: string, patch: PatchPO, motivo: string): Tarefa {
  const m = exigirMotivo(motivo);
  exigirQuadro(home);
  const t = getTarefa(projectPath, home, tarefaId);
  if (!t) throw erro(404, `tarefa não existe: ${tarefaId}`);
  if (patch.status != null && !ehStatus(patch.status)) throw erro(400, `status inválido — use ${STATUS_FONTE.join("|")}`);

  const po: Partial<CamadaPO> = { ...t.po };
  const campos: Array<[keyof PatchPO, (v: unknown) => unknown]> = [
    ["titulo", (v) => texto(v, "título", TITULO_MAX)],
    ["resumo", (v) => texto(v, "resumo", RESUMO_MAX)],
    ["status", (v) => v ?? undefined],
    ["acaoVoce", (v) => texto(v, "acaoVoce", RESUMO_MAX)],
    ["tipoResposta", tipoResposta],
  ];
  for (const [k, limpar] of campos) {
    if (!(k in patch) || patch[k] === undefined) continue;
    const v = limpar(patch[k]);
    if (v === undefined) delete po[k];
    else (po as Record<string, unknown>)[k] = v;
  }
  const novo: CamadaPO = { ...po, motivo: m, em: agora() };

  const quadro = getQuadro(projectPath, home);
  const depois = statusEfetivo({ ...t, po: novo }, quadro);
  const colunaId = statusEfetivo(t, quadro) !== depois ? colunaDoStatus(quadro, depois) : undefined;
  // Título do card: o do PO quando ele reescreveu; tirou o dele → volta o do agente.
  const titulo = "titulo" in patch && patch.titulo !== undefined ? (novo.titulo ?? t.fonte?.titulo) : undefined;

  return comoAutor("po", () => {
    salvarTarefa(
      { id: t.id, projectPath, ...(titulo ? { titulo } : {}), ...(colunaId ? { colunaId } : {}) },
      home,
      undefined,
      { po: novo },
    );
    adicionarComentario(projectPath, home, t.id, m, "PO");
    return getTarefa(projectPath, home, t.id) as Tarefa;
  });
}

export type NovaTarefaDoPO = {
  titulo: string;
  resumo?: string;
  status: StatusFonte;
  motivo: string;
  acaoVoce?: string;
  tipoResposta?: "botao" | "responder";
  parentId?: string;
  threadId: string;
};

/** Card que o PO cria do zero (`criadoPor: "po"` — o sync da lista do agente nunca apaga). */
export function criarTarefaDoPO(projectPath: string, home: string, input: NovaTarefaDoPO): Tarefa {
  const m = exigirMotivo(input.motivo);
  exigirQuadro(home);
  if (!ehStatus(input.status)) throw erro(400, `status inválido — use ${STATUS_FONTE.join("|")}`);
  const titulo = texto(input.titulo, "título", TITULO_MAX);
  if (!titulo) throw erro(400, "título obrigatório");
  const resumo = texto(input.resumo, "resumo", RESUMO_MAX);
  const acaoVoce = texto(input.acaoVoce, "acaoVoce", RESUMO_MAX);
  const resposta = tipoResposta(input.tipoResposta);
  const colunaId = colunaDoStatus(getQuadro(projectPath, home), input.status);
  if (!colunaId) throw erro(400, "o quadro não tem coluna");
  const po: CamadaPO = {
    titulo,
    ...(resumo ? { resumo } : {}),
    status: input.status,
    motivo: m,
    ...(acaoVoce ? { acaoVoce } : {}),
    ...(resposta ? { tipoResposta: resposta } : {}),
    em: agora(),
  };
  return comoAutor("po", () => {
    const t = salvarTarefa(
      { projectPath, titulo, colunaId, threadId: input.threadId, ...(input.parentId ? { parentId: input.parentId } : {}) },
      home,
      "po",
      { po },
    );
    adicionarComentario(projectPath, home, t.id, m, "PO");
    return getTarefa(projectPath, home, t.id) as Tarefa;
  });
}

// ---------------------------------------------------------------------------------------------
// Passos determinísticos de turno.

/** PO de cada card que o fim de turno rebaixou, pra `retomarTurno` devolver como estava. */
const memoriaDoFim = new Map<string, Map<string, CamadaPO | undefined>>();
/** Uma fila por conversa: fechar e retomar do mesmo turno nunca correm juntos. */
const filas = new Map<string, Promise<unknown>>();

function naFila<T>(threadId: string, f: () => Promise<T>): Promise<T> {
  const antes = filas.get(threadId) ?? Promise.resolve();
  const p = antes.then(f, f);
  const fim = p.catch(() => undefined);
  filas.set(threadId, fim);
  void fim.then(() => {
    if (filas.get(threadId) === fim) filas.delete(threadId);
  });
  return p;
}

function esperarAteOTeto(aguardar: Promise<unknown> | undefined, tetoMs: number): Promise<void> {
  if (!aguardar) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const teto = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, tetoMs);
    timer.unref?.();
  });
  return Promise.race([aguardar.then(() => undefined, () => undefined), teto]).finally(() => clearTimeout(timer));
}

function cardsDaConversa(threadId: string, projectPath: string, home: string): Tarefa[] {
  return listarTarefas(projectPath, home).filter((t) => t.threadId === threadId);
}

/**
 * Fim do turno: espera o PO (`aguardar`, até `tetoMs`) e devolve pra "a fazer" o card desta
 * conversa que ficou "em andamento" — o agente parou, então ninguém está fazendo. Card só da
 * pessoa (sem camada) fica. Devolve os ids rebaixados; nunca rejeita.
 */
export function fecharTurno(
  threadId: string,
  projectPath: string | undefined,
  home: string,
  opts: { aguardar?: Promise<unknown>; tetoMs?: number } = {},
): Promise<string[]> {
  return naFila(threadId, async () => {
    try {
      if (!projectPath || !quadroLigado(home)) return [];
      await esperarAteOTeto(opts.aguardar, opts.tetoMs ?? 30_000);
      if (!quadroLigado(home)) return [];
      const quadro = getQuadro(projectPath, home);
      const pendente = colunaDoStatus(quadro, "pending");
      const memoria = memoriaDoFim.get(threadId) ?? new Map<string, CamadaPO | undefined>();
      const rebaixados: string[] = [];
      for (const t of cardsDaConversa(threadId, projectPath, home)) {
        if (!(t.fonte || t.po) || statusEfetivo(t, quadro) !== "in_progress") continue;
        try {
          const { acaoVoce: _a, tipoResposta: _t, ...resto } = t.po ?? ({} as Partial<CamadaPO>);
          const po: CamadaPO = { ...resto, status: "pending", motivo: MARCA_FIM_DE_TURNO, em: agora() };
          comoAutor("po", () =>
            salvarTarefa({ id: t.id, projectPath, ...(pendente ? { colunaId: pendente } : {}) }, home, undefined, { po }),
          );
          memoria.set(t.id, t.po);
          rebaixados.push(t.id);
        } catch (e) {
          log.avisoUmaVez(`tarefas-agente:fechar:${t.id}`, "turno", "fim de turno não devolveu o card", {
            tarefa: t.id,
            erro: msgDoErro(e),
          });
        }
      }
      if (memoria.size) memoriaDoFim.set(threadId, memoria);
      return rebaixados;
    } catch (e) {
      log.avisoUmaVez(`tarefas-agente:fechar-turno:${threadId}`, "turno", "fim de turno do quadro falhou", {
        threadId,
        erro: msgDoErro(e),
      });
      return [];
    }
  });
}

/**
 * Mensagem nova da pessoa: o que o fim do turno anterior devolveu pra "a fazer" volta pra "em
 * andamento" (com o PO de antes, se o daemon ainda lembra). Card que o agente já mexeu depois disso
 * perdeu a marca no sync e fica como está. Devolve os ids retomados; nunca rejeita.
 */
export function retomarTurno(threadId: string, projectPath: string | undefined, home: string): Promise<string[]> {
  return naFila(threadId, async () => {
    try {
      if (!projectPath || !quadroLigado(home)) return [];
      const quadro = getQuadro(projectPath, home);
      const memoria = memoriaDoFim.get(threadId);
      const retomados: string[] = [];
      for (const t of cardsDaConversa(threadId, projectPath, home)) {
        // `startsWith`: o PENDENTE do PO grava "<marca> — pendente: …" — a resposta da pessoa retoma.
        if (t.po?.status !== "pending" || !t.po.motivo?.startsWith(MARCA_FIM_DE_TURNO)) continue;
        try {
          // Sem memória (o daemon reiniciou): o do agente já diz andamento → só tira o do PO.
          const antes: Partial<CamadaPO> =
            memoria && memoria.has(t.id)
              ? (memoria.get(t.id) ?? {})
              : t.fonte?.status === "in_progress"
                ? {}
                : { status: "in_progress" };
          const restaurado: Partial<CamadaPO> = {
            ...(t.po.titulo ? { titulo: t.po.titulo } : {}),
            ...(t.po.resumo ? { resumo: t.po.resumo } : {}),
            ...(antes.status ? { status: antes.status } : {}),
            ...(antes.motivo ? { motivo: antes.motivo } : {}),
            ...(antes.acaoVoce ? { acaoVoce: antes.acaoVoce } : {}),
            ...(antes.tipoResposta ? { tipoResposta: antes.tipoResposta } : {}),
          };
          const po: CamadaPO | null = Object.keys(restaurado).length ? { ...restaurado, em: agora() } : null;
          const colunaId = colunaDoStatus(quadro, statusEfetivo({ ...t, po: po ?? undefined }, quadro));
          comoAutor("po", () =>
            salvarTarefa({ id: t.id, projectPath, ...(colunaId ? { colunaId } : {}) }, home, undefined, { po }),
          );
          memoria?.delete(t.id);
          retomados.push(t.id);
        } catch (e) {
          log.avisoUmaVez(`tarefas-agente:retomar:${t.id}`, "turno", "retomada do turno não voltou o card", {
            tarefa: t.id,
            erro: msgDoErro(e),
          });
        }
      }
      if (memoria && !memoria.size) memoriaDoFim.delete(threadId);
      return retomados;
    } catch (e) {
      log.avisoUmaVez(`tarefas-agente:retomar-turno:${threadId}`, "turno", "retomada do quadro falhou", {
        threadId,
        erro: msgDoErro(e),
      });
      return [];
    }
  });
}
