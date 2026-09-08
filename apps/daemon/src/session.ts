import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, EngineKind, Profile, SwitchReason, ThreadEvent } from "@nexo/shared";
import { TURNO_TETO_MS } from "@nexo/shared";
import { agentOverrides, getAgent } from "./agents.ts";
import { promptWithAttachments, removeThreadAttachments, saveImages, type IncomingImage } from "./attachments.ts";
import { loadConfig } from "./config.ts";
import { tokenPath } from "./home.ts";
import { configDeMcpAutoria, MCP_TOOLS_AUTORIA, urlDeMcp } from "./mcp.ts";
import { ApiEngine } from "./engines/api.ts";
import { claudeEngine, codexEngine } from "./engines/cli.ts";
import { contextWindowOf } from "./engines/parse-claude.ts";
import { StubEngine } from "./engines/stub.ts";
import type { Engine } from "./engines/types.ts";
import {
  applyLoginResult,
  credentialVerdict,
  getProfile,
  markAuthFailed,
  rememberContextWindow,
} from "./profiles.ts";
import { pack, precisaCompactar, tetoDeToken, tokensDoHistorico } from "./packer.ts";
import {
  historicoParaResumir,
  montarCompactacao,
  pedidoDeResumo,
  podeCompactar,
} from "./compactar.ts";
import { assertSwitch, suggestFallback } from "./router.ts";
import { spawnCwd } from "./project-cwd.ts";
import { activeProfileId, appendEvent, readThread, removeThread } from "./threads.ts";

const CONTINUE = "Continue de onde parou.";

export type SessionEvent =
  | (EngineEvent & {
      threadId: string;
      suggestedProfileId?: string;
      chatOnly?: boolean;
    })
  /** Troca feita pelo próprio daemon (switchMode auto): o cliente não pediu, precisa saber. */
  | { type: "switched"; threadId: string; fromProfileId: string; toProfileId: string; reason: SwitchReason }
  /**
   * O histórico virou resumo. Vai pelo SSE porque acontece DEPOIS do turno, sem
   * ninguém ter pedido: a tela aberta precisa saber que o passado dela mudou de
   * forma, senão a próxima resposta parece ter esquecido coisas sem motivo.
   */
  | {
      type: "compacted";
      threadId: string;
      text: string;
      cobertos: number;
      tokensAntes: number;
      tokensDepois: number;
    }
  /**
   * Compactação começando ou terminando.
   *
   * NÃO vai pro JSONL: é estado de tela, não história. O registro do que
   * aconteceu é o `compacted`; isto existe porque resumir leva um turno inteiro
   * e, sem sinal, a pessoa fica olhando uma conversa que parece parada.
   *
   * O `off` vem sempre, inclusive quando falha — animação que só sabe começar
   * gira pra sempre.
   */
  | { type: "compacting"; threadId: string; on: boolean; tokens?: number; motivo?: string };

/** Turno em voo: sobrevive à troca de conta pra a conta nova continuar de onde a antiga parou. */
type PendingTurn = { text: string; partial: boolean };

/** Como o turno acabou. Todo caminho que fecha um turno passa por `setTerminal`. */
type Terminal = "done" | "quota" | "auth" | "error";

type Live = {
  engine: Engine;
  profileId: string;
  /** Agente personalizado da conversa; vazio = conta pura. */
  agentId?: string;
  assistantBuf: string;
  pendingTurn: PendingTurn | null;
  retryCount: number;
  pendingQuota: boolean;
  lastTerminal: Terminal | null;
  /** Quem está esperando o fim do turno; liberados por `setTerminal`. */
  terminalWaiters: Array<() => void>;
  /** Quando o turno em voo começou (ms). 0 = nenhum turno desde que o motor subiu. */
  startedAt: number;
  usage?: EngineEvent & { type: "usage" };
  limits?: EngineEvent & { type: "limits" };
  session?: EngineEvent & { type: "session" };
  /** Contexto do ÚLTIMO request individual da conversa (não o somado do turno inteiro). */
  contextTokens?: number;
};

/** Último limite visto por conta: serve pro painel mesmo sem thread ativa. */
const limitsByProfile = new Map<string, EngineEvent & { type: "limits" }>();

