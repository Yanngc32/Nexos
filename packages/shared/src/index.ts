export type EngineKind = "claude" | "codex" | "api" | "stub";
export type ProfileStatus = "unauthenticated" | "ready";
export type SwitchReason = "user" | "quota";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
/** Modos de permissão do CLI do Claude (`--permission-mode`). */
export type PermissionMode = "auto" | "manual" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: PermissionMode[] = ["auto", "manual", "acceptEdits", "plan", "bypassPermissions"];
/** Aliases que o CLI aceita; nome cheio de modelo também vale. */
export const MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"];
/** Sem metacaractere: no Windows o motor é spawnado via cmd.exe. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Padrão de ferramenta liberada. Sem metacaractere de shell: o valor vira argv
 * do CLI e no Windows o motor nasce via cmd.exe.
 */
export const TOOL_PATTERN_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}(?:\([^()<>|&;`$"']{1,80}\))?$/;

export type ApiProvider = "anthropic" | "openai" | "gemini";
/**
 * O que fazer quando a quota da conta ativa acaba:
 * `auto` troca sozinho pela próxima do fallback, `manual` pergunta antes,
 * `denied` nem troca nem pergunta.
 */
export type SwitchMode = "auto" | "manual" | "denied";
export const SWITCH_MODES: SwitchMode[] = ["auto", "manual", "denied"];

/** Imagem colada ou arrastada no chat. Vive no home do nexo, nunca na pasta do projeto. */
export type Attachment = {
  /** Nome do arquivo no disco; identidade dentro da thread. */
  file: string;
  /** Rótulo pra UI: nome original quando existe, senão um genérico. */
  name: string;
  mime: string;
  bytes: number;
  /** Caminho absoluto: é por ele que o motor de CLI abre a imagem. */
  path: string;
};

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACH_MAX_PER_MESSAGE = 6;

export type Profile = {
  id: string;
  engine: EngineKind;
  createdAt: string;
  status: ProfileStatus;
  /** Quando o motor recebeu recusa de credencial. Só sai com credencial mais nova que isso. */
  authFailedAt?: string;
  /** Alias ou nome cheio do modelo; vazio = padrão do CLI. */
  model?: string;
  /** Esforço de raciocínio do CLI; vazio = padrão do CLI. */
  effort?: EffortLevel;
  /** Modo de permissão do CLI; vazio = padrão do CLI. */
  permissionMode?: PermissionMode;
  /**
   * Ferramentas liberadas sem perguntar, no formato do CLI (`Bash(git *)`, `Edit`).
   * Existe porque o motor roda em --print: não há como responder pedido de
   * permissão, então tudo que precisaria de aprovação é negado. Isso libera o
   * necessário sem desligar a permissão geral (bypassPermissions).
   */
  allowedTools?: string[];
  api?: { provider: ApiProvider; model: string };
};

/**
 * Agente personalizado: um preset com conta, ajustes de motor e instruções
 * próprias. A conversa guarda só o `id`; tudo mais é lido na hora de subir o
 * motor, então editar o agente vale para as conversas que já existem.
 */
export type AgentDef = {
  id: string;
  name: string;
  description?: string;
  /** Conta usada ao abrir conversa com este agente. */
  profileId: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** Vai no topo do context pack — é o "system prompt" do agente. */
  instructions?: string;
  /** Cor do cartão na UI. */
  color?: string;
  createdAt: string;
  updatedAt: string;
};

/** Mesma forma do id de perfil: minúsculo, sem espaço, seguro em nome de arquivo. */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const AGENT_NAME_MAX = 60;
export const AGENT_DESC_MAX = 200;
/** Teto das instruções: elas ocupam janela de contexto em todo turno. */
export const AGENT_INSTRUCTIONS_MAX = 8000;
export const AGENTS_MAX = 100;

/** O que um agente sobrepõe no motor da conta. */
export type EngineOverrides = {
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
};

/** Serviço local declarado no `nexo.json` do projeto. */
export type ServiceDef = {
  id: string;
  name?: string;
  cmd: string;
  /** Relativo à raiz do projeto; não pode escapar dela. */
  cwd?: string;
  /** O que a sonda testa e o que o botão de preview abre. Sem url = só status de processo. */
  url?: string;
  autostart?: boolean;
  env?: Record<string, string>;
};

export type ProcState = "off" | "running" | "exited";
export type PortState = "unknown" | "up" | "down";

export type ServiceStatus = {
  id: string;
  name: string;
  cmd: string;
  cwd: string;
  url?: string;
  autostart: boolean;
  proc: ProcState;
  /** Código de saída do último fim; só quando `proc` é "exited". */
  exitCode?: number;
  port: PortState;
  /** Porta extraída da url, pra UI mostrar sem reparsear. */
  portNumber?: number;
  pid?: number;
  startedAt?: string;
};

/** Resposta de `/v1/services`: o arquivo pode estar inválido e aí não há serviço nenhum. */
export type ServicesReport = {
  projectPath: string;
  trusted: boolean;
  /** Erro de parse/validação do nexo.json, quando houver. */
  error?: string;
  services: ServiceStatus[];
};

export type ProbeResult = { ok: boolean; status?: number; error?: string };

export type NexoConfig = {
  port: number;
  fallbackOrder: string[];
  /** Como tratar a troca de conta quando a quota acaba. */
  switchMode: SwitchMode;
  pack: { keepLastMessages: number; prefixCharBudget: number };
  accent: string;
  /**
   * Pastas abertas no app. Fica aqui, e não no localStorage, porque o
   * localStorage vive no userData do Electron — que muda conforme o app é
   * lançado e levava a lista embora.
   */
  repos: string[];
  /**
   * Pastas que o usuário tirou da lista. Precisa ser explícito porque
   * `/v1/projects` também deduz pasta das conversas gravadas: sem essa lista,
   * remover só do `repos` era desfeito no próximo poll.
   */
  hiddenRepos: string[];
  lastProject: string;
  lastThread: string;
  /**
   * Projetos onde o `autostart` do nexo.json é honrado. O arquivo vive no
   * repositório e diz qual comando rodar: sem essa lista, abrir projeto de
   * terceiro executaria comando arbitrário na máquina.
   */
  trustedProjects: string[];
};

export const DEFAULT_CONFIG: NexoConfig = {
  port: 7432,
  fallbackOrder: [],
  switchMode: "manual",
  pack: { keepLastMessages: 20, prefixCharBudget: 2000 },
  accent: "#4d9cd6",
  repos: [],
  hiddenRepos: [],
  lastProject: "",
  lastThread: "",
  trustedProjects: [],
};

export type ThreadEvent =
  | {
      ts: string;
      type: "thread_meta";
      threadId: string;
      projectPath: string;
      title?: string;
      profileId: string;
      /** Agente personalizado que rege a conversa; vazio = conta pura. */
      agentId?: string;
    }
  | { ts: string; type: "user"; threadId: string; text: string; attachments?: Attachment[] }
  | { ts: string; type: "assistant"; threadId: string; text: string }
  | { ts: string; type: "tool"; threadId: string; name: string; summary: string }
  | {
      ts: string;
      type: "switched";
      threadId: string;
      fromProfileId: string;
      toProfileId: string;
      reason: SwitchReason;
      resume?: boolean;
    }
  | {
      ts: string;
      type: "context_trimmed";
      threadId: string;
      keptMessages: number;
      droppedMessages: number;
    }
  /** Marca de "/clear": o pack ignora tudo antes disso, mas o JSONL guarda pra sempre. */
  | { ts: string; type: "cleared"; threadId: string }
  | { ts: string; type: "error"; threadId: string; message: string; profileId: string }
  | ({ ts: string; type: "usage"; threadId: string; model?: string } & TokenUsage);

/** Painel de conta: só metadado, nunca token. */
export type AccountInfo = {
  id: string;
  engine: EngineKind;
  status: ProfileStatus;
  credential: "live" | "dead" | "none";
  configDir?: string;
  email?: string;
  fullName?: string;
  organization?: string;
  seatTier?: string;
  subscription?: string;
  rateLimitTier?: string;
  scopes?: string[];
  expiresAt?: string;
  refreshExpiresAt?: string;
  authFailedAt?: string;
  provider?: ApiProvider;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** O que o próprio CLI responde em `auth status --json` (só quando pedido). */
  cli?: {
    loggedIn: boolean;
    authMethod?: string;
    email?: string;
    orgName?: string;
    subscriptionType?: string;
  };
};

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  thinking?: number;
  costUsd?: number;
  /** input + cache lido + cache criado do último request: o que ocupou a janela. */
  contextTokens: number;
};

export type UsageWindow = { utilization: number; resetsAt: number };

export type LimitsInfo = {
  status?: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
};

export type SessionInfo = {
  sessionId?: string;
  model?: string;
  /** Janela do modelo em tokens: o CLI marca 1M com o sufixo [1m] no nome. */
  contextWindow: number;
  version?: string;
};

export type EngineEvent =
  | { type: "text"; text: string }
  /** O CLI do Claude não expõe o texto do raciocínio: manda só progresso em tokens. */
  | { type: "thinking"; text?: string; tokens?: number }
  | { type: "tool"; name: string; summary: string }
  /** Contexto do ÚLTIMO request individual (não somado): o que ocupa a janela agora. */
  | { type: "context"; contextTokens: number }
  | { type: "done" }
  | { type: "quota"; detail?: string }
  | ({ type: "usage" } & TokenUsage)
  | ({ type: "limits" } & LimitsInfo)
  | ({ type: "session" } & SessionInfo)
  | { type: "auth"; detail?: string }
  | { type: "error"; message: string };

export type StartOpts = {
  threadId: string;
  projectPath: string;
  profileId: string;
  contextPack: string;
  agentId?: string;
};

/* ---------- times de agentes ---------- */

/**
 * Um membro do time: qual agente e o que ele faz aqui. O papel entra no pedido
 * que o membro recebe, então o mesmo agente pode ocupar papéis diferentes em
 * times diferentes sem virar dois agentes.
 */
export type TeamMember = {
  agentId: string;
  papel?: string;
};

/**
 * Como o time trabalha.
 *
 * `pipeline`: um membro por vez, a saída de um é a entrada do próximo.
 * `fanin`: todos menos o último rodam AO MESMO TEMPO, e o último recebe a saída
 * de todos pra juntar. Quem agrega é o último da lista — a ordem continua sendo
 * a semântica, como no pipeline.
 *
 * As duas o daemon executa de fora, sem exigir nada do motor. Supervisor (um
 * membro decidindo quem age no meio do turno) precisaria de canal de volta e
 * fica pra quando existir.
 *
 * ATENÇÃO no `fanin`: os membros paralelos rodam no MESMO diretório do projeto,
 * ao mesmo tempo. Enquanto não houver isolamento por worktree, um time de
 * fan-in com membros que ESCREVEM arquivo vai ter um sobrescrevendo o outro.
 * Para leitura — analisar, revisar, pesquisar — é seguro, e é pra isso que ele
 * serve hoje.
 */
export type TeamTopology = "pipeline" | "fanin";
export const TEAM_TOPOLOGIES: TeamTopology[] = ["pipeline", "fanin"];

export type TeamDef = {
  id: string;
  name: string;
  description?: string;
  topology: TeamTopology;
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
};

export const TEAM_ID_RE = AGENT_ID_RE;
export const TEAM_NAME_MAX = 60;
export const TEAM_DESC_MAX = 200;
export const TEAM_PAPEL_MAX = 200;
export const TEAM_MEMBERS_MAX = 8;
export const TEAMS_MAX = 50;

/** Objetivo do run: o pedido que entra na primeira etapa. */
export const RUN_GOAL_MAX = 8000;

export type RunStepStatus = "pending" | "running" | "done" | "error" | "skipped";

export type RunStep = {
  index: number;
  agentId: string;
  papel?: string;
  status: RunStepStatus;
  /** Conversa que este passo usou; fica no histórico pra auditoria. */
  threadId?: string;
  startedAt?: string;
  endedAt?: string;
  /** Arquivo com a saída completa deste passo, dentro do run. */
  artifact?: string;
  outputChars?: number;
  costUsd?: number;
  tokens?: number;
  error?: string;
};

export type RunStatus = "running" | "done" | "error" | "aborted";

/**
 * Teto do run. Existe porque um time multiplica o gasto: cinco membros é cinco
 * vezes o custo de um turno, e um erro de instrução que faz o time girar em
 * falso queima a conta sem ninguém ver.
 */
export type RunBudget = {
  maxUsd?: number;
  maxSteps?: number;
};

export type Run = {
  id: string;
  teamId: string;
  projectPath: string;
  goal: string;
  status: RunStatus;
  steps: RunStep[];
  budget?: RunBudget;
  createdAt: string;
  endedAt?: string;
  error?: string;
};

export type RunEvent =
  | { type: "run_start"; runId: string; teamId: string }
  | { type: "step_start"; runId: string; index: number; agentId: string; threadId: string }
  | { type: "step_done"; runId: string; index: number; step: RunStep }
  | { type: "run_end"; runId: string; status: RunStatus; error?: string };

export type PackConfig = NexoConfig["pack"];
