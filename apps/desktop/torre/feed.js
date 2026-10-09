/**
 * Torre de magia — camada 1: o FEED.
 *
 * Junta, sem DOM e sem relógio próprio, tudo o que a torre precisa saber do motor:
 * - retrato das conversas (`GET /v1/agents`) + eventos ao vivo (`/v1/agents/events`);
 * - chamadas da ferramenta `Agent` abertas (exploradores da dungeon), casadas pelo id;
 * - runs de hook (`/v1/runs/events`) — o bibliotecário;
 * - ferramentas recentes de Quadro/plano (quem levou a mudança ao mural) e de DS/vídeo (Ateliê);
 * - limites das contas, planos, quadro e aprendizados (consultas).
 *
 * O resto da torre (modelo → lugares → eventos → cérebro → pintura) só LÊ isto. Quem chama passa o
 * `agora`: assim os testes não dependem do relógio e reabrir a aba não reencena nada.
 */
import { aplicarNoRetrato } from "../agent-events.js";

/** Ferramentas que mandam alguém explorar: subagente (`Task` é o nome antigo) e delegação a time. */
export const FERRAMENTAS_DE_SUBAGENTE = new Set(["Agent", "Task", "mcp__nexo__nexo_delegar"]);
const ATELIE_RE = /^mcp__nexo__nexo_(mock_salvar|ds_card_salvar|video_[a-z_]+)$/;
const QUADRO_RE = /^mcp__nexo__nexo_tarefa_(salvar|checklist|comentar)$/;
const PLANO_RE = /^mcp__nexo__nexo_plano_/;
const MEMORIA_PATH_RE = /(MEMORIA\.md|[\\/](memoria|instintos|aprendizados?|repo-?map)[\\/]|repo-map)/i;
const FERRAMENTAS_DE_ARQUIVO = new Set(["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"]);
/** Até quanto tempo depois da ferramenta a ida ao andar ainda vale (idas.js prolonga por LINGER). */
export const IDA_JANELA_MS = 10_000;

/**
 * Em que andar a ferramenta "acontece" (o mago da conversa vai até lá): Biblioteca pra memória/
 * aprendizados/repo map, Ateliê pra mock/DS/vídeo, Observatório pras ferramentas do plano.
 * @returns `{ andar, gravando }` ou null
 */
export function andarDaFerramenta(nome, input) {
  const n = String(nome ?? "");
  const i = input && typeof input === "object" ? input : {};
  if (ATELIE_RE.test(n)) return { andar: "atelie", gravando: true };
  if (PLANO_RE.test(n)) return { andar: "observatorio", gravando: !/_ler$/.test(n) };
  if (n === "mcp__nexo__nexo_repomap_resumo_salvar") return { andar: "biblioteca", gravando: true };
  if (FERRAMENTAS_DE_ARQUIVO.has(n)) {
    const alvo = String(i.file_path ?? i.path ?? i.pattern ?? i.notebook_path ?? "");
    if (MEMORIA_PATH_RE.test(alvo)) return { andar: "biblioteca", gravando: n === "Write" || n === "Edit" || n === "MultiEdit" };
  }
  return null;
}
const PLANO_IMPL = "mcp__nexo__nexo_plano_implementacao";
/** Até quanto tempo depois da ferramenta a mudança no Quadro ainda é "dela". */
export const AUTOR_JANELA_MS = 3_000;
/** Explorador que voltou fica na tela o bastante pra subir, entregar o pergaminho ao mago e sair. */
export const VOLTA_MS = 9_000;

