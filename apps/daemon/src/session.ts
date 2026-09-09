import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, EngineKind, Profile, SwitchReason, ThreadEvent } from "@nexo/shared";
import { TURNO_TETO_MS } from "@nexo/shared";
import { agentOverrides, getAgent } from "./agents.ts";
import { readMemoria } from "./memoria.ts";
import { promptWithAttachments, removeThreadAttachments, saveImages, type IncomingImage } from "./attachments.ts";
import { loadConfig } from "./config.ts";
import { projectKey, tokenPath } from "./home.ts";
import { configDeMcpAutoria, MCP_TOOLS_AUTORIA, urlDeMcpAutoria } from "./mcp.ts";
import { graphifyDisponivel, MCP_TOOLS_GRAPHIFY } from "./graphify.ts";
import { MCP_TOOLS_VEREDITO } from "./veredito.ts";
import { MCP_TOOLS_PERGUNTAR } from "./perguntas.ts";
import { MCP_TOOLS_DELEGAR, resetContadorDeDelegacao } from "./delegar.ts";
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
  | { type: "compacting"; threadId: string; on: boolean; tokens?: number; motivo?: string }
  /** `nexo_perguntar` pausou o turno — ver perguntas.ts. NÃO passa por `onEngineEvent`: quem emite é a própria ferramenta, fora do laço do motor. */
  | { type: "pergunta"; threadId: string; id: string; texto: string; opcoes?: string[]; multiSelect?: boolean }
  | { type: "pergunta_resposta"; threadId: string; id: string; resposta: string }
  /**
   * `nexo_delegar` acabou de criar o run — ver delegar.ts. Não é histórico (por isso não vira
   * `ThreadEvent`): serve só pra tela achar o `runId` e abrir o subchat ao vivo
   * (`GET /v1/runs/:id/events`) na hora certa; o resultado final já chega pelo `tool_result` normal.
   */
  | { type: "delegacao_run"; threadId: string; runId: string };

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

export { sessionBus } from "./bus.ts";
import { sessionBus } from "./bus.ts";

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

/** Teto por VALOR de string — um `Write` de arquivo grande não pode inchar o `.jsonl` pra sempre. */
const TOOL_INPUT_VALUE_MAX = 2000;

/**
 * Versão segura de gravar dos argumentos de uma ferramenta — trunca só strings longas
 * (o caso comum: conteúdo de arquivo num `Write`/`Edit`), preservando o resto da forma pra a
 * bolha expandida na UI ainda fazer sentido.
 */
function capInputPraPersistir(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > TOOL_INPUT_VALUE_MAX ? `${v.slice(0, TOOL_INPUT_VALUE_MAX)}…` : v;
  }
  return out;
}

export function engineKindOf(profileId: string, home: string): EngineKind {
  const p = getProfile(profileId, home);
  if (!p) throw new Error(`perfil não existe: ${profileId}`);
  return p.engine;
}

/**
 * Instruções do agente e memória do projeto no topo do pack — nesta ordem
 * (agente é mais específico que projeto). Recalculado em TODO turno junto do
 * resto do pack (ver `ensureLive`), então editar agente ou o Nexo Hook
 * atualizar o `MEMORIA.md` valem já na próxima mensagem, sem precisar trocar
 * de conta nem `/clear`.
 */