/**
 * Janela que cada conta REPORTOU, por conta.
 *
 * Fica aqui e não no `Live` porque o teto do pack é calculado ANTES de o motor
 * subir — então quem precisa do número é o próximo motor daquela conta, não o
 * atual. Memória só: daemon que reinicia volta pro palpite pelo nome do modelo,
 * que é o comportamento anterior, e reaprende no primeiro turno.
 */
const windowByProfile = new Map<string, number>();

export function limitsOf(profileId: string): (EngineEvent & { type: "limits" }) | undefined {
  return limitsByProfile.get(profileId);
}

/** Só as contas que já rodaram um turno desde o boot: quem não rodou não tem dado nenhum. */
export function allLimits(): Record<string, EngineEvent & { type: "limits" }> {
  return Object.fromEntries(limitsByProfile);
}

const lives = new Map<string, Live>();

/** Threads com turno em voo agora: alimenta o indicador de atividade na lista. */
export function busyThreads(): string[] {
  return [...lives.entries()].filter(([, l]) => l.pendingTurn !== null).map(([id]) => id);
}

/** Rabo do que o agente está escrevendo agora: o painel mostra o fim, não o começo. */
const TAIL_CHARS = 400;

/**
 * Retrato de cada conversa com motor de pé. É tudo memória — o JSONL não sabe o
 * que está em voo — então é aqui que o painel de agentes se abastece.
 */
export type AgentSnapshot = {
  threadId: string;
  profileId: string;
  agentId?: string;
  busy: boolean;
  model?: string;
  startedAt: number;
  tail: string;
  contextTokens?: number;
  pendingQuota: boolean;
  lastTerminal: Live["lastTerminal"];
};

export function agentSnapshots(): AgentSnapshot[] {
  return [...lives.entries()].map(([threadId, l]) => ({
    threadId,
    profileId: l.profileId,
    ...(l.agentId ? { agentId: l.agentId } : {}),
    busy: l.pendingTurn !== null,
    ...(l.session?.model ? { model: l.session.model } : {}),
    startedAt: l.startedAt,
    tail: l.assistantBuf.slice(-TAIL_CHARS),
    ...(l.contextTokens === undefined ? {} : { contextTokens: l.contextTokens }),
    pendingQuota: l.pendingQuota,
    lastTerminal: l.lastTerminal,
  }));
}

export const sessionBus = new EventEmitter();

function emit(threadId: string, ev: SessionEvent): void {
  sessionBus.emit(threadId, ev);
  sessionBus.emit("*", ev);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Fecha o turno e libera quem espera. Único lugar que *fecha* (só `sendTurn`
 * zera, ao abrir o turno seguinte): marcar o fim sem acordar os waiters deixaria
 * o dispatch parado até o timeout.
 *
 * Os waiters só resolvem promise, e promise resolvida continua em microtask —
 * então quem chama isso no meio de um branch termina o branch inteiro antes do
 * dispatch acordar, igual ao laço de polling que existia aqui. Se um dia um
 * waiter passar a rodar trabalho síncrono, essa ordem muda.
 */
function setTerminal(live: Live, kind: Terminal): void {
  live.lastTerminal = kind;
  const waiters = live.terminalWaiters;
  live.terminalWaiters = [];
  for (const acorda of waiters) acorda();
}

export function createEngine(profile: Profile, projectPath: string, home: string): Engine {
  const cwd = spawnCwd(projectPath);
  switch (profile.engine) {
    case "stub":
      return new StubEngine(cwd);
    case "api":
      return new ApiEngine({ home, profileId: profile.id });
    case "claude":
      return claudeEngine(home, profile.id);
    case "codex":
      return codexEngine(home, profile.id);
  }
}

export function engineKindOf(profileId: string, home: string): EngineKind {
  const p = getProfile(profileId, home);
  if (!p) throw new Error(`perfil não existe: ${profileId}`);
  return p.engine;
}

/**
 * Instruções do agente no topo do pack. O pack é congelado quando o motor sobe,
 * então editar as instruções vale a partir do próximo motor (troca de conta,
 * /clear ou reinício) — não no meio de uma conversa já em pé.
 */
function withInstructions(agentId: string | undefined, packText: string, home: string): string {
  const def = agentId ? getAgent(agentId, home) : undefined;
  const head = def?.instructions?.trim();
  if (!head) return packText;
  const bloco = `# Agente: ${def?.name ?? agentId}\n${head}`;
  return packText ? `${bloco}\n\n${packText}` : bloco;
}

/**
 * Modelo que ESTE motor vai rodar, pra saber a janela dele.
 *
 * A ordem é a da verdade, da mais forte pra mais fraca:
 * 1. o que já rodou nesta conversa — o CLI carimba o nome no `usage`, com o
 *    sufixo de janela (`[1m]`) que só ele sabe;
 * 2. o que o agente ou a conta declara — vale antes do primeiro turno;
 * 3. nada, e aí o teto cai no piso.
 *
 * Só `claude`: o sufixo `[1m]` é convenção do CLI dele, e chutar janela pra
 * `codex` ou pra um modelo de API arbitrário seria inventar número. Piso ali é
 * o comportamento que já existia.
 *
 * Exportado porque é aqui que mora a decisão: o motor de CLI não sobe em teste,
 * então essa ordem de precedência só se verifica direto.
 */
export function modeloDoMotor(profile: Profile, events: ThreadEvent[], agentId: string | undefined, home: string): string {
  if (profile.engine !== "claude") return "";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "usage" && e.model) return e.model;
  }
  return agentOverrides(agentId, home).model ?? profile.model ?? "";
}

