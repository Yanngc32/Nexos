/**
 * Chat como instância.
 *
 * O chat do app era um só: `state.threadId`, o `#log`, o SSE e o composer eram globais do
 * renderer. Pra ter mais de um chat na tela (área de chats, planejamento com Manager e
 * Implementação), o que é de UMA conversa sai do global e mora aqui, um objeto por chat.
 *
 * O renderer continua lendo `state.threadId`, `state.events`… (são centenas de pontos): esses
 * campos viram getters do chat ATUAL (`ligarEstadoDoChat`). Atual = o chat em foco, a não ser
 * durante `comChat(chat, fn)`, que é como o SSE de cada chat processa o evento dele — assim o
 * evento de um chat nunca cai no log de outro, mesmo que o foco esteja noutro lugar.
 *
 * `comChat` vale só pro trecho SÍNCRONO de `fn`: depois de um `await`, o atual volta a ser o foco.
 * Código assíncrono que precisa do chat depois de esperar guarda a instância antes (`const chat =
 * area.atual()`) e usa ela, ou reentra com `comChat(chat, …)`.
 */

import { LIMITE_DO_CHAT } from "./janela-do-chat.js";

/**
 * Ids do HTML que existem uma vez POR CHAT (cabeçalho, log, estado vazio, barra de pensar,
 * composer). O `$` do renderer procura esses dentro da raiz do chat atual (`el.root`), então o
 * código de desenho segue escrevendo `$("log")` e cai no chat certo. O resto (banners, medidor,
 * maguinho) é do app e fica no documento.
 */
export const IDS_DO_CHAT = Object.freeze(
  new Set(
    "chat-head btn-voltar-origem crumb-repo btn-roteamento crumb-thread log-wrap log chat-history-rail btn-scroll-bottom chat-empty chat-empty-eb chat-empty-title chat-empty-sub chat-empty-acoes chat-empty-cta chat-empty-clonar think-bar think-glyph think-word think-meta times-bar composer slash-menu queue-strip attach-strip input profile-select model-select model-custom mode-select effort-range effort-label btn-login btn-import-login profiles-empty btn-attach attach-input btn-bar-more bar-more-panel btn-abort btn-send".split(
      " ",
    ),
  ),
);

/**
 * Acha o elemento `id`: se é id de chat, dentro da raiz do chat `chat` (se ele tem uma);
 * senão (ou se a raiz não tem), no documento.
 */
export function elementoDoChat(doc, chat, id) {
  if (chat?.el?.root && IDS_DO_CHAT.has(id)) {
    const el = chat.el.root.querySelector(`#${id}`);
    if (el) return el;
  }
  return doc.getElementById(id);
}