/** Mesma chave do motor (`projectKey`): barra normal, sem barra no fim, minúsculas. */
export function chaveDoProjeto(projectPath) {
  const p = String(projectPath ?? "").trim();
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function feedVazio() {
  return {
    /** threadId → retrato (o do motor, atualizado pelos eventos entre uma consulta e outra). */
    agentes: new Map(),
    /** id da chamada `Agent` → `{ id, threadId, tipo, descricao, abertaEm, background, lancada?, fim? }`. */
    chamadas: new Map(),
    /** threadId → `{ fase: "pensando"|"ferramenta"|"texto", ferramenta, em }` — o que está fazendo agora. */
    fase: new Map(),
    /** threadId → último sinal de vida do turno (pra "travou"). */
    sinalEm: new Map(),
    /** threadId → quando o turno começou / terminou bem, VISTO ao vivo. */
    pedidoEm: new Map(),
    terminouEm: new Map(),
    /** `{ threadId, nome, tarefaId, em }` de `nexo_tarefa_*` e `nexo_plano_implementacao` recentes. */
    toolsRecentes: [],
    /** `{ threadId, andar, gravando, em }` das ferramentas de andar (Biblioteca/Ateliê/Observatório). */
    idasRecentes: [],
    /** chave do projeto → `{ em, tipo: "ds"|"video" }` da última ferramenta de DS/mock/vídeo. */
    atelieEm: new Map(),
    /** chave do projeto → `{ pct, em }` do render de vídeo em andamento. */
    render: new Map(),
    /** runId → `{ runId, projectPath, hook, time, ativo, inicioEm, fimEm }`. */
    runs: new Map(),
    /** `GET /v1/accounts/limits`. */
    contas: [],
    /** id do agente do Nexos → `{ name, color }` (subagente do Nexos ganha a cor dele). */
    defs: new Map(),
    /** chave do projeto → resumo dos planos (`GET /v1/planejamento`). */
    planos: new Map(),
    /** chave do projeto → `{ colunas, tarefas }` (`GET /v1/tarefas/quadro` + `/v1/tarefas`). */
    quadros: new Map(),
    /** chave do projeto → aprendizados pendentes. */
    aprendizados: new Map(),
    /** chave do projeto → quando o mural mudou por último (janela do Observatório). */
    muralEm: new Map(),
    /** Projeto que não deu pra ler (andar "sem leitura"): chave → Set de andares. */
    semLeitura: new Map(),
    /** Quando chegou o 1º retrato (0 = ainda não: nada aqui gera reação). */
    retratoEm: 0,
  };
}

function fecharChamada(c, agora, erro) {
  if (c.fim) return false;
  c.fim = { em: agora, erro: Boolean(erro) };
  return true;
}

/** Fecha as chamadas abertas de uma conversa (todas, ou só as de 2º plano). */
function fecharChamadasDa(feed, threadId, agora, { erro = false, soBackground = false } = {}) {
  let mudou = false;
  for (const c of feed.chamadas.values()) {
    if (c.threadId !== threadId || c.fim) continue;
    if (soBackground && !c.background) continue;
    mudou = fecharChamada(c, agora, erro) || mudou;
  }
  return mudou;
}

/** Tira o que já não serve: chamadas que voltaram há tempo e ferramentas velhas. */
export function limparFeed(feed, agora) {
  for (const [id, c] of feed.chamadas) if (c.fim && agora - c.fim.em > VOLTA_MS) feed.chamadas.delete(id);
  feed.toolsRecentes = feed.toolsRecentes.filter((t) => agora - t.em <= AUTOR_JANELA_MS * 4);
  feed.idasRecentes = feed.idasRecentes.filter((t) => agora - t.em <= IDA_JANELA_MS);
  for (const [id, r] of feed.runs) if (!r.ativo && agora - (r.fimEm ?? 0) > 60_000) feed.runs.delete(id);
}

/**
 * Retrato novo do motor. Detecta o fim do turno (ocupado → livre com `done`) e o começo
 * (livre → ocupado) — o 1º retrato só grava. Conversa que sumiu (motor fechou) leva junto os
 * exploradores dela.
 */
export function aplicarRetrato(feed, agentes, agora) {
  const primeiro = !feed.retratoEm;
  const vistos = new Set();
  for (const a of Array.isArray(agentes) ? agentes : []) {
    if (!a?.threadId) continue;
    vistos.add(a.threadId);
    const antes = feed.agentes.get(a.threadId);
    if (!primeiro) {
      if (antes?.busy && !a.busy && a.lastTerminal === "done" && !(a.emEspera > 0)) feed.terminouEm.set(a.threadId, agora);
      if (!antes?.busy && a.busy && !feed.pedidoEm.has(a.threadId)) feed.pedidoEm.set(a.threadId, agora);
    }
    if (!a.busy) feed.pedidoEm.delete(a.threadId);
    feed.agentes.set(a.threadId, { ...a });
    // turno acabou sem o evento (SSE caiu no meio): explorador não fica preso lá embaixo
    if (!a.busy && !(a.emEspera > 0)) fecharChamadasDa(feed, a.threadId, agora, { erro: a.lastTerminal === "error" });
  }
  for (const id of [...feed.agentes.keys()]) {
    if (vistos.has(id)) continue;
    feed.agentes.delete(id);
    fecharChamadasDa(feed, id, agora);
  }
  if (primeiro) feed.retratoEm = agora;
  limparFeed(feed, agora);
}

/** Retrato mínimo pra conversa que mandou evento antes de aparecer numa consulta. */
function retratoDe(feed, threadId) {
  let a = feed.agentes.get(threadId);
  if (!a) {
    a = { threadId, busy: false, aguardando: false, emEspera: 0, pendingQuota: false, passos: [], projectPath: undefined };
    feed.agentes.set(threadId, a);
  }
  return a;
}

/**
 * Evento do SSE de agentes. Devolve true quando mudou algo que a torre mostra.
 */
export function aplicarEventoAgente(feed, ev, agora) {
  const threadId = ev?.threadId;
  if (!threadId || typeof ev.type !== "string") return false;
  const a = retratoDe(feed, threadId);
  switch (ev.type) {
    case "tool": {
      const nome = String(ev.name ?? "");
      a.busy = true;
      feed.sinalEm.set(threadId, agora);
      feed.fase.set(threadId, { fase: "ferramenta", ferramenta: nome, em: agora });
      if (!feed.pedidoEm.has(threadId)) feed.pedidoEm.set(threadId, agora);
      const input = ev.input && typeof ev.input === "object" ? ev.input : {};
      if (FERRAMENTAS_DE_SUBAGENTE.has(nome) && ev.id && !feed.chamadas.has(ev.id)) {
        feed.chamadas.set(ev.id, {
          id: ev.id,
          threadId,
          // time delegado: o nome do time; subagente: o tipo
          tipo: String(input.subagent_type || input.teamId || input.agentId || "general-purpose"),
          descricao: String(input.description || input.goal || "").replace(/\s+/g, " ").trim(),
          abertaEm: agora,
          background: input.run_in_background === true,
        });
      }
      if (QUADRO_RE.test(nome) || nome === PLANO_IMPL) {
        const tarefaId = typeof input.id === "string" ? input.id : typeof input.tarefaId === "string" ? input.tarefaId : "";
        feed.toolsRecentes.push({ threadId, nome, tarefaId, em: agora });
      }
      const andar = andarDaFerramenta(nome, input);
      if (andar) feed.idasRecentes.push({ threadId, andar: andar.andar, gravando: andar.gravando, em: agora });
      if (ATELIE_RE.test(nome) && a.projectPath !== undefined) {
        feed.atelieEm.set(chaveDoProjeto(a.projectPath), { em: agora, tipo: nome.includes("video") ? "video" : "ds" });
      }
      return true;
    }
    case "tool_result": {
      const c = ev.id ? feed.chamadas.get(ev.id) : undefined;
      feed.sinalEm.set(threadId, agora);
      if (!c || c.fim) return false;
      // 2º plano: o resultado é só "lançado"; o fim de verdade vem quando a espera da conversa zera
      if (c.background && !ev.isError) {
        c.lancada = true;
        return false;
      }
      return fecharChamada(c, agora, ev.isError);
    }
    case "thinking":
      feed.sinalEm.set(threadId, agora);
      if (feed.fase.get(threadId)?.fase !== "pensando") feed.fase.set(threadId, { fase: "pensando", ferramenta: "", em: agora });
      if (!a.busy && !feed.pedidoEm.has(threadId)) feed.pedidoEm.set(threadId, agora);
      aplicarNoRetrato(a, ev);
      return true;
    case "text": {
      feed.sinalEm.set(threadId, agora);
      const f = feed.fase.get(threadId);
      if (f?.fase !== "texto") feed.fase.set(threadId, { fase: "texto", ferramenta: f?.ferramenta ?? "", em: agora });
      if (!a.busy && !feed.pedidoEm.has(threadId)) feed.pedidoEm.set(threadId, agora);
      a.tail ??= "";
      aplicarNoRetrato(a, ev);
      return f?.fase !== "texto";
    }
    case "em_espera": {
      const n = Math.max(0, Number(ev.tarefas) || 0);
      a.emEspera = n;
      if (n > 0) a.busy = false;
      feed.sinalEm.set(threadId, agora);
      if (n === 0) fecharChamadasDa(feed, threadId, agora, { soBackground: true });
      return true;
    }
    case "done":
    case "error":
    case "auth":
    case "quota": {
      if (ev.type === "done" && (a.busy || a.emEspera > 0)) feed.terminouEm.set(threadId, agora);
      aplicarNoRetrato(a, ev);
      a.emEspera = 0;
      feed.fase.delete(threadId);
      feed.pedidoEm.delete(threadId);
      fecharChamadasDa(feed, threadId, agora, { erro: ev.type !== "done" });
      return true;
    }
    case "pergunta":
      a.aguardando = true;
      a.pergunta = { id: ev.id, texto: ev.texto, ...(ev.opcoes ? { opcoes: ev.opcoes } : {}) };
      return true;
    case "pergunta_resposta":
      a.aguardando = false;
      delete a.pergunta;
      feed.sinalEm.set(threadId, agora);
      return true;
    case "switched":
      return aplicarNoRetrato(a, ev);
    default:
      return false;
  }
}

/** Evento do SSE de runs (já vem com `projectPath`, `hook` e `time`). */
export function aplicarEventoRun(feed, ev, agora) {
  if (!ev?.runId) return false;
  const r = feed.runs.get(ev.runId) ?? {
    runId: ev.runId,
    projectPath: ev.projectPath ?? "",
    hook: ev.hook === true,
    time: ev.time ?? "",
    ativo: false,
    inicioEm: agora,
  };
  feed.runs.set(ev.runId, r);
  if (ev.type === "run_end") {
    if (!r.ativo) return false;
    r.ativo = false;
    r.fimEm = agora;
    return true;
  }
  if (ev.type === "run_start" || ev.type === "step_start" || ev.type === "step_add") {
    if (r.ativo) return false;
    r.ativo = true;
    r.inicioEm = agora;
    return true;
  }
  return false;
}

/** Evento do SSE de vídeos do projeto: só o render interessa (rolo girando no Ateliê). */
export function aplicarEventoVideo(feed, projectPath, ev, agora) {
  if (ev?.type !== "render") return false;
  const chave = chaveDoProjeto(projectPath);
  if (ev.estado === "rodando") {
    const pct = Math.round(Number(ev.progresso?.pct) || 0);
    feed.render.set(chave, { pct, em: agora });
    feed.atelieEm.set(chave, { em: agora, tipo: "video" });
  } else feed.render.delete(chave);
  return true;
}

/**
 * Quem fez a mudança no Quadro. `via` vem do motor (ferramenta `nexo_tarefa_*` = agente, andamento
 * de etapa = plano, nada = a pessoa pela tela); a CONVERSA sai da ferramenta mais recente da mesma
 * tarefa em até 3 s. Devolve `{ tipo: "voce" }`, `{ tipo: "conversa", threadId }` ou
 * `{ tipo: "sozinho" }` (agente sem par: o pergaminho desliza sem dono).
 */
export function autorDaMudanca(feed, ev, agora) {
  if (!ev?.via) return { tipo: "voce" };
  const nomes = ev.via === "plano" ? (n) => n === PLANO_IMPL : (n) => QUADRO_RE.test(n);
  let melhor;
  for (const t of feed.toolsRecentes) {
    if (!nomes(t.nome) || agora - t.em > AUTOR_JANELA_MS || t.em > agora) continue;
    // criar não tem id ainda; plano mexe pela etapa, não pela tarefa
    const casa = ev.via === "plano" || !t.tarefaId || t.tarefaId === ev.tarefaId;
    if (casa && (!melhor || t.em >= melhor.em)) melhor = t;
  }
  return melhor ? { tipo: "conversa", threadId: melhor.threadId } : { tipo: "sozinho" };
}