/**
 * Janela do motor, da fonte melhor pra pior:
 * 1. o que a conta reportou NESTE processo — é a sessão que está de pé;
 * 2. o que ela reportou antes, gravado no perfil por modelo — sobrevive à
 *    subida do daemon, e é o que impede o primeiro turno depois de cada
 *    reinício de voltar ao palpite;
 * 3. o palpite pelo nome do modelo;
 * 4. nada, e aí o teto cai no piso.
 *
 * O gravado é por MODELO, então trocar o modelo do perfil não herda o número do
 * modelo antigo: cai pro palpite até o primeiro turno reportar o novo.
 *
 * Exportada pelo mesmo motivo do `modeloDoMotor`: a precedência é a decisão, e
 * o único jeito de verificá-la sem subir motor de CLI é chamando direto.
 */
export function janelaDaConta(profile: Profile, events: ThreadEvent[], agentId: string | undefined, home: string): number {
  const reportada = windowByProfile.get(profile.id);
  if (reportada) return reportada;
  const modelo = modeloDoMotor(profile, events, agentId, home);
  if (!modelo) return 0;
  return profile.contextWindows?.[modelo] ?? contextWindowOf(modelo);
}

async function ensureLive(threadId: string, home: string, profile?: Profile): Promise<Live> {
  const events = readThread(threadId, home);
  const meta = events.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") throw new Error("thread sem meta");
  const profileId = profile?.id ?? activeProfileId(events);
  const found = profile ?? getProfile(profileId, home);
  if (!found) throw new Error(`perfil não existe: ${profileId}`);
  const p = applyLoginResult(found.id, home);
  if (p.status !== "ready") {
    const why = credentialVerdict(p, home) === "dead" ? "credencial vencida" : "sem login";
    const err = new Error(`perfil ${p.id}: ${why} — rode nexo login ${p.id}`);
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  const existing = lives.get(threadId);
  if (existing && existing.profileId === p.id) return existing;

  const packed = pack(events, loadConfig(home).pack, tetoDeToken(janelaDaConta(p, events, meta.agentId, home)));
  if (packed.trimmed) {
    appendEvent(
      {
        ts: nowIso(),
        type: "context_trimmed",
        threadId,
        keptMessages: packed.trimmed.keptMessages,
        droppedMessages: packed.trimmed.droppedMessages,
      },
      home,
    );
  }
  const engine = createEngine(p, meta.projectPath, home);
  const live: Live = {
    engine,
    profileId: p.id,
    ...(meta.agentId ? { agentId: meta.agentId } : {}),
    assistantBuf: "",
    pendingTurn: null,
    retryCount: 0,
    pendingQuota: false,
    lastTerminal: null,
    terminalWaiters: [],
    startedAt: 0,
  };
  lives.set(threadId, live);
  await engine.start(
    {
      threadId,
      projectPath: meta.projectPath,
      profileId: p.id,
      // As instruções do agente abrem o pack: é o mais perto de "system prompt"
      // que o motor de CLI aceita (o `api` usa o pack como system de verdade).
      contextPack: withInstructions(meta.agentId, packed.text, home),
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
      ...mcpDaConversa(meta, p, home),
    },
    (ev) => onEngineEvent(threadId, home, ev),
  );
  return live;
}

/**
 * Qual servidor MCP esta conversa recebe.
 *
 * Conversa de SUPERVISOR já vem com o dela carimbado no `thread_meta` — presa
 * ao run, porque as ferramentas dela executam membros. Conversa normal ganha as
 * de AUTORIA: criar e editar agente e time, sem executar nada.
 *
 * `claude` e `codex`, cada um do jeito dele: o primeiro por arquivo de config
 * (`--mcp-config`), o segundo por chave de config e token em variável de
 * ambiente (`-c mcp_servers.nexo=…`). `api` e `stub` não entram — o `api` é
 * chamada HTTP direta ao provedor, sem cliente MCP nenhum, e dar ferramenta a
 * ele significaria o Nexo rodar o laço de ferramenta por conta própria.
 *
 * A conversa de SUPERVISOR segue só em `claude`: o servidor dela é preso ao run
 * e vem carimbado no `thread_meta` como CAMINHO DE ARQUIVO, formato que o codex
 * não usa. Nas contas codex o supervisor continua no canal por turno, que
 * agora funciona de verdade. Só a autoria — criar e editar agente e time, sem
 * executar nada — vale nos dois.
 */
function mcpDaConversa(
  meta: { mcpConfig?: string; mcpTools?: string[] },
  perfil: Profile,
  home: string,
): { mcpConfig?: string; mcpTools?: string[]; mcpHttp?: { url: string; token: string } } {
  if (meta.mcpConfig) {
    return {
      mcpConfig: meta.mcpConfig,
      ...(meta.mcpTools?.length ? { mcpTools: meta.mcpTools } : {}),
    };
  }
  if (perfil.engine === "codex") {
    const token = tokenDoHome(home);
    return token ? { mcpHttp: { url: urlDeMcp(loadConfig(home).port), token } } : {};
  }
  if (perfil.engine !== "claude") return {};
  const arquivo = arquivoDeAutoria(home);
  return arquivo ? { mcpConfig: arquivo, mcpTools: [...MCP_TOOLS_AUTORIA] } : {};
}

/** O token do daemon, ou vazio se ele ainda não subiu nesta home. */
function tokenDoHome(home: string): string {
  return existsSync(tokenPath(home)) ? readFileSync(tokenPath(home), "utf8").trim() : "";
}

/**
 * O arquivo de config das ferramentas de autoria.
 *
 * Um por home, não um por conversa: o conteúdo só depende da porta e do token,
 * e reescrever a cada turno seria I/O por nada. Ele é reescrito sempre porque a
 * porta pode ter mudado e o token pode ter sido rotacionado — arquivo velho
 * daria 401 no meio do turno, que o modelo leria como "a ferramenta sumiu".
 *
 * `0600` e em arquivo, não em argv: ele carrega o token, e argv é legível por
 * qualquer processo do mesmo usuário.
 */
function arquivoDeAutoria(home: string): string {
  const token = tokenDoHome(home);
  if (!token) return "";
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true });
  const arquivo = join(dir, "mcp-autoria.json");
  writeFileSync(arquivo, configDeMcpAutoria(loadConfig(home).port, token), {
    encoding: "utf8",
    mode: 0o600,
  });
  return arquivo;
}

