import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElementoDoPreview, EngineEvent, EngineKind, EngineOverrides, PartesDoPack, Profile, SwitchReason, ThreadEvent } from "@nexos/shared";
import { ESFORCO_AUTO, MODELO_AUTO, MODELO_AUTO_FALLBACK, TURNO_TETO_MS } from "@nexos/shared";
import { agentOverrides, getAgent } from "./agents.ts";
import { readMemoria, readMemoriaGlobal } from "./memoria.ts";
import { promptWithAttachments, removeThreadAttachments, saveImages, textoComElementos, type IncomingImage } from "./attachments.ts";
import { loadConfig } from "./config.ts";
import { globalChatDir, projectKey, tokenPath } from "./home.ts";
import { configDeMcpAutoria, MCP_TOOLS_AUTORIA, urlDeMcpAutoria, urlDeMcpDeRun } from "./mcp.ts";
import { indiceDisponivel, lerIndice } from "./repo-map-indice.ts";
import { MCP_TOOLS_REPO_MAP } from "./repo-map-simbolos.ts";
import { MCP_TOOLS_VEREDITO } from "./veredito.ts";
import { MCP_TOOLS_PERGUNTAR, temPerguntaPendente } from "./perguntas.ts";
import { MCP_TOOLS_DELEGAR, resetContadorDeDelegacao } from "./delegar.ts";
import { MCP_TOOLS_NAVEGADOR } from "./navegador.ts";
import { MCP_TOOLS_DS_PRINT } from "./ds-print.ts";
import { MCP_TOOLS_PAINEL, MCP_TOOLS_PLANEJAR } from "./paineis.ts";
import { MCP_TOOLS_WINDOWS_CONTROL } from "./windows-control.ts";
import { MCP_TOOLS_TAREFA } from "./tarefas.ts";
import { expandirSkill } from "./skills.ts";
import { apagarSessaoClaude, gravarSessaoClaude, lerSessaoClaude } from "./claude-session.ts";
import { ApiEngine } from "./engines/api.ts";
import { claudeEngine, codexEngine, FECHAMENTO_NO_PACK } from "./engines/cli.ts";
import { contextWindowOf } from "./engines/parse-claude.ts";
import { StubEngine } from "./engines/stub.ts";
import type { Engine } from "./engines/types.ts";
import {
  applyLoginResult,
  credentialVerdict,
  getProfile,
  listProfiles,
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
import { activeAgentId, activeProfileId, appendEvent, readThread, removeThread, threadUsage } from "./threads.ts";
import { avisoNovoDePausa, decidirRoteamento, escolherExecucao, type EscolhaDeExecucao, type PausaDoTypesafe } from "./typesafe.ts";

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
  | { type: "delegacao_run"; threadId: string; runId: string }
  /**
   * TODA avaliação do roteador, inclusive a que não muda nada. Vai pelo SSE
   * porque acontece ANTES do turno, sem ninguém ter pedido: com `aplicado:
   * false` o turno fica PARADO esperando a pessoa aceitar/recusar.
   *
   * O caso `mudou: false` não vira evento no JSONL (seria uma linha por
   * mensagem, sempre dizendo "segue igual"), mas precisa chegar na tela: sem
   * ele, uma chamada paga por mensagem ficava 100% invisível, e não havia como
   * calibrar o limiar sem enxergar os quase-acertos.
   */
  | {
      type: "roteamento";
      threadId: string;
      tipo: "agente" | "time" | "automatico";
      alvo?: string;
      confianca: number;
      aplicado: boolean;
      mudou: boolean;
      motivo?: "mesmo-agente" | "abaixo-do-limiar" | "nenhum-se-aplica";
      probabilidades: Record<string, number>;
    }
  /**
   * Modelo do turno, quando a conta está no modelo "Automático". Não vai pro
   * JSONL: é escolha de execução (como o `--model` que o motor recebeu), não
   * história da conversa — e seria uma linha por mensagem. `fallback: true`
   * quer dizer que a escolha não veio (sem key, erro, timeout) e valeu o padrão.
   */
  | {
      type: "modelo_auto";
      threadId: string;
      /** O que o motor vai usar de fato. */
      model: string;
      confianca: number;
      fallback: boolean;
      /**
       * Por que esse modelo. Separa dois casos que antes viravam o mesmo texto
       * mentiroso ("escolha indisponível"): não ter escolha nenhuma é bem
       * diferente de ter uma escolha sem convicção — e nesta segunda o palpite
       * costuma ser o MESMO modelo do fallback, o que tornava o aviso absurdo.
       */
      motivo: "escolhido" | "confianca-baixa" | "indisponivel";
      /** Palpite do roteador quando ele existiu mas não passou do piso. */
      sugerido?: string;
      probabilidades?: Record<string, number>;
    }
  /** Esforço do turno, quando o controle de esforço está em "Automático". Mesma lógica do `modelo_auto`. */
  | {
      type: "esforco_auto";
      threadId: string;
      effort: string;
      confianca: number;
      fallback: boolean;
      motivo: "escolhido" | "confianca-baixa" | "indisponivel";
      sugerido?: string;
    }
  /**
   * Roteamento IA parou de chamar o typesafe por um tempo (key recusada, ou serviço sem responder).
   * Uma vez por pausa, não por mensagem; também não vai pro JSONL.
   */
  | ({ type: "typesafe_pausado"; threadId: string } & PausaDoTypesafe);

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
  /**
   * Teve ferramenta (ou fim de resposta, `usage`) desde o último texto: o próximo `text` é outro
   * bloco do modelo — o "Vejo o arquivo…" entre uma ferramenta e outra, ou a volta dele quando a
   * tarefa em background termina — e ganha uma linha em branco na frente. Sem isso os blocos
   * saíam colados no histórico ("…arquivo.Erro no meu…").
   */
  blocoNovo?: boolean;
  /**
   * Texto deste turno que já foi pro JSONL (gravado a cada ferramenta, ver `gravarTextoDoTurno`).
   * `assistantBuf` zera a cada ferramenta; isto aqui guarda que o modelo já falou algo — é o que
   * decide se o turno é parcial (retomar com "continue") e alimenta o `tail` do agente.
   */
  textoDoTurno?: string;
  pendingTurn: PendingTurn | null;
  retryCount: number;
  pendingQuota: boolean;
  lastTerminal: Terminal | null;
  /** Quem está esperando o fim do turno; liberados por `setTerminal`. */
  terminalWaiters: Array<() => void>;
  /** Quando o turno em voo começou (ms). 0 = nenhum turno desde que o motor subiu. */
  startedAt: number;
  usage?: EngineEvent & { type: "usage" };
  /** Esforço que o daemon de fato passou neste turno — o `usage` não sabe disso sozinho. */
  esforcoDoTurno?: string;
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

/** Só as contas que já tiveram uma resposta real desde o boot — turno de verdade ou `pingUsoDeTodasAsContas`. */
export function allLimits(): Record<string, EngineEvent & { type: "limits" }> {
  return Object.fromEntries(limitsByProfile);
}

const lives = new Map<string, Live>();

/**
 * Turno realmente em voo: o motor foi acionado e ainda não fechou.
 *
 * Não basta `pendingTurn !== null` — ele sobrevive de propósito a `quota` e `auth`,
 * porque é dele que `switchNow`/`retomarTurnoPendente` tiram o texto pra reenviar na
 * conta nova. Quando não há pra onde trocar (sem fallback, ou a pessoa nunca decide),
 * o turno fica pendente pra sempre e o indicador de atividade acendia pra sempre junto.
 * `lastTerminal` é o par certo: `sendTurn` zera ao despachar, `setTerminal` preenche ao
 * fechar — inclusive em quota/auth/erro. Quem espera decisão aparece por `pendingQuota`.
 */
function emVoo(l: Live): boolean {
  return l.pendingTurn !== null && l.lastTerminal === null;
}

/** Threads com turno em voo agora: alimenta o indicador de atividade na lista. */
export function busyThreads(): string[] {
  return [...lives.entries()].filter(([, l]) => emVoo(l)).map(([id]) => id);
}

/** Essa conta tem motor de pé AGORA (conversa aberta com ela), turno em voo ou não. Usado pra o ping de uso pular quem já está sendo usado. */
export function perfilEmUso(profileId: string): boolean {
  return [...lives.values()].some((l) => l.profileId === profileId);
}

/**
 * Conta com turno RODANDO agora — o `limits` dela chega nesse turno. Diferente de `perfilEmUso`:
 * o motor fica de pé depois do turno, então conversa aberta e parada também conta como "em uso",
 * e o clique no anel (que é pedido explícito de "lê agora") nunca atualizava a conta do dia a dia.
 */
export function perfilEmVoo(profileId: string): boolean {
  return [...lives.values()].some((l) => l.profileId === profileId && emVoo(l));
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
  /** Turno parado em `nexo_perguntar`, esperando a resposta de quem usa (o painel pinta âmbar). */
  aguardando: boolean;
};

/**
 * Texto que o modelo está escrevendo agora e ainda não foi pro JSONL (vai na próxima ferramenta
 * ou no fim do turno). Quem reabre a conversa no meio do turno recebe isso junto do histórico,
 * senão a fala em curso só aparecia depois do `done`.
 */
export function textoEmVoo(threadId: string): string {
  const l = lives.get(threadId);
  return l && emVoo(l) ? l.assistantBuf : "";
}

export function agentSnapshots(): AgentSnapshot[] {
  return [...lives.entries()].map(([threadId, l]) => ({
    threadId,
    profileId: l.profileId,
    ...(l.agentId ? { agentId: l.agentId } : {}),
    busy: emVoo(l),
    ...(l.session?.model ? { model: l.session.model } : {}),
    startedAt: l.startedAt,
    tail: ((l.textoDoTurno ?? "") + l.assistantBuf).slice(-TAIL_CHARS),
    ...(l.contextTokens === undefined ? {} : { contextTokens: l.contextTokens }),
    pendingQuota: l.pendingQuota,
    lastTerminal: l.lastTerminal,
    aguardando: temPerguntaPendente(threadId),
  }));
}

export { sessionBus } from "./bus.ts";
import { sessionBus } from "./bus.ts";
import { blocoDoDsParaPack, REGRA_MOCK_NO_CANVAS } from "./ds-sync.ts";
import { pastaDoPlano } from "./planejamento.ts";
import { blocoDoHandoff, blocoDoManager, MCP_TOOLS_PLANEJAMENTO, MCP_TOOLS_PLANO_NA_IMPLEMENTACAO } from "./planejamento-ferramentas.ts";

/** O que muda nas instruções fixas conforme o tipo da conversa (ver `opcoesDoPack`). */
type OpcoesDoPack = { incluirDs?: boolean; oculta?: boolean; planejamento?: string; handoff?: string };

/** Opções do pack a partir do `thread_meta` — um lugar só pros dois caminhos de `ensureLive`. */
function opcoesDoPack(meta: {
  oculta?: boolean;
  semRoteamento?: boolean;
  planejamento?: { slug: string };
  handoff?: { slug: string };
}): OpcoesDoPack {
  return {
    // DS fica fora da geração do próprio DS e do Manager (que não mexe em front)
    incluirDs: !(meta.oculta || meta.semRoteamento || meta.planejamento),
    oculta: meta.oculta === true,
    ...(meta.planejamento ? { planejamento: meta.planejamento.slug } : {}),
    ...(meta.handoff ? { handoff: meta.handoff.slug } : {}),
  };
}

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

export function createEngine(profile: Profile, projectPath: string | undefined, home: string): Engine {
  const cwd = spawnCwd(projectPath ?? globalChatDir(home));
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
 * resto do pack (ver `ensureLive`), então editar agente ou o Nexos Hook
 * atualizar o `MEMORIA.md` valem já na próxima mensagem, sem precisar trocar
 * de conta nem `/clear`.
 */
function withInstructions(
  agentId: string | undefined,
  projectPath: string | undefined,
  packText: string,
  home: string,
  opts: OpcoesDoPack = {},
): string {
  return juntarPack(instrucoesDoPack(agentId, projectPath, home, opts), packText);
}

function juntarPack(instrucoes: string, historico: string): string {
  if (!instrucoes) return historico;
  return historico ? `${instrucoes}\n\n${historico}` : instrucoes;
}

/** Pack pro motor: junto (`contextPack`) e separado (`partesDoPack`, system prompt no `claude`). */
function packDaConversa(
  agentId: string | undefined,
  projectPath: string | undefined,
  historico: string,
  home: string,
  opts: OpcoesDoPack,
): { contextPack: string; partesDoPack: PartesDoPack } {
  const instrucoes = instrucoesDoPack(agentId, projectPath, home, opts);
  return { contextPack: juntarPack(instrucoes, historico), partesDoPack: { instrucoes, historico } };
}

/** As regras fixas do pack (módulos, DS, agente, memória, repo map), sem o histórico. */
function instrucoesDoPack(
  agentId: string | undefined,
  projectPath: string | undefined,
  home: string,
  opts: OpcoesDoPack = {},
): string {
  const def = agentId ? getAgent(agentId, home) : undefined;
  const instrucoes = def?.instructions?.trim();
  const memoria = (projectPath ? readMemoria(projectPath, home) : readMemoriaGlobal(home)).trim();
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
      'C) ..." como texto comum, nem numere "1. ... 2. ... 3. ..." perguntas diferentes num texto só. ' +
      "Isso vira uma pergunta de verdade na tela, com botão por opção, e pausa o turno até a " +
      "resposta chegar. Se mais de uma opção puder valer ao mesmo tempo (ex.: \"quais destes " +
      'pontos se aplicam?"), some `multiSelect: true`. **Tem VÁRIAS perguntas pendentes?** Chame ' +
      "`nexo_perguntar` uma de cada vez (a próxima só depois da resposta da anterior) — nunca junte " +
      "todas numa lista de texto só esperando uma resposta que cubra tudo.",
  );
  // Sem isso o turno às vezes termina numa frase de progresso ("agora vou ajustar X…") e a pessoa
  // fica sem saber o que de fato mudou — o resumo é o que ela lê primeiro ao voltar pro chat.
  // conversa de trabalho do Nexos (geração do DS) responde em formato fixo: resumo ali atrapalha
  if (!opts.oculta) blocos.push(
    `${FECHAMENTO_NO_PACK}\nQuando o turno usou ferramentas (editou arquivo, rodou comando, ` +
      "delegou), a ÚLTIMA mensagem é um resumo curto pra quem pediu: o que mudou (arquivos/efeitos), " +
      "o que foi verificado (teste, build) e o que ficou pendente ou precisa de decisão. Nunca termine " +
      "o turno numa frase de progresso do tipo \"agora vou…\". Pergunta simples sem ferramenta não " +
      "precisa de resumo.",
  );
  // Vale em toda conversa com projeto, igual "Perguntar com opções" — quadro de tarefas só serve
  // pra coordenar times/humano se ele reflete trabalho real, não só o que foi planejado no início.
  // Toggle em Configurações → Módulos (`modulos.quadroTarefas`), ligado por padrão.
  // o Manager não trabalha tarefas: ele planeja (o plano vira tarefa no envio pra implementação)
  if (modulos.quadroTarefas && !opts.planejamento) {
    blocos.push(
      "# Quadro de tarefas\nEste projeto tem um quadro (`nexo_tarefa_listar` / `nexo_tarefa_salvar`). " +
        "Pergunta ou pedido ÚNICO: não liste o quadro — responda/aja direto. " +
        "**A mensagem tem MAIS DE UM pedido** (duas ou mais coisas distintas pra fazer, numeradas, " +
        "separadas por 'e depois', 'também', listas, etc.): ANTES de começar o trabalho, chame " +
        "`nexo_tarefa_listar` e crie UM card por pedido (`nexo_tarefa_salvar`, coluna de andamento " +
        "no que for atacar agora, as outras na coluna inicial). Não junte vários pedidos num card só. " +
        "Enquanto trabalha, vá atualizando o card da vez (checklist, comentário, coluna). Ao concluir " +
        "um pedido, mova o card dele pra coluna final e só então passe pro próximo.",
    );
  }
  // Design system ativo do projeto (Fase 5): é isto que faz o agente usar os tokens ao mexer no
  // front. Fora das conversas de trabalho do próprio DS, que já recebem tudo no pedido delas.
  if (projectPath && opts.incluirDs !== false) {
    const ds = blocoDoDsParaPack(projectPath, home);
    if (ds) blocos.push(ds);
    blocos.push(REGRA_MOCK_NO_CANVAS);
  }
  // Tela de Planejamento: o Manager e a conversa de implementação que nasce do envio
  if (projectPath && opts.planejamento) blocos.push(blocoDoManager(opts.planejamento, pastaDoPlano(projectPath, home, opts.planejamento)));
  if (projectPath && opts.handoff) blocos.push(blocoDoHandoff(opts.handoff, pastaDoPlano(projectPath, home, opts.handoff)));
  if (instrucoes) blocos.push(`# Agente: ${def?.name ?? agentId}\n${instrucoes}`);
  if (memoria) blocos.push(`# Memória ${projectPath ? "do projeto" : "geral"}\n${memoria}`);
  // Repo map — Camada 1 (índice, texto fixo, sem custo de LLM) + o nudge da Camada 2 (ferramenta
  // sob demanda). Mesmo bloco/peso que memória: descrição de ferramenta sozinha perde pro hábito
  // de grepar, um lembrete no topo do pack empurra mais forte que só o `tools/list` competindo.
  // Sem projeto (chat geral) não existe árvore de arquivos pra mapear.
  if (projectPath && indiceDisponivel(projectPath, home)) {
    const indice = lerIndice(projectPath, home);
    if (indice) blocos.push(`# Repo map — árvore de arquivos deste projeto\n${indice}`);
    blocos.push(
      "# Símbolos sob demanda\nRegra: antes de ler (`Read`) um arquivo de código deste projeto pela " +
        "PRIMEIRA vez na conversa, chame `nexo_mapa_simbolos` nele — sem perguntar, sem esperar ser " +
        "pedido. Ele devolve as assinaturas top-level (função, classe, export, interface/type) na hora " +
        "e custa uma fração do token de ler o arquivo inteiro; abra o arquivo de verdade só depois, e só " +
        "se os símbolos confirmarem que o que você procura está lá. Vale pra pasta também: antes de " +
        "listar/explorar uma pasta arquivo por arquivo, chame `nexo_mapa_simbolos` nela pra ver todo " +
        "mundo de uma vez.",
    );
  }
  return blocos.join("\n\n");
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
  // Agente pode ter sido atribuído DEPOIS da criação (roteamento por typesafe.ai
  // — ver postMessage/agent_assigned): `activeAgentId` olha o evento mais
  // recente, caindo pro `meta.agentId` de sempre quando não há atribuição.
  const agentId = activeAgentId(events);
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
  const packed = pack(events, loadConfig(home).pack, tetoDeToken(janelaDaConta(p, events, agentId, home)));
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
  if (existing && existing.profileId === p.id && existing.agentId === agentId) {
    const novo = packDaConversa(agentId, meta.projectPath, packed.text, home, opcoesDoPack(meta));
    existing.engine.updatePack(novo.contextPack, novo.partesDoPack);
    // Mesma razão do updatePack: sem isto, mudar `delegacaoModo`/`allowedTools` só valeria depois
    // de um engine NOVO (troca de conta, /clear, reiniciar o motor) — aqui vale já no próximo envio.
    existing.engine.updateMcp(mcpDaConversa(threadId, meta, p, home));
    const gravada = lerSessaoClaude(threadId, home);
    if (gravada?.profileId === p.id) existing.engine.updateResume(gravada.sessionId);
    return existing;
  }

  const engine = createEngine(p, meta.projectPath, home);
  const live: Live = {
    engine,
    profileId: p.id,
    ...(agentId ? { agentId } : {}),
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
      // As instruções do agente e a memória do projeto abrem o pack (o `api` usa o pack como system
      // de verdade); separadas em `partesDoPack`, o `claude` manda as regras como system prompt.
      ...packDaConversa(agentId, meta.projectPath, packed.text, home, opcoesDoPack(meta)),
      ...(agentId ? { agentId } : {}),
      // Conversa com branch fixa roda na `git worktree` isolada, não na pasta
      // compartilhada do projeto — só o cwd do processo muda (ver StartOpts.cwdOverride).
      ...(meta.worktreeDir ? { cwdOverride: meta.worktreeDir } : {}),
      ...mcpDaConversa(threadId, meta, p, home),
      // Agent Manager não altera o projeto (engines/cli.ts: só leitura, escrita negada)
      ...(meta.planejamento ? { somenteLeitura: true } : {}),
    },
    (ev) => onEngineEvent(threadId, home, ev),
  );
  const gravadaNova = lerSessaoClaude(threadId, home);
  if (gravadaNova?.profileId === p.id) engine.updateResume(gravadaNova.sessionId);
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
 * ele significaria o Nexos rodar o laço de ferramenta por conta própria.
 *
 * A conversa de SUPERVISOR vale nos dois, e o `mcpRunId` no `thread_meta` é o
 * que tornou isso possível: antes o marcador era o `mcpConfig`, um CAMINHO DE
 * ARQUIVO que só o claude lê, então supervisor em conta codex caía pro canal
 * por turno (um turno inteiro por decisão) por limitação do NOSSO formato, não
 * do CLI dele. O servidor é o mesmo (`/v1/mcp/:runId`); só muda o transporte.
 */
function mcpDaConversa(
  threadId: string,
  meta: {
    mcpConfig?: string;
    mcpTools?: string[];
    projectPath?: string;
    runId?: string;
    mcpRunId?: string;
    planejamento?: { slug: string };
    handoff?: { slug: string };
  },
  perfil: Profile,
  home: string,
): { mcpConfig?: string; mcpTools?: string[]; mcpHttp?: { url: string; token: string } } {
  // supervisor: servidor preso ao run, transporte por motor
  if (meta.mcpRunId && perfil.engine === "codex") {
    const token = tokenDoHome(home);
    return token ? { mcpHttp: { url: urlDeMcpDeRun(loadConfig(home).port, meta.mcpRunId), token } } : {};
  }
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
  // Agent Manager: só o plano, perguntar e o mapa do repo (leitura) — o conjunto do servidor
  // (`/v1/mcp`, http.ts) faz o mesmo recorte olhando a thread
  if (meta.planejamento) {
    return {
      mcpConfig: arquivo,
      mcpTools: [
        ...MCP_TOOLS_PLANEJAMENTO,
        ...MCP_TOOLS_PERGUNTAR,
        ...(loadConfig(home).paineisDoAgente.modo !== "nunca" ? MCP_TOOLS_PAINEL : []),
        ...(meta.projectPath && indiceDisponivel(meta.projectPath, home) ? MCP_TOOLS_REPO_MAP : []),
      ],
    };
  }
  const tools = [
    // implementação de um plano: marca andamento e ajusta o plano (http.ts monta o mesmo recorte)
    ...(meta.handoff && !meta.runId ? MCP_TOOLS_PLANO_NA_IMPLEMENTACAO : []),
    ...MCP_TOOLS_AUTORIA,
    ...(meta.projectPath && indiceDisponivel(meta.projectPath, home) ? MCP_TOOLS_REPO_MAP : []),
    // `runId` só existe quando esta conversa é o passo de um run de PIPELINE (ver `executarPasso`
    // em runs.ts) — é o que dá ao agente do hook de pre-push como declarar `{ aprovado, motivo }`.
    ...(meta.runId ? MCP_TOOLS_VEREDITO : []),
    // Em toda conversa (normal ou passo de Run) — `nexo_perguntar` não depende de run nenhum.
    ...MCP_TOOLS_PERGUNTAR,
    ...(loadConfig(home).modulos.quadroTarefas ? MCP_TOOLS_TAREFA : []),
    // Só em conversa NORMAL (sem runId) e com a conta liberada: é isso que barra a recursão — o
    // que `nexo_delegar` dispara é sempre um passo de Run, que já nasce com runId.
    ...(!meta.runId && perfil.delegacaoModo && perfil.delegacaoModo !== "negado" ? MCP_TOOLS_DELEGAR : []),
    // Só em conversa NORMAL — não existe <webview> num run headless (ver navegador.ts).
    ...(!meta.runId && perfil.navegadorModo && perfil.navegadorModo !== "negado" ? MCP_TOOLS_NAVEGADOR : []),
    // print do card do design system renderizado (ds-print.ts): conversa normal de projeto
    ...(!meta.runId && meta.projectPath ? MCP_TOOLS_DS_PRINT : []),
    // abrir o painel certo na área de trabalho (navegador, design, quadro…): conversa normal
    ...(!meta.runId && loadConfig(home).paineisDoAgente.modo !== "nunca" ? MCP_TOOLS_PAINEL : []),
    ...(!meta.runId && meta.projectPath && !meta.handoff ? MCP_TOOLS_PLANEJAR : []),
    // Gate GLOBAL, não por conta (ver windows-control.ts): mexe em QUALQUER app da máquina, não
    // só o Nexos. `profileFlags` em engines/cli.ts filtra de novo, incondicional — esta linha só
    // evita listar a ferramenta quando já se sabe de antemão que a chamada vai ser barrada.
    ...(!meta.runId && loadConfig(home).windowsControlEnabled ? MCP_TOOLS_WINDOWS_CONTROL : []),
  ];
  return { mcpConfig: arquivo, mcpTools: tools };
}

/** O token do daemon, ou vazio se ele ainda não subiu nesta home. */
function tokenDoHome(home: string): string {
  return existsSync(tokenPath(home)) ? readFileSync(tokenPath(home), "utf8").trim() : "";
}

/**
 * O arquivo de config das ferramentas de autoria (e, se o projeto tiver
 * índice do repo map construído, da ferramenta de símbolos sob demanda).
 *
 * Um por PROJETO, não mais um por home: desde que a URL passou a levar o
 * projeto embutido (`caminhoDaAutoria` em mcp.ts — é assim que o handler de
 * `/v1/mcp` sabe de qual índice de repo map oferecer ferramenta), duas conversas
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
function arquivoDeAutoria(projectPath: string | undefined, runId: string | undefined, threadId: string, home: string): string {
  const token = tokenDoHome(home);
  if (!token) return "";
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true });
  // `threadId` entra no hash desde que `nexo_perguntar` (perguntas.ts) escopa por thread: a URL
  // embutida agora é única por conversa, não só por projeto+run — arquivo compartilhado faria a
  // pergunta de uma conversa entregar a ferramenta com o threadId de outra.
  const hash = createHash("sha1")
    .update(`${projectPath ? projectKey(projectPath) : "sem-projeto"}::${runId ?? ""}::${threadId}`)
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

  /*
   * Com `--resume`, o CLI `claude` tem sessão longa de verdade — o autocompact
   * dele passa a valer. Um turno extra nosso de resumo só queima quota.
   */
  const live = lives.get(threadId);
  if (live?.session?.sessionId) {
    const perfil = getProfile(live.profileId, home);
    if (perfil?.engine === "claude") return;
  }

  const events = readThread(threadId, home);
  const meta = events.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") return;
  const p = getProfile(meta.profileId, home);
  if (!p || !podeCompactar(p)) return;
  const cap = tetoDeToken(janelaDaConta(p, events, activeAgentId(events), home));
  const contextTokensReal = threadUsage(threadId, home).contextTokens;
  if (!precisaCompactar(events, cfg.pack, cap, contextTokensReal)) return;

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
function turnoDeResumo(p: Profile, projectPath: string | undefined, home: string, pedido: string): Promise<string> {
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

/**
 * Limite de uso NÃO tem consulta de graça — o CLI só entrega `5h`/`7d` junto da resposta de uma
 * mensagem de verdade (`auth status --json`, que não gasta nada, não traz isso). Pra o painel
 * "Uso de todas as contas" não ficar com "sem dado ainda" pra quem não está numa conversa
 * agora, manda uma mensagem mínima por conta claude/codex logada, num motor descartável (mesmo
 * padrão de `turnoDeResumo`) — sem thread, sem gravar nada em disco, só pra capturar o evento
 * `limits` e alimentar `limitsByProfile`. Chamado no boot do daemon e depois a cada 30 minutos
 * (`cli.ts`).
 */
async function pingUso(p: Profile, home: string): Promise<void> {
  return new Promise((resolve) => {
    const engine = createEngine(p, home, home);
    let fechou = false;
    const fim = () => {
      if (fechou) return;
      fechou = true;
      clearTimeout(relogio);
      void engine.abort().catch(() => {});
      resolve();
    };
    // 60s cobre até uma resposta lenta pra "oi" — não precisa do teto de 15min de um turno de verdade
    const relogio = setTimeout(fim, 60_000);
    void engine
      .start({ threadId: `ping-uso-${p.id}-${Date.now()}`, projectPath: home, profileId: p.id, contextPack: "" }, (ev) => {
        if (ev.type === "limits") limitsByProfile.set(p.id, ev);
        else if (ev.type === "done" || ev.type === "error" || ev.type === "quota" || ev.type === "auth") fim();
      })
      .then(() => engine.send("oi"))
      .catch(fim);
  });
}

/**
 * Pinga as contas claude/codex logadas em paralelo — uma falha (conta sem quota, etc.) não
 * derruba as outras. `status` persistido só é reconferido (`applyLoginResult`) quando ainda NÃO
 * está `ready` — mesmo padrão de `GET /v1/profiles/:id` (http.ts) — porque uma conta recém-logada
 * fora de uma conversa pode ter o carimbo desatualizado, e é justo essa (nunca usada ainda) que
 * mais precisa do ping. Pula quem já está `perfilEmUso` — conta com conversa aberta agora já
 * recebe `limits` de verdade no próprio turno (ver `onEngineEvent`), então o ping descartável
 * aqui seria gasto duplicado sem ganhar nada.
 */
export async function pingUsoDeTodasAsContas(home: string): Promise<void> {
  /*
   * Só `claude`. O ping existe pra capturar `limits`, e `parse-codex.ts` não
   * emite esse evento — o `codex exec --json` não reporta janela de uso em
   * lugar nenhum. Incluir conta codex aqui gastava um turno de verdade por
   * conta, a cada 30 minutos, esperando um evento que nunca podia chegar: o
   * turno era cobrado e o painel continuava vazio do mesmo jeito.
   */
  const candidatos = listProfiles(home).filter((p) => p.engine === "claude");
  const alvos = candidatos
    .map((p) => (p.status === "ready" ? p : applyLoginResult(p.id, home)))
    .filter((p) => p.status === "ready" && !perfilEmUso(p.id));
  await Promise.allSettled(alvos.map((p) => pingUso(p, home)));
}

/**
 * Atualiza o uso de UMA conta agora (o clique no anel do painel). Mesmo ping descartável do
 * `pingUsoDeTodasAsContas`: só `claude` (codex não reporta janela). Só não pinga com turno em voo
 * (`perfilEmVoo`) — aí o `limits` chega no próprio turno. Conversa aberta e parada NÃO segura: o
 * uso dela pode ter mudado fora do Nexos, e quem clicou pediu o número de agora.
 */
export async function pingUsoDaConta(id: string, home: string): Promise<"ok" | "em-uso" | "sem-suporte" | "indisponivel"> {
  const p = getProfile(id, home);
  if (!p) return "indisponivel";
  if (p.engine !== "claude") return "sem-suporte";
  if (perfilEmVoo(p.id)) return "em-uso";
  const pronta = p.status === "ready" ? p : applyLoginResult(p.id, home);
  if (pronta.status !== "ready") return "indisponivel";
  await pingUso(pronta, home);
  return "ok";
}

/**
 * Grava no JSONL o texto que o modelo escreveu desde a última ferramenta. Chamado ANTES de gravar
 * cada ferramenta: sem isso o texto do turno só ia pro disco no `done`, e quem reabria a conversa
 * no meio do turno (trocou de tela e voltou) via só os grupos de ferramenta — e, depois do fim,
 * o texto todo vinha num bloco só, depois de todas as ferramentas.
 */
function gravarTextoDoTurno(live: Live, threadId: string, home: string): void {
  if (!live.assistantBuf) return;
  appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
  live.textoDoTurno = (live.textoDoTurno ?? "") + live.assistantBuf;
  live.assistantBuf = "";
}

/** O modelo já escreveu algo neste turno (gravado ou ainda no buffer). */
function falouNoTurno(live: Live): boolean {
  return Boolean(live.assistantBuf || live.textoDoTurno);
}

function onEngineEvent(threadId: string, home: string, ev: EngineEvent): void {
  const live = lives.get(threadId);
  if (!live) return;
  // resposta nascendo: canal próprio, fora do stream do chat (seria um evento por token pra tela
  // que não usa) e fora do histórico (o texto inteiro ainda chega no `text`)
  if (ev.type === "text_parcial") {
    sessionBus.emit(`parcial:${threadId}`, { ...ev, threadId });
    return;
  }
  if (ev.type === "text") {
    const text = live.blocoNovo && live.assistantBuf && !/\s$/.test(live.assistantBuf) ? `\n\n${ev.text}` : ev.text;
    live.blocoNovo = false;
    live.assistantBuf += text;
    emit(threadId, { ...ev, text, threadId });
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
    live.blocoNovo = true;
    live.usage = ev;
    appendEvent(
      {
        ts: nowIso(),
        type: "usage",
        threadId,
        ...(live.session?.model ? { model: live.session.model } : {}),
        ...(live.esforcoDoTurno ? { effort: live.esforcoDoTurno } : {}),
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
    // Modelo/esforço vão no SSE também: o evento do motor não os carrega, e sem
    // isso a bolha em voo nunca sabia com o que a resposta foi feita.
    emit(threadId, {
      ...ev,
      threadId,
      ...(live.session?.model ? { model: live.session.model } : {}),
      ...(live.esforcoDoTurno ? { effort: live.esforcoDoTurno } : {}),
    });
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
    if (ev.sessionId) {
      live.engine.updateResume(ev.sessionId);
      gravarSessaoClaude(threadId, live.profileId, ev.sessionId, home);
    }
    emit(threadId, { ...live.session, threadId });
    return;
  }
  if (ev.type === "tool") {
    live.blocoNovo = true;
    gravarTextoDoTurno(live, threadId, home);
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
    live.textoDoTurno = "";
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
    if (falouNoTurno(live) && live.pendingTurn) live.pendingTurn.partial = true;
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
    if (falouNoTurno(live) && live.pendingTurn) live.pendingTurn.partial = true;
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
    if (falouNoTurno(live) && live.pendingTurn) live.pendingTurn.partial = true;
    emit(threadId, { ...ev, threadId });
  }
}

/**
 * Confiança mínima pra TROCAR quem está tocando a conversa. Medido nos testes:
 * pedido claro dá 0.9–1.0, e caso genuinamente ambíguo cai pra 0.30–0.47 — sem
 * esse piso, meia dúzia de mensagens de meio de conversa faria a thread pular
 * de agente por ruído. Abaixo disso, fica quem já estava.
 */
const LIMIAR_DE_TROCA = 0.7;

/**
 * Limiar menor pra SAIR de um agente que só lê (`permissionMode: "plan"` — o
 * explorador, o revisor, o qa-tester...). A histerese existe pra evitar vaivém
 * entre agentes que dariam conta do trabalho; ela não deve proteger um agente
 * que está impedido de fazer o que foi pedido.
 *
 * Veio de um caso real: com o explorador tocando a conversa, "Vamos resolver
 * isso ai" deu `implementador` com 0.46 (0.49 × 0.42 — quase empate). Manter o
 * explorador não era o lado seguro: ele não edita arquivo, então a mensagem
 * seguinte ia falhar de qualquer jeito — e falhou, com o Edit dando erro.
 */
const LIMIAR_SAINDO_DE_SO_LEITURA = 0.4;

/**
 * Confiança mínima pra confiar na escolha de modelo do turno. Abaixo disso vale
 * o `MODELO_AUTO_FALLBACK`: a assimetria é o argumento — errar pro modelo barato
 * custa resposta ruim e retrabalho, errar pro caro custa só tokens.
 */
const LIMIAR_DE_MODELO = 0.6;

/** Últimas falas que vão como contexto da decisão. Curto de propósito: o catálogo de candidatos já domina o custo do request. */
const FALAS_DE_CONTEXTO = 6;

export function historicoPraRoteamento(events: ThreadEvent[]): { quem: "usuario" | "agente"; texto: string }[] {
  const falas: { quem: "usuario" | "agente"; texto: string }[] = [];
  for (const e of events) {
    if (e.type === "user") falas.push({ quem: "usuario", texto: e.text });
    else if (e.type === "assistant") falas.push({ quem: "agente", texto: e.text });
  }
  return falas.slice(-FALAS_DE_CONTEXTO).map((f) => ({ ...f, texto: f.texto.slice(0, 600) }));
}

/**
 * Roteamento por typesafe.ai, a cada mensagem de uma conversa que nasceu sem
 * agente explícito. Decide olhando a mensagem nova COM o histórico ao lado, e
 * só mexe na conversa quando há motivo:
 *
 * - escolha igual a quem já está tocando → não faz nada (nem grava evento, pra
 *   não encher o JSONL de "continua o mesmo" a cada turno);
 * - confiança abaixo de `LIMIAR_DE_TROCA` → mantém quem está (histerese);
 * - "automatico" → mantém quem está; desatribuir agente no meio da conversa
 *   seria mais confuso que útil, e o caso "ninguém se aplica" já é o padrão de
 *   quem nunca foi roteado.
 *
 * "Time" nunca é aplicado sozinho, nem em modo "automatico": disparar um run
 * tem efeito real (escreve código, pode abrir PR), então sempre vira sugestão
 * pendente (`aplicado: false`), igual agente em modo "perguntar".
 */
async function talvezRotear(
  threadId: string,
  tarefa: string,
  eventos: ThreadEvent[],
  home: string,
): Promise<{ pendente: boolean }> {
  const agenteAtual = activeAgentId(eventos);
  const decisao = await decidirRoteamento(
    { mensagem: tarefa, historico: historicoPraRoteamento(eventos), agenteAtual },
    home,
  );
  if (!decisao) return { pendente: false };

  const alvoBruto = decisao.tipo === "agente" ? decisao.agentId : decisao.tipo === "time" ? decisao.teamId : undefined;
  /*
   * Motivos de não mexer na conversa. Todos viram aviso na tela (SSE), nenhum
   * vira linha no histórico: "continua igual" repetido a cada mensagem seria
   * ruído, mas silêncio total escondia que a avaliação sequer aconteceu.
   */
  /*
   * Permissão EFETIVA do agente atual, não a que ele declara: se a conta da
   * pessoa manda (ver `permissaoDoTurno`), o agente não está de fato travado em
   * leitura, e não faz sentido afrouxar o limiar por causa disso.
   */
  const perfilDaThread = getProfile(activeProfileId(eventos), home);
  const permissaoEfetiva =
    permissaoDoTurno(eventos, perfilDaThread).permissionMode ?? agentOverrides(agenteAtual, home).permissionMode;
  const atualSoLe = permissaoEfetiva === "plan";
  const limiar = atualSoLe ? LIMIAR_SAINDO_DE_SO_LEITURA : LIMIAR_DE_TROCA;
  const motivo =
    decisao.tipo === "automatico"
      ? ("nenhum-se-aplica" as const)
      : decisao.tipo === "agente" && decisao.agentId === agenteAtual
        ? ("mesmo-agente" as const)
        : decisao.confianca < limiar
          ? ("abaixo-do-limiar" as const)
          : undefined;
  if (motivo) {
    emit(threadId, {
      type: "roteamento",
      threadId,
      tipo: decisao.tipo,
      ...(alvoBruto ? { alvo: alvoBruto } : {}),
      confianca: decisao.confianca,
      aplicado: true,
      mudou: false,
      motivo,
      probabilidades: decisao.probabilidades,
    });
    return { pendente: false };
  }

  const alvo = alvoBruto as string;
  const aplicaAgora = decisao.tipo === "agente" && loadConfig(home).typesafe.modo === "automatico";
  appendEvent(
    {
      ts: nowIso(),
      type: "roteamento",
      threadId,
      tipo: decisao.tipo,
      alvo,
      tarefa,
      confianca: decisao.confianca,
      probabilidades: decisao.probabilidades,
      aplicado: aplicaAgora,
    },
    home,
  );
  if (aplicaAgora && decisao.tipo === "agente") {
    appendEvent(
      { ts: nowIso(), type: "agent_assigned", threadId, agentId: decisao.agentId, confianca: decisao.confianca },
      home,
    );
  }
  emit(threadId, {
    type: "roteamento",
    threadId,
    tipo: decisao.tipo,
    alvo,
    confianca: decisao.confianca,
    aplicado: aplicaAgora,
    mudou: true,
    probabilidades: decisao.probabilidades,
  });
  return { pendente: !aplicaAgora };
}

/**
 * Agente ESCOLHIDO por você na criação da conversa: aí a config dele vale
 * inteira, permissão inclusive — você adotou o agente sabendo o que ele é.
 * Agente atribuído pelo ROTEAMENTO é outra história (ver `permissaoDoTurno`).
 */
function agenteFoiEscolhidoPelaPessoa(eventos: ThreadEvent[]): boolean {
  const meta = eventos.find((e) => e.type === "thread_meta");
  return Boolean(meta?.type === "thread_meta" && meta.agentId);
}

/**
 * Permissão do turno. Agente atribuído pelo roteamento NÃO rebaixa a permissão
 * que a pessoa escolheu na conta.
 *
 * Veio de um caso real: conta em `bypassPermissions` ("Ignorar permissões"), o
 * roteamento atribuiu sozinho o `implementador` (`acceptEdits`), e o argv saiu
 * com acceptEdits — que libera edição mas não comando de shell. Resultado: "This
 * command requires approval" num `--print`, onde não existe canal pra aprovar.
 * A pessoa escolheu uma permissão e o sistema a trocou por baixo sem avisar.
 *
 * Conta sem permissão definida segue usando a do agente: não há escolha da
 * pessoa pra preservar.
 */
function permissaoDoTurno(eventos: ThreadEvent[], perfil: Profile | undefined): EngineOverrides {
  if (!perfil?.permissionMode) return {};
  if (agenteFoiEscolhidoPelaPessoa(eventos)) return {};
  return { permissionMode: perfil.permissionMode };
}

/**
 * Overrides do turno, em um lugar só: a permissão (sempre) e o modelo quando a
 * conta está em "Automático". Entram por cima de conta e agente no `syncArgs`.
 *
 * O modelo só é escolhido quando o que valeria é literalmente `MODELO_AUTO` —
 * agente com modelo próprio manda mais, e aí não há o que escolher. Falha de
 * qualquer tipo deixa o modelo de fora, e `profileFlags` cai no fallback
 * (sonnet/medium) em vez de mandar `--model auto` pro CLI.
 */
/** Modelo/esforço que valeriam no turno (agente > conta) e quais deles estão em "Automático". */
function execucaoDoTurno(perfil: Profile | undefined, agentId: string | undefined, home: string) {
  const doAgente = agentOverrides(agentId, home);
  const modeloQueValeria = doAgente.model ?? perfil?.model;
  const esforcoQueValeria = doAgente.effort ?? perfil?.effort;
  return {
    modeloQueValeria,
    esforcoQueValeria,
    querModelo: modeloQueValeria === MODELO_AUTO,
    querEsforco: esforcoQueValeria === ESFORCO_AUTO,
  };
}

/** Escolha de modelo/esforço já em voo, pedida antes de saber o agente final do turno. */
type EscolhaAntecipada = {
  engine: EngineKind;
  querer: { modelo: boolean; esforco: boolean };
  promessa: Promise<EscolhaDeExecucao>;
};

/**
 * Dispara a escolha de modelo/esforço JÁ, em paralelo com o roteamento e o `ensureLive` — antes
 * as duas chamadas ao typesafe iam em série e a pessoa esperava a soma antes do motor receber a
 * mensagem. Usa a conta e o agente de agora; se o roteamento trocar o agente e a necessidade mudar,
 * `aplicarOverridesDoTurno` descarta isto e pergunta de novo (caso raro, custa só a espera antiga).
 */
function anteciparEscolha(eventos: ThreadEvent[], mensagem: string, home: string): EscolhaAntecipada | undefined {
  const perfil = getProfile(activeProfileId(eventos), home);
  if (!perfil) return undefined;
  const { querModelo, querEsforco } = execucaoDoTurno(perfil, activeAgentId(eventos), home);
  if (!querModelo && !querEsforco) return undefined;
  const querer = { modelo: querModelo, esforco: querEsforco };
  const promessa = escolherExecucao({ mensagem, historico: historicoPraRoteamento(eventos) }, home, perfil.engine, querer)
    // escolherExecucao já não lança; isto só impede rejeição solta se algo antes do try estourar
    .catch((): EscolhaDeExecucao => ({}));
  return { engine: perfil.engine, querer, promessa };
}

/** Avisa no chat, uma vez por pausa, que o Roteamento IA parou de chamar o typesafe. */
function avisarPausaDoTypesafe(threadId: string, home: string): void {
  const pausa = avisoNovoDePausa(home);
  if (pausa) emit(threadId, { type: "typesafe_pausado", threadId, ...pausa });
}

async function aplicarOverridesDoTurno(
  threadId: string,
  mensagem: string,
  eventos: ThreadEvent[],
  live: Live,
  home: string,
  antecipada?: EscolhaAntecipada,
): Promise<void> {
  const perfil = getProfile(live.profileId, home);
  const permissao = permissaoDoTurno(eventos, perfil);
  // Agente manda mais que conta nas duas dimensões: onde ele fixou, não há o que escolher.
  const { esforcoQueValeria, querModelo, querEsforco } = execucaoDoTurno(perfil, live.agentId, home);
  if (!perfil || (!querModelo && !querEsforco)) {
    // Nada dinâmico: o esforço do turno é o configurado mesmo (agente > conta).
    live.esforcoDoTurno = esforcoQueValeria;
    live.engine.updateOverrides(permissao);
    return;
  }
  // A antecipada vale se perguntou pelo menos o que este turno precisa, no mesmo motor.
  const serve =
    antecipada &&
    antecipada.engine === perfil.engine &&
    (!querModelo || antecipada.querer.modelo) &&
    (!querEsforco || antecipada.querer.esforco);
  const escolha = serve
    ? await antecipada.promessa
    : await escolherExecucao(
        { mensagem, historico: historicoPraRoteamento(eventos) },
        home,
        perfil.engine,
        { modelo: querModelo, esforco: querEsforco },
      );
  avisarPausaDoTypesafe(threadId, home);
  /*
   * Piso de confiança, e não só "usa o que veio": medindo contra a API real, uma
   * pergunta de depuração empatou e saiu no modelo barato com confiança 0.15 —
   * moeda girando. Como errar pro barato custa resposta fraca e retrabalho, e
   * errar pro caro custa só tokens, dúvida vira fallback (o mais capaz).
   */
  const modeloOk = querModelo && Boolean(escolha.model) && escolha.model!.confianca >= LIMIAR_DE_MODELO;
  /*
   * Esforço NÃO tem piso: ele vem de um `Score` (escala ordenada), onde
   * distribuição espalhada já sai como o meio-termo — o número entre níveis é a
   * resposta, não um empate a descartar. Piso aqui jogaria fora justamente o
   * caso que o Score existe pra resolver.
   */
  const esforcoOk = querEsforco && Boolean(escolha.effort);
  live.engine.updateOverrides({
    ...permissao,
    ...(modeloOk ? { model: escolha.model!.valor } : {}),
    ...(esforcoOk ? { effort: escolha.effort!.valor } : {}),
  });
  // O que o motor vai receber de fato — vira o `effort` do `usage` deste turno.
  live.esforcoDoTurno = querEsforco
    ? esforcoOk
      ? escolha.effort!.valor
      : MODELO_AUTO_FALLBACK.effort
    : esforcoQueValeria;
  if (querModelo) {
    emit(threadId, {
      type: "modelo_auto",
      threadId,
      model: modeloOk ? escolha.model!.valor : MODELO_AUTO_FALLBACK.model,
      confianca: escolha.model?.confianca ?? 0,
      fallback: !modeloOk,
      motivo: modeloOk ? "escolhido" : escolha.model ? "confianca-baixa" : "indisponivel",
      ...(escolha.model && !modeloOk ? { sugerido: escolha.model.valor } : {}),
      ...(escolha.model ? { probabilidades: escolha.model.probabilidades } : {}),
    });
  }
  if (querEsforco) {
    emit(threadId, {
      type: "esforco_auto",
      threadId,
      effort: esforcoOk ? escolha.effort!.valor : MODELO_AUTO_FALLBACK.effort,
      confianca: escolha.effort?.confianca ?? 0,
      fallback: !esforcoOk,
      motivo: esforcoOk ? "escolhido" : escolha.effort ? "confianca-baixa" : "indisponivel",
      ...(escolha.effort && !esforcoOk ? { sugerido: escolha.effort.valor } : {}),
    });
  }
}

/**
 * `/nome-da-skill` vira o corpo da skill pros motores que não sabem carregar
 * skill sozinhos. O `claude` fica de fora porque o CLI dele já interpreta a
 * barra — expandir aqui mandaria a mesma skill duas vezes no turno.
 */
function comSkill(text: string, live: Live, home: string, meta?: ThreadEvent): string {
  const engine = getProfile(live.profileId, home)?.engine;
  if (!engine || engine === "claude") return text;
  const projectPath = meta?.type === "thread_meta" ? meta.projectPath : undefined;
  return expandirSkill(text, home, live.profileId, projectPath);
}

/**
 * Resultados de times chamados deste chat que chegaram DEPOIS da última mensagem: vão na frente
 * do próximo pedido pro motor. Pack não basta — com `--resume` o `claude` não relê o histórico,
 * e o agente deste chat nunca saberia o que o time fez.
 */
function resultadosPendentes(eventos: ThreadEvent[]): string {
  let i = eventos.length - 1;
  while (i >= 0 && eventos[i]!.type !== "user") i--;
  const blocos: string[] = [];
  for (const e of eventos.slice(i + 1)) {
    if (e.type !== "run_resultado") continue;
    const estado = e.status === "done" ? "terminou" : e.status === "aborted" ? "foi cancelado" : "falhou";
    blocos.push(
      `[O time "${e.titulo}" que você chamou ${estado}.${e.arquivo ? ` Saída completa em ${e.arquivo}.` : ""}]\n${e.texto}`,
    );
  }
  return blocos.length ? `${blocos.join("\n\n")}\n\n---\n\n` : "";
}

export async function postMessage(
  threadId: string,
  text: string,
  home: string,
  images: IncomingImage[] = [],
  opts: { automatico?: boolean; elementos?: ElementoDoPreview[] } = {},
): Promise<void> {
  await withLocked(threadId, async () => {
    // Teto de `nexo_delegar` é POR TURNO: mensagem nova reabre a cota.
    resetContadorDeDelegacao(threadId);
    /*
     * Roteia a cada mensagem, não só na primeira: uma conversa muda de fase
     * (mapear → implementar → revisar) e travar na intenção da 1ª mensagem
     * deixava o resto da thread com o agente errado.
     *
     * Só participa conversa que NASCEU sem agente: se a pessoa abriu a conversa
     * escolhendo um agente (`thread_meta.agentId`), essa escolha é dela e não é
     * revista sozinha nunca — `activeAgentId` não serve de guarda aqui porque
     * ele também devolve agente atribuído por roteamento anterior.
     */
    const eventosAtuais = readThread(threadId, home);
    const meta = eventosAtuais.find((e) => e.type === "thread_meta");
    const nasceuSemAgente = meta?.type === "thread_meta" && !meta.agentId && !meta.semRoteamento;
    // Sai antes do roteamento pra correr junto com ele (e com o ensureLive), não depois.
    const antecipada = anteciparEscolha(eventosAtuais, text, home);
    const roteamento = nasceuSemAgente
      ? await talvezRotear(threadId, text, eventosAtuais, home)
      : { pendente: false };
    avisarPausaDoTypesafe(threadId, home);
    // Grava antes do turno: se o motor falhar, a imagem não se perde do histórico.
    const attachments = images.length > 0 ? saveImages(threadId, images, home) : [];
    const resultados = resultadosPendentes(eventosAtuais);
    appendEvent(
      {
        ts: nowIso(),
        type: "user",
        threadId,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(opts.elementos?.length ? { elementos: opts.elementos } : {}),
        ...(opts.automatico ? { automatico: true } : {}),
      },
      home,
    );
    /*
     * Sugestão pendente PARA o turno aqui: responder já e trocar de agente
     * depois seria pior que não rotear — a resposta sairia do agente errado, e
     * aceitar depois não desfaz o que já foi dito (nem o que já foi executado).
     * Quem retoma é `retomarTurnoPendente`, chamado pelo endpoint de decisão.
     */
    if (roteamento.pendente) return;
    const live = await ensureLive(threadId, home);
    await aplicarOverridesDoTurno(threadId, text, eventosAtuais, live, home, antecipada);
    await dispatch(threadId, home, live, promptWithAttachments(resultados + comSkill(textoComElementos(text, opts.elementos), live, home, meta), attachments));
  });
}

/**
 * Mensagem mandada COM o turno em voo, pro motor ler entre uma ferramenta e outra (ver
 * `Engine.inject`). Sem trava de thread de propósito: `postMessage` segura a trava o turno
 * inteiro, e esperar por ela é justamente o que isto evita.
 *
 * `false` = não deu pra injetar (sem turno em voo, motor sem suporte, turno fechando) — nada foi
 * gravado e quem chamou manda pela fila normal.
 *
 * O texto que o modelo já escreveu vai pro histórico ANTES da mensagem nova: sem isso o JSONL
 * ficava "pedido 1, pedido 2, resposta inteira", e a resposta ao pedido 1 parecia vir depois do 2.
 */
export function injetarMensagem(threadId: string, text: string, home: string, images: IncomingImage[] = []): boolean {
  const live = lives.get(threadId);
  if (!live || !emVoo(live) || !live.engine.inject) return false;
  const attachments = images.length > 0 ? saveImages(threadId, images, home) : [];
  if (!live.engine.inject(promptWithAttachments(text, attachments))) return false;
  if (live.assistantBuf) {
    appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
    live.assistantBuf = "";
  }
  appendEvent(
    { ts: nowIso(), type: "user", threadId, text, ...(attachments.length > 0 ? { attachments } : {}) },
    home,
  );
  return true;
}

/**
 * Despacha a mensagem que ficou parada esperando a decisão de roteamento.
 * Reconstrói o pedido a partir do próprio evento `user` já gravado, então vale
 * igual pra mensagem com anexo. Sem sugestão pendente, não faz nada.
 */
export async function retomarTurnoPendente(threadId: string, home: string): Promise<void> {
  await withLocked(threadId, async () => {
    const events = readThread(threadId, home);
    const ultima = [...events].reverse().find((e) => e.type === "user");
    if (!ultima || ultima.type !== "user") return;
    const live = await ensureLive(threadId, home);
    await dispatch(threadId, home, live, promptWithAttachments(textoComElementos(ultima.text, ultima.elementos), ultima.attachments ?? []));
  });
}

/**
 * Espera o turno fechar. O motor já é orientado a evento, então isso dorme até
 * `setTerminal` acordar — antes era laço de 20 ms, ~45 mil despertares num turno
 * de 15 minutos. O teto continua sendo erro: motor que não fecha trava a thread.
 */
/**
 * Teto com tarefa em background de pé (Monitor, `run_in_background`): o CLI fica calado esperando
 * a tarefa, e isso é trabalho, não travamento. Longo, mas finito — tarefa esquecida não segura o
 * motor pra sempre.
 */
const TURNO_BACKGROUND_TETO_MS = 2 * 60 * 60 * 1000;
const TURNO_CHECAGEM_MS = 15_000;

/**
 * Espera o turno fechar. Com motor que informa `ocupacao`, o teto é por INATIVIDADE (`ms` sem saída
 * nenhuma do motor, ou `TURNO_BACKGROUND_TETO_MS` com tarefa em background): antes era fixo desde o
 * início, e turno longo que seguia trabalhando — ou esperando um Monitor — morria com "engine
 * timeout" levando junto o processo que o modelo tinha deixado rodando.
 */
function waitTerminal(live: Live, ms = TURNO_TETO_MS): Promise<void> {
  if (live.lastTerminal) return Promise.resolve();
  const inicio = Date.now();
  return new Promise<void>((resolve, reject) => {
    const acorda = (): void => {
      clearInterval(timer);
      resolve();
    };
    const estourou = (): boolean => {
      const oc = live.engine.ocupacao?.();
      if (!oc) return Date.now() - inicio >= ms;
      const teto = oc.tarefasEmBackground > 0 ? Math.max(ms, TURNO_BACKGROUND_TETO_MS) : ms;
      return Date.now() - Math.max(inicio, oc.ultimaAtividade) >= teto;
    };
    const timer = setInterval(() => {
      if (!estourou()) return;
      clearInterval(timer);
      live.terminalWaiters = live.terminalWaiters.filter((w) => w !== acorda);
      reject(new Error("engine timeout"));
    }, Math.min(ms, TURNO_CHECAGEM_MS));
    live.terminalWaiters.push(acorda);
  });
}

/**
 * Manda o turno e registra o que está em voo. `partial` = a conta anterior já tinha
 * começado a escrever, então o certo é pedir continuação em vez de repetir o pedido.
 */
async function sendTurn(live: Live, text: string, partial = false): Promise<void> {
  live.pendingTurn = { text, partial };
  if (!partial) live.textoDoTurno = "";
  live.lastTerminal = null;
  live.startedAt = Date.now();
  await live.engine.send(partial ? CONTINUE : text);
}

/**
 * `waitTerminal` estourou o teto de turno: o motor nunca fechou (fica vivo,
 * travado). Sem isso, a rejeição subia crua até o handler HTTP — virava um 400
 * tratado só no client que fez aquela chamada (outros pontos de entrada, como
 * `retomarTurnoPendente`, ficavam sem tratamento nenhum), nada era persistido
 * na thread (o erro sumia no primeiro reload) e o motor travado continuava em
 * `lives` — o próximo turno reusaria o mesmo processo empacado em vez de um
 * motor novo. Aborta, tira de `lives` e deixa rastro — igual ao "motor morreu".
 */
async function tratarMotorTravado(threadId: string, home: string, live: Live, message: string): Promise<void> {
  await live.engine.abort().catch(() => {});
  lives.delete(threadId);
  appendEvent({ ts: nowIso(), type: "error", threadId, message, profileId: live.profileId }, home);
  const suggestedProfileId = suggestFallback(live.profileId, home);
  const suggested = suggestedProfileId ? getProfile(suggestedProfileId, home) : undefined;
  emit(threadId, {
    type: "error",
    message,
    threadId,
    suggestedProfileId,
    chatOnly: suggested?.engine === "api",
  });
}

async function dispatch(threadId: string, home: string, live: Live, text: string): Promise<void> {
  await sendTurn(live, text);
  try {
    await waitTerminal(live);
  } catch (e) {
    await tratarMotorTravado(threadId, home, live, (e as Error).message || "engine timeout");
    return;
  }
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
    try {
      await waitTerminal(again);
    } catch (e) {
      await tratarMotorTravado(threadId, home, again, (e as Error).message || "engine timeout");
      return;
    }
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
  const resume = Boolean(live && falouNoTurno(live)) || Boolean(pending?.partial);
  if (live) {
    if (live.assistantBuf) {
      appendEvent({ ts: nowIso(), type: "assistant", threadId, text: live.assistantBuf }, home);
      live.assistantBuf = "";
    }
    await live.engine.abort();
    lives.delete(threadId);
  }
  apagarSessaoClaude(threadId, home);
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
  apagarSessaoClaude(threadId, home);
  await removeThread(threadId, home);
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
    apagarSessaoClaude(threadId, home);
    appendEvent({ ts: nowIso(), type: "cleared", threadId }, home);
  });
}

async function withLocked(threadId: string, fn: () => Promise<void>): Promise<void> {
  const { withThreadLock } = await import("./lock.ts");
  await withThreadLock(threadId, fn);
}