function withInstructions(agentId: string | undefined, projectPath: string, packText: string, home: string): string {
  const def = agentId ? getAgent(agentId, home) : undefined;
  const instrucoes = def?.instructions?.trim();
  const memoria = readMemoria(projectPath, home).trim();
  const modulos = loadConfig(home).modulos;
  const blocos: string[] = [];
  // Módulo, não agente: vale pra TODA conversa (agente ou conta pura), por isso entra antes —
  // é a instrução mais geral do bloco, igual o usuário fraseia no próprio CLAUDE.md pessoal.
  if (modulos.caveman) {
    blocos.push(
      `# Módulo: Caveman\nResponda em modo caveman (skill \`caveman\`, intensidade \`${modulos.cavemanNivel}\`) em ` +
        'toda resposta, desde a primeira mensagem, sem precisar o usuário pedir. Só sai do modo se o usuário ' +
        'disser "stop caveman" ou "modo normal".',
    );
  }
  // Sem isso o modelo lista as opções como TEXTO comum ("A) ... B) ... C) ...") em vez de chamar a
  // ferramenta — a descrição do `tools/list` sozinha perde pro hábito. Vale em toda conversa: a
  // ferramenta está sempre disponível (perguntas.ts), e o custo de 2 linhas é bem menor que ter
  // que descobrir de novo, por tentativa, por que a pergunta não virou bolha interativa.
  blocos.push(
    "# Perguntar com opções\nQuando quiser que a pessoa ESCOLHA entre opções (não só confirme algo " +
      'em texto livre), chame a ferramenta `nexo_perguntar` com `opcoes` — não liste "A) ... B) ... ' +
      'C) ..." como texto comum. Isso vira uma pergunta de verdade na tela, com botão por opção, e ' +
      "pausa o turno até a resposta chegar. Se mais de uma opção puder valer ao mesmo tempo (ex.: " +
      '"quais destes pontos se aplicam?"), some `multiSelect: true`.',
  );
  if (instrucoes) blocos.push(`# Agente: ${def?.name ?? agentId}\n${instrucoes}`);
  if (memoria) blocos.push(`# Memória do projeto\n${memoria}`);
  // A descrição da ferramenta sozinha perde pro hábito de grepar — um lembrete no topo do pack
  // (mesmo peso que memória/instruções) empurra mais forte do que só o `tools/list` competindo
  // com o resto das ferramentas.
  if (graphifyDisponivel(projectPath)) {
    blocos.push(
      "# Grafo de conhecimento disponível\nEste projeto já tem um grafo semântico construído " +
        "(classes, funções, comunidades).\n" +
        "- **Já sabe o nome de um símbolo/arquivo?** Chame `nexo_grafo_explicar` com esse nome — é " +
        "preciso, não depende de achar o nó certo por busca livre.\n" +
        "- **Não sabe nenhum nome ainda?** `nexo_grafo_perguntar` faz uma busca livre a partir da " +
        "pergunta, mas pode partir de um nó errado (uma pergunta genérica tipo \"onde fica X\" pode " +
        "voltar nós sem relação nenhuma) — **confira se o resultado faz sentido antes de confiar " +
        "nele**; se vier irrelevante, tente uma pergunta mais específica (nome de tela, arquivo, " +
        "componente) ou aceite que precisa cair pra grep desta vez.\n" +
        "Em qualquer um dos dois casos, tente ANTES de sair lendo/grepando arquivo à toa — quando " +
        "acerta, é bem mais barato.",
    );
  }
  if (!blocos.length) return packText;
  return packText ? `${blocos.join("\n\n")}\n\n${packText}` : blocos.join("\n\n");
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
  /*
   * Recalculado em TODA chamada, mesmo quando o engine já está de pé: nenhum
   * motor guarda a conversa entre invocações (`--print`/`exec` sobem processo
   * novo a cada `send`, e a API não tem sessão nenhuma) — quem dá memória à
   * conversa é este pack, reconstruído do histórico gravado. Reaproveitar o
   * engine sem atualizar o pack faria ele repetir pra sempre o retrato de
   * quando subiu, cego às próprias respostas e ao que rodou de ferramenta desde
   * então — foi exatamente esse o bug: conversa "esquecendo" a partir da 2ª
   * mensagem.
   */
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

  const existing = lives.get(threadId);
  if (existing && existing.profileId === p.id) {
    existing.engine.updatePack(withInstructions(meta.agentId, meta.projectPath, packed.text, home));
    // Mesma razão do updatePack: sem isto, mudar `delegacaoModo`/`allowedTools` só valeria depois
    // de um engine NOVO (troca de conta, /clear, reiniciar o motor) — aqui vale já no próximo envio.
    existing.engine.updateMcp(mcpDaConversa(threadId, meta, p, home));
    return existing;
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
      // As instruções do agente e a memória do projeto abrem o pack: é o mais
      // perto de "system prompt" que o motor de CLI aceita (o `api` usa o
      // pack como system de verdade).
      contextPack: withInstructions(meta.agentId, meta.projectPath, packed.text, home),
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
      ...mcpDaConversa(threadId, meta, p, home),
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
  threadId: string,
  meta: { mcpConfig?: string; mcpTools?: string[]; projectPath: string; runId?: string },
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
    return token
      ? { mcpHttp: { url: urlDeMcpAutoria(loadConfig(home).port, meta.projectPath, meta.runId, threadId), token } }
      : {};
  }
  if (perfil.engine !== "claude") return {};
  const arquivo = arquivoDeAutoria(meta.projectPath, meta.runId, threadId, home);
  if (!arquivo) return {};
  const tools = [
    ...MCP_TOOLS_AUTORIA,
    ...(graphifyDisponivel(meta.projectPath) ? MCP_TOOLS_GRAPHIFY : []),
    // `runId` só existe quando esta conversa é o passo de um run de PIPELINE (ver `executarPasso`
    // em runs.ts) — é o que dá ao agente do hook de pre-push como declarar `{ aprovado, motivo }`.
    ...(meta.runId ? MCP_TOOLS_VEREDITO : []),
    // Em toda conversa (normal ou passo de Run) — `nexo_perguntar` não depende de run nenhum.
    ...MCP_TOOLS_PERGUNTAR,
    // Só em conversa NORMAL (sem runId) e com a conta liberada: é isso que barra a recursão — o
    // que `nexo_delegar` dispara é sempre um passo de Run, que já nasce com runId.
    ...(!meta.runId && perfil.delegacaoModo && perfil.delegacaoModo !== "negado" ? MCP_TOOLS_DELEGAR : []),
  ];
  return { mcpConfig: arquivo, mcpTools: tools };
}