/**
 * Compactação: um turno à parte que troca o histórico antigo por um resumo.
 *
 * Roda num motor PRÓPRIO, descartável, e não no da conversa. Três razões, todas
 * necessárias: o motor da conversa está com o pack congelado do turno atual;
 * mandar o pedido de resumo por ele gravaria pergunta e resposta no JSONL, ou
 * seja, o resumo entraria no histórico que ele acabou de resumir; e um motor
 * separado pode falhar sem contaminar a conversa.
 *
 * Dispara DEPOIS do turno, nunca antes: compactar antes faria a pessoa esperar
 * um turno inteiro pela resposta que ela pediu.
 */
const compactando = new Set<string>();
/** Conversa em que a compactação falhou não tenta de novo até o daemon reiniciar. */
const desistiu = new Map<string, string>();

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetCompactacaoForTest(): void {
  compactando.clear();
  desistiu.clear();
}

export function motivoDeNaoCompactar(threadId: string): string {
  return desistiu.get(threadId) ?? "";
}

async function talvezCompactar(threadId: string, home: string): Promise<void> {
  const cfg = loadConfig(home);
  if (!cfg.pack.compactar) return;
  if (compactando.has(threadId) || desistiu.has(threadId)) return;

  const events = readThread(threadId, home);
  const meta = events.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") return;
  const p = getProfile(meta.profileId, home);
  if (!p || !podeCompactar(p)) return;
  const cap = tetoDeToken(janelaDaConta(p, events, meta.agentId, home));
  if (!precisaCompactar(events, cfg.pack, cap)) return;

  const historico = historicoParaResumir(events, cfg.pack, cap);
  if (!historico) return;

  compactando.add(threadId);
  emit(threadId, { type: "compacting", threadId, on: true, tokens: tokensDoHistorico(events) });
  let motivo = "";
  try {
    const resumo = await turnoDeResumo(p, meta.projectPath, home, pedidoDeResumo(historico));
    // relê: o turno de resumo levou tempo, e mensagem nova pode ter chegado.
    // `cobertos` é índice absoluto, então o que chegou depois fica verbatim.
    const agora = readThread(threadId, home);
    const r = montarCompactacao(agora, cfg.pack, cap, threadId, resumo, nowIso());
    if (!r.ok) {
      motivo = r.motivo;
      desistiu.set(threadId, r.motivo);
      return;
    }
    appendEvent(r.evento, home);
    emit(threadId, r.evento);
  } catch (e) {
    /*
     * Falhou: registra e NÃO tenta de novo nesta conversa. Recompactar em loop
     * gastaria a quota da pessoa repetindo o mesmo erro, e o `pack` já tem o
     * corte como rede — o pior caso é o comportamento que existia antes.
     */
    motivo = (e as Error).message || "falhou";
    desistiu.set(threadId, motivo);
  } finally {
    compactando.delete(threadId);
    emit(threadId, { type: "compacting", threadId, on: false, ...(motivo ? { motivo } : {}) });
  }
}