/** Estado de uma conversa na tela. Tudo aqui é por chat; o resto do `state` é do app. */
export function criarEstadoDoChat({ threadId = "", profileId = "", el = null } = {}) {
  return {
    /** Elementos do chat: `root` (onde moram os `IDS_DO_CHAT` deste chat). */
    el: el ?? {},
    threadId,
    profileId,
    /** `thread_meta` da conversa (handoff, planejamento, origem…). */
    metaAtual: null,
    events: [],
    /** Quantos eventos do fim da conversa o chat desenha (ver janela-do-chat.js). */
    limiteDoChat: LIMITE_DO_CHAT,
    /** Última avaliação do roteador que NÃO mudou nada (chega só por SSE, não vai pro histórico). */
    ultimaAvaliacaoRoteamento: null,
    /** nome da ferramenta MCP por `id` da chamada — só pro tempo entre o `tool` e o `tool_result`. */
    toolNamePorId: new Map(),
    /** runId de `nexo_delegar` que chegou antes da bolha da ferramenta existir, por threadId. */
    subchatsPendentes: new Map(),
    /** Object URLs vivos no log; revogados quando o log é recriado. */
    logShotUrls: [],
    abortSse: null,
    /** SSE da conversa está de pé? O poll do motor usa isso pra religar sozinho. */
    sseOn: false,
    talking: false,
    think: { on: false, timer: null, start: 0, frame: 0, verb: 0, tokens: 0 },
    pendingQuota: null,
    meter: {
      contextTokens: 0,
      contextWindow: 200_000,
      limits: null,
      totals: null,
      model: "",
      effort: "",
      permissionMode: "",
      sandboxMode: "",
      sessionModel: "",
      sessionId: "",
    },
    /** Agente personalizado da conversa; "" = conta pura. */
    agentId: "",
    /** Imagens ainda no composer, esperando envio. */
    pendingImages: [],
    /** Menu de autocomplete do composer ("/" e "@"). */
    slash: { open: false, index: 0, matches: [], kind: "cmd" },
    /** Fila pausada porque o turno acabou mal (quota/login/erro). */
    queuePaused: false,
    /** Markdown da fala em voo: no máximo um render por frame (ver scheduleStreamRender). */
    stream: { pending: null, raf: 0 },
    /** Projeto da conversa (null = chat geral, undefined = ainda não sabe). Foco troca o projeto. */
    projeto: undefined,
    /** Área de chats (area-de-chats.js): minimizado, peso da largura, última vez em foco. */
    minimizado: false,
    peso: 1,
    focadoEm: 0,
    /** Turno acabou com este chat sem foco: o cabeçalho diz "Terminou" até ele ganhar foco. */
    terminouNaoVisto: false,
    /** Texto curto do último fim ruim do turno ("Sem cota", "Erro no turno"); zera ao mandar. */
    erroDoTurno: "",
    /** Chat fixo do plano em tela cheia: "manager" | "implementacao"; "" = chat normal da área. */
    fixo: "",
  };
}

/** Campos só da instância (tela), que o `state` NÃO expõe: `state.projectPath` segue sendo do app. */
const SO_DA_INSTANCIA = new Set(["el", "projeto", "minimizado", "peso", "focadoEm", "terminouNaoVisto", "erroDoTurno", "fixo"]);

/** Campos do chat que o `state` do renderer expõe como getter do chat atual. */
export const CAMPOS_DO_CHAT = Object.freeze(Object.keys(criarEstadoDoChat()).filter((k) => !SO_DA_INSTANCIA.has(k)));

/**
 * Os chats na tela e qual está em foco. Sempre há um chat (o app nasce com um; o último não sai).
 */
export function criarAreaDeChats(primeiro = criarEstadoDoChat()) {
  const chats = [primeiro];
  let foco = primeiro;
  /** Pilha do `comChat` (aninha: um evento que dispara outro desenho do mesmo chat). */
  const pilha = [];

  return {
    get chats() {
      return chats.slice();
    },
    get foco() {
      return foco;
    },
    /** Chat que o código em curso está desenhando: o do `comChat` em volta, ou o em foco. */
    atual() {
      return pilha.length ? pilha[pilha.length - 1] : foco;
    },
    /** O trecho está desenhando o chat em foco? (barra de pensar, medidor, maguinho só pintam aí) */
    ehFoco(chat = this.atual()) {
      return chat === foco;
    },
    /** Roda `fn` com `chat` como atual (só o trecho síncrono); devolve o que `fn` devolver. */
    comChat(chat, fn) {
      pilha.push(chat);
      try {
        return fn();
      } finally {
        pilha.pop();
      }
    },
    /** Põe na tela na posição `indice` (padrão: no fim). */
    adicionar(chat, indice = chats.length) {
      if (!chats.includes(chat)) chats.splice(Math.max(0, Math.min(indice, chats.length)), 0, chat);
      return chat;
    },
    /** Nova ordem (mesmos chats). Lista que não bate com a atual é ignorada. */
    ordenar(lista) {
      if (lista.length !== chats.length || !lista.every((c) => chats.includes(c))) return false;
      chats.splice(0, chats.length, ...lista);
      return true;
    },
    /** Tira da tela. O último chat não sai; tirar o em foco passa o foco pro vizinho. */
    remover(chat) {
      const i = chats.indexOf(chat);
      if (i < 0 || chats.length === 1) return false;
      chats.splice(i, 1);
      if (foco === chat) foco = chats[Math.min(i, chats.length - 1)];
      return true;
    },
    focar(chat, agora = Date.now()) {
      if (chats.includes(chat)) {
        foco = chat;
        chat.focadoEm = agora;
      }
      return foco;
    },
    /** Chat que mostra a conversa `threadId`, se algum mostra. */
    doThread(threadId) {
      return threadId ? chats.find((c) => c.threadId === threadId) || null : null;
    },
    /** Conversas na tela (pra fila de fundo, painel de borda…). */
    threadsAbertas() {
      return chats.map((c) => c.threadId).filter(Boolean);
    },
  };
}