/** O token do daemon, ou vazio se ele ainda não subiu nesta home. */
function tokenDoHome(home: string): string {
  return existsSync(tokenPath(home)) ? readFileSync(tokenPath(home), "utf8").trim() : "";
}

/**
 * O arquivo de config das ferramentas de autoria (e, se o projeto tiver
 * grafo construído, das de consulta ao graphify).
 *
 * Um por PROJETO, não mais um por home: desde que a URL passou a levar o
 * projeto embutido (`caminhoDaAutoria` em mcp.ts — é assim que o handler de
 * `/v1/mcp` sabe de qual `graphify-out/` oferecer ferramenta), duas conversas
 * de projetos diferentes rodando ao mesmo tempo não podem compartilhar um
 * arquivo só: a última a escrever venceria, e o motor da outra leria a URL do
 * projeto errado. Hash igual ao de `memoria.ts`/`services.ts` (sha1 de
 * `projectKey`); só os 10 primeiros caracteres bastam aqui — é nome de
 * arquivo transiente, não uma pasta permanente.
 *
 * Reescrito a cada turno mesmo assim, porque a porta pode ter mudado e o
 * token pode ter sido rotacionado — arquivo velho daria 401 no meio do turno,
 * que o modelo leria como "a ferramenta sumiu". `0600` e em arquivo, não em
 * argv: ele carrega o token, e argv é legível por qualquer processo do mesmo
 * usuário.
 */
function arquivoDeAutoria(projectPath: string, runId: string | undefined, threadId: string, home: string): string {
  const token = tokenDoHome(home);
  if (!token) return "";
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true });
  // `threadId` entra no hash desde que `nexo_perguntar` (perguntas.ts) escopa por thread: a URL
  // embutida agora é única por conversa, não só por projeto+run — arquivo compartilhado faria a
  // pergunta de uma conversa entregar a ferramenta com o threadId de outra.
  const hash = createHash("sha1")
    .update(`${projectKey(projectPath)}::${runId ?? ""}::${threadId}`)
    .digest("hex")
    .slice(0, 10);
  const arquivo = join(dir, `mcp-autoria-${hash}.json`);
  writeFileSync(arquivo, configDeMcpAutoria(loadConfig(home).port, token, projectPath, runId, threadId), {
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
    const input = capInputPraPersistir(ev.input);
    appendEvent(
      { ts: nowIso(), type: "tool", threadId, name: ev.name, summary: ev.summary, ...(ev.id ? { id: ev.id } : {}), ...(input !== undefined ? { input } : {}) },
      home,
    );
    emit(threadId, { ...ev, threadId });
    return;
  }
  if (ev.type === "tool_result") {
    // Sem `id` o resultado não casaria com bolha nenhuma na UI — mais vale sumir do que aparecer solto.
    if (!ev.id) return;
    appendEvent(
      { ts: nowIso(), type: "tool_result", threadId, id: ev.id, result: ev.result, ...(ev.isError ? { isError: true } : {}) },
      home,
    );
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
    // Teto de `nexo_delegar` é POR TURNO: mensagem nova reabre a cota.
    resetContadorDeDelegacao(threadId);
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