/** Um turno só, num motor descartável, devolvendo o texto que ele produziu. */
function turnoDeResumo(p: Profile, projectPath: string, home: string, pedido: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const engine = createEngine(p, projectPath, home);
    let buf = "";
    let fechou = false;
    const fim = (erro?: string) => {
      if (fechou) return;
      fechou = true;
      clearTimeout(relogio);
      void engine.abort().catch(() => {});
      if (erro) reject(new Error(erro));
      else resolve(buf);
    };
    const relogio = setTimeout(() => fim("o resumo passou do teto de turno"), TURNO_TETO_MS);
    void engine
      /*
       * `compact-` e não `compact:`: o threadId vira nome de arquivo de pid
       * (`run/engine-<id>.pid`), e dois-pontos é ilegal em nome de arquivo no
       * Windows. No Linux passaria, o que é exatamente o tipo de bug que só
       * aparece na máquina de outra pessoa.
       */
      .start({ threadId: `compact-${Date.now()}`, projectPath, profileId: p.id, contextPack: "" }, (ev) => {
        if (ev.type === "text") buf += ev.text;
        else if (ev.type === "done") fim();
        else if (ev.type === "quota") fim("a quota da conta acabou");
        else if (ev.type === "auth") fim("a credencial da conta não serve mais");
        else if (ev.type === "error") fim(ev.message || "o motor falhou");
      })
      .then(() => engine.send(pedido))
      .catch((e: Error) => fim(e.message));
  });
}