/**
 * Faz `state.<campo>` ler e escrever no chat atual da `area`, pra cada campo de `CAMPOS_DO_CHAT`.
 * Valor que já estava no `state` (antes de ligar) vai pro chat atual, pra não perder nada.
 */
export function ligarEstadoDoChat(state, area) {
  for (const campo of CAMPOS_DO_CHAT) {
    const tinha = Object.prototype.hasOwnProperty.call(state, campo);
    const valor = state[campo];
    if (tinha) delete state[campo];
    Object.defineProperty(state, campo, {
      configurable: true,
      enumerable: true,
      get: () => area.atual()[campo],
      set: (v) => {
        area.atual()[campo] = v;
      },
    });
    if (tinha && valor !== undefined) area.atual()[campo] = valor;
  }
  return state;
}

/**
 * SSE de uma conversa, preso à instância do chat: cada evento é processado com `comChat(chat, …)`,
 * então cai no log DAQUELE chat. Religa sozinho em queda com erro e em fim limpo do stream (o daemon
 * reiniciou), relendo a conversa antes de voltar a ouvir — o SSE não repõe o que perdeu.
 *
 * Dependências injetadas (o renderer passa as reais; o teste passa falsas):
 * - `conectar(threadId, signal)` → Promise que resolve quando o stream termina limpo; chama
 *   `aoEvento(ev)` pra cada evento lido (a função recebe `aoEvento` como 3º argumento).
 * - `aoEvento(ev)` → processa um evento (roda dentro de `comChat`).
 * - `aoReligar(chat)` → async; relê a conversa antes de ouvir de novo. Erro nela não impede religar.
 * - `podeReligar()` → false segura (motor desligado); o poll do motor religa depois pelo `sseOn`.
 * - `espera` (ms) antes de religar; `agendar(fn, ms)` (padrão setTimeout).
 */
export function ouvirConversa(chat, area, { conectar, aoEvento, aoReligar, podeReligar = () => true, espera = 1500, agendar = setTimeout, aoErro = () => {} }) {
  chat.abortSse?.abort();
  if (!chat.threadId) return null;
  const ac = new AbortController();
  const threadId = chat.threadId;
  chat.abortSse = ac;
  chat.sseOn = true;
  // conversa trocada neste chat (ou chat reaproveitado) = este stream não vale mais
  const vale = () => chat.abortSse === ac && chat.threadId === threadId;

  const religar = () => {
    chat.sseOn = false;
    if (!vale()) return;
    agendar(async () => {
      if (!vale()) return;
      if (!(await podeReligar())) return;
      try {
        await aoReligar?.(chat);
      } catch {
        /* se falhar, o ouvir abaixo ainda tenta de novo */
      }
      if (vale()) ouvirConversa(chat, area, { conectar, aoEvento, aoReligar, podeReligar, espera, agendar, aoErro });
    }, espera);
  };

  Promise.resolve()
    .then(() =>
      conectar(threadId, ac.signal, (ev) => {
        if (!vale()) return;
        area.comChat(chat, () => aoEvento(ev));
      }),
    )
    .then(religar)
    .catch((e) => {
      if (e?.name === "AbortError") {
        if (chat.abortSse === ac) chat.sseOn = false;
        return;
      }
      aoErro(e);
      religar();
    });
  return ac;
}