function onEngineEvent(threadId: string, home: string, ev: EngineEvent): void {
  const live = lives.get(threadId);
  if (!live) return;
  if (ev.type === "text") {
    live.assistantBuf += ev.text;
    emit(threadId, { ...ev, threadId });
    return;
  }
  // pensamento é vitrine, não histórico: não entra no JSONL nem no context pack.
  if (ev.type === "thinking") {
    emit(threadId, { ...ev, threadId });
    return;
  }
  /**
   * Snapshot do request individual mais recente — não o somado do turno inteiro.
   * Um turno com N idas e vindas de ferramenta manda N usages e o "result" final
   * soma todos pro custo; contextTokens vindo do "result" ficava gigante em turnos
   * com muita ferramenta (podia passar da janela). Isso aqui guarda o valor real.
   */
  if (ev.type === "context") {
    live.contextTokens = ev.contextTokens;
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "window") {
    windowByProfile.set(live.profileId, ev.contextWindow);
    // o `session` pode ter chegado antes: corrige o número que veio do nome
    if (live.session) live.session = { ...live.session, contextWindow: ev.contextWindow };
    /*
     * A gravação acontece aqui E no `session` porque a janela e o NOME DO MODELO
     * chegam em linhas diferentes do stream, e a ordem entre elas é do CLI, não
     * nossa (hoje a janela vem primeiro). Quem chegar por último tem os dois e
     * grava; o outro lado não faz nada, porque gravar o mesmo valor é no-op.
     */
    if (live.session?.model) rememberContextWindow(live.profileId, home, live.session.model, ev.contextWindow);
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "usage") {
    live.usage = ev;
    appendEvent(
      {
        ts: nowIso(),
        type: "usage",
        threadId,
        ...(live.session?.model ? { model: live.session.model } : {}),
        input: ev.input,
        output: ev.output,
        cacheRead: ev.cacheRead,
        cacheCreate: ev.cacheCreate,
        contextTokens: live.contextTokens ?? ev.contextTokens,
        ...(ev.thinking ? { thinking: ev.thinking } : {}),
        ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}),
      },
      home,
    );
    emit(threadId, { ...ev, threadId });
    return;
  }
  // limite é da conta, não da thread: memória viva, sem ir pro JSONL.
  if (ev.type === "limits") {
    live.limits = ev;
    limitsByProfile.set(live.profileId, ev);
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "session") {
    // janela reportada ganha da deduzida do nome, tenha chegado antes ou depois
    const janela = windowByProfile.get(live.profileId);
    live.session = janela ? { ...ev, contextWindow: janela } : ev;
    if (janela && ev.model) rememberContextWindow(live.profileId, home, ev.model, janela);
    emit(threadId, { ...live.session, threadId });
    return;
  }
  if (ev.type === "tool") {
    appendEvent({ ts: nowIso(), type: "tool", threadId, name: ev.name, summary: ev.summary }, home);
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "done") {
    if (live.assistantBuf) {
      appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
    }
    live.assistantBuf = "";
    live.pendingTurn = null;
    live.retryCount = 0;
    setTerminal(live, "done");
    emit(threadId, { ...ev, threadId });
    // depois de responder, não antes: compactar leva um turno e a pessoa não
    // deve esperar por ele. Sem await de propósito — falha aqui não é falha do
    // turno que acabou de dar certo.
    void talvezCompactar(threadId, home);
    return;
  }
  if (ev.type === "quota") {
    live.pendingQuota = true;
    setTerminal(live, "quota");
    if (live.assistantBuf && live.pendingTurn) live.pendingTurn.partial = true;
    if (live.assistantBuf) {
      appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
      live.assistantBuf = "";
    }
    appendEvent(
      {
        ts: nowIso(),
        type: "error",
        threadId,
        message: ev.detail?.trim() || "Quota estourou",
        profileId: live.profileId,
      },
      home,
    );
    // Só `manual` manda sugestão: em `auto` o daemon troca em dispatch, em `denied` não troca.
    const suggestedProfileId =
      loadConfig(home).switchMode === "manual" ? suggestFallback(live.profileId, home) : undefined;
    const suggested = suggestedProfileId ? getProfile(suggestedProfileId, home) : undefined;
    emit(threadId, {
      type: "quota",
      threadId,
      suggestedProfileId,
      chatOnly: suggested?.engine === "api",
      ...(ev.detail ? { detail: ev.detail } : {}),
    });
    return;
  }
  if (ev.type === "auth") {
    setTerminal(live, "auth");
    if (live.assistantBuf && live.pendingTurn) live.pendingTurn.partial = true;
    if (live.assistantBuf) {
      appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
      live.assistantBuf = "";
    }
    const profile = getProfile(live.profileId, home);
    // api usa keys.json: rebaixar status ali só causaria flapping no próximo applyLoginResult.
    if (profile?.engine === "claude" || profile?.engine === "codex") {
      markAuthFailed(live.profileId, home);
    }
    const raw = ev.detail?.trim();
    const detail = `perfil ${live.profileId} precisa de login${raw ? `: ${raw}` : ""} — rode nexo login ${live.profileId}`;
    appendEvent({ ts: nowIso(), type: "error", threadId, message: detail, profileId: live.profileId }, home);
    const suggestedProfileId = suggestFallback(live.profileId, home);
    const suggested = suggestedProfileId ? getProfile(suggestedProfileId, home) : undefined;
    emit(threadId, {
      type: "auth",
      threadId,
      detail,
      suggestedProfileId,
      chatOnly: suggested?.engine === "api",
    });
    return;
  }
  if (ev.type === "error") {
    setTerminal(live, "error");
    if (live.assistantBuf && live.pendingTurn) live.pendingTurn.partial = true;
    emit(threadId, { ...ev, threadId });
  }
}

export async function postMessage(
  threadId: string,
  text: string,
  home: string,
  images: IncomingImage[] = [],
): Promise<void> {
  await withLocked(threadId, async () => {
    // Grava antes do turno: se o motor falhar, a imagem não se perde do histórico.
    const attachments = images.length > 0 ? saveImages(threadId, images, home) : [];
    appendEvent(
      { ts: nowIso(), type: "user", threadId, text, ...(attachments.length > 0 ? { attachments } : {}) },
      home,
    );
    const live = await ensureLive(threadId, home);
    await dispatch(threadId, home, live, promptWithAttachments(text, attachments));
  });
}

/**
 * Espera o turno fechar. O motor já é orientado a evento, então isso dorme até
 * `setTerminal` acordar — antes era laço de 20 ms, ~45 mil despertares num turno
 * de 15 minutos. O teto continua sendo erro: motor que não fecha trava a thread.
 */
function waitTerminal(live: Live, ms = TURNO_TETO_MS): Promise<void> {
  if (live.lastTerminal) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const acorda = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      live.terminalWaiters = live.terminalWaiters.filter((w) => w !== acorda);
      reject(new Error("engine timeout"));
    }, ms);
    live.terminalWaiters.push(acorda);
  });
}

/**
 * Manda o turno e registra o que está em voo. `partial` = a conta anterior já tinha
 * começado a escrever, então o certo é pedir continuação em vez de repetir o pedido.
 */
async function sendTurn(live: Live, text: string, partial = false): Promise<void> {
  live.pendingTurn = { text, partial };
  live.lastTerminal = null;
  live.startedAt = Date.now();
  await live.engine.send(partial ? CONTINUE : text);
}

async function dispatch(threadId: string, home: string, live: Live, text: string): Promise<void> {
  await sendTurn(live, text);
  await waitTerminal(live);
  const after = lives.get(threadId);
  if (!after) return;
  if (after.lastTerminal === "quota") {
    await autoSwitch(threadId, home, after);
    return;
  }
  if (after.lastTerminal === "error" && after.retryCount < 1) {
    const retries = after.retryCount + 1;
    await after.engine.abort();
    lives.delete(threadId);
    const again = await ensureLive(threadId, home);
    again.retryCount = retries;
    await sendTurn(again, text);
    await waitTerminal(again);
    if (again.lastTerminal === "error") {
      appendEvent(
        { ts: nowIso(), type: "error", threadId, message: "motor morreu", profileId: again.profileId },
        home,
      );
      const suggestedProfileId = suggestFallback(again.profileId, home);
      const suggested = suggestedProfileId ? getProfile(suggestedProfileId, home) : undefined;
      emit(threadId, {
        type: "error",
        message: "motor morreu",
        threadId,
        suggestedProfileId,
        chatOnly: suggested?.engine === "api",
      });
    }
  }
}

/**
 * switchMode `auto`: troca de conta e reenvia o turno sem perguntar nada.
 * Cada conta entra uma vez só — senão duas contas estouradas viram laço infinito.
 */
async function autoSwitch(threadId: string, home: string, live: Live): Promise<void> {
  if (loadConfig(home).switchMode !== "auto") return;
  const tried = new Set([live.profileId]);
  let current: Live | undefined = live;
  while (current?.lastTerminal === "quota") {
    const from = current.profileId;
    const next = suggestFallback(from, home);
    if (!next || tried.has(next)) return;
    tried.add(next);
    // switchNow já reenvia o turno em voo: aqui só se espera o terminal da conta nova.
    const continued = await switchNow(threadId, { profileId: next, confirmed: true, reason: "quota" }, home);
    emit(threadId, { type: "switched", threadId, fromProfileId: from, toProfileId: next, reason: "quota" });
    const fresh = lives.get(threadId);
    if (!fresh || !continued) return;
    await waitTerminal(fresh);
    current = lives.get(threadId);
  }
}

/** @returns true quando o turno em voo foi retomado na conta nova. */
export async function switchThread(
  threadId: string,
  input: { profileId: string; confirmed: boolean; reason: SwitchReason },
  home: string,
): Promise<boolean> {
  let continued = false;
  await withLocked(threadId, async () => {
    continued = await switchNow(threadId, input, home);
  });
  return continued;
}

/** Corpo da troca sem o lock: quem chama já está dentro de withLocked. */
async function switchNow(
  threadId: string,
  input: { profileId: string; confirmed: boolean; reason: SwitchReason },
  home: string,
): Promise<boolean> {
  assertSwitch(input);
  const next = getProfile(input.profileId, home);
  if (!next) throw new Error(`perfil não existe: ${input.profileId}`);
  if (next.status !== "ready") {
    const err = new Error("perfil unauthenticated");
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  const events = readThread(threadId, home);
  const from = activeProfileId(events);
  const live = lives.get(threadId);
  // Captura antes do abort: o `done` do abort limpa o turno pendente do live antigo.
  const pending = live?.pendingTurn ?? null;
  const resume = Boolean(live?.assistantBuf) || Boolean(pending?.partial);
  if (live) {
    if (live.assistantBuf) {
      appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
      live.assistantBuf = "";
    }
    await live.engine.abort();
    lives.delete(threadId);
  }
  const switched: ThreadEvent = {
    ts: nowIso(),
    type: "switched",
    threadId,
    fromProfileId: from,
    toProfileId: input.profileId,
    reason: input.reason,
    ...(resume ? { resume: true } : {}),
  };
  appendEvent(switched, home);
  const started = await ensureLive(threadId, home, next);
  // Trocar de conta não perde o turno: com resposta parcial pede continuação, senão repete o pedido.
  if (pending) await sendTurn(started, pending.text, resume);
  return Boolean(pending);
}

export function getLive(threadId: string): Live | undefined {
  return lives.get(threadId);
}

export async function abortThread(threadId: string): Promise<void> {
  await lives.get(threadId)?.engine.abort();
}

export async function dropThread(threadId: string, home: string): Promise<void> {
  await abortThread(threadId);
  lives.delete(threadId);
  removeThread(threadId, home);
  removeThreadAttachments(threadId, home);
}

/**
 * "/clear": grava a marca de corte e derruba a live em memória — sem isso o pack
 * congelado no engine já em voo continuaria sendo reusado até a próxima troca de conta.
 */
export async function clearThread(threadId: string, home: string): Promise<void> {
  readThread(threadId, home); // valida existência; lança "thread não existe" senão
  await withLocked(threadId, async () => {
    await abortThread(threadId);
    lives.delete(threadId);
    appendEvent({ ts: nowIso(), type: "cleared", threadId }, home);
  });
}

async function withLocked(threadId: string, fn: () => Promise<void>): Promise<void> {
  const { withThreadLock } = await import("./lock.ts");
  await withThreadLock(threadId, fn);
}
