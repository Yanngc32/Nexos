export type EngineKind = "claude" | "codex" | "api" | "stub";
export type ProfileStatus = "unauthenticated" | "ready";
export type SwitchReason = "user" | "quota";
/**
 * União dos níveis de esforço dos dois motores de CLI. `low`…`max` são do
 * Claude; `ultra` só existe em alguns modelos do Codex (visto em
 * `models_cache.json` real, modelo `gpt-5.6-terra`) — cada motor valida contra
 * o próprio subconjunto, não contra `EFFORT_LEVELS` inteiro.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
/** Subconjunto que o `claude --effort` aceita. */
export const CLAUDE_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
/** Modos de permissão do CLI do Claude (`--permission-mode`). */
export type PermissionMode = "auto" | "manual" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: PermissionMode[] = ["auto", "manual", "acceptEdits", "plan", "bypassPermissions"];

/**
 * Política de sandbox do `codex exec` (`-s/--sandbox`). Não é o mesmo conceito
 * do `PermissionMode` do Claude — lá é fluxo de aprovação, aqui é o que o
 * processo filho tem permissão de tocar — por isso campo próprio no `Profile`
 * em vez de reaproveitar `permissionMode`.
 */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export const CODEX_SANDBOX_MODES: CodexSandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];

/**
 * Um modelo do catálogo real do Codex (lido de `models_cache.json`, que o
 * próprio CLI grava depois do login — nunca uma lista chutada aqui). `efforts`
 * é o que ESSE modelo aceita — varia por modelo, por isso vem por modelo e não
 * de uma lista fixa global.
 */
export type CodexModelInfo = {
  slug: string;
  displayName: string;
  description?: string;
  efforts: EffortLevel[];
  defaultEffort?: EffortLevel;
};

/** negado: nexo_delegar nem existe. questionar: pergunta antes via nexo_perguntar. liberado: roda direto. */
export type DelegacaoModo = "negado" | "questionar" | "liberado";
export const DELEGACAO_MODOS: DelegacaoModo[] = ["negado", "questionar", "liberado"];
/**
 * negado: nexo_navegador_* nem existe. questionar: abrir/clicar/digitar perguntam antes via
 * nexo_perguntar (ler/screenshot não, são só leitura). liberado: tudo roda direto.
 */
export type NavegadorModo = "negado" | "questionar" | "liberado";
export const NAVEGADOR_MODOS: NavegadorModo[] = ["negado", "questionar", "liberado"];
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
  /** Nome de exibição opcional — o `id` continua sendo a chave de verdade (pasta, seleção, etc.). */
  nickname?: string;
  /** Quando o motor recebeu recusa de credencial. Só sai com credencial mais nova que isso. */
  authFailedAt?: string;
  /** Alias ou nome cheio do modelo; vazio = padrão do CLI. */
  model?: string;
  /** Esforço de raciocínio do CLI; vazio = padrão do CLI. */
  effort?: EffortLevel;
  /** Modo de permissão do CLI do Claude; vazio = padrão do CLI. */
  permissionMode?: PermissionMode;
  /** Política de sandbox do `codex exec`; vazio = padrão do CLI. Só vale pra engine codex. */
  sandboxMode?: CodexSandboxMode;
  /**
   * Ferramentas liberadas sem perguntar, no formato do CLI (`Bash(git *)`, `Edit`).
   * Existe porque o motor roda em --print: não há como responder pedido de
   * permissão, então tudo que precisaria de aprovação é negado. Isso libera o
   * necessário sem desligar a permissão geral (bypassPermissions).
   */
  allowedTools?: string[];
  /** Padrão "negado": nexo_delegar não entra no pack da conversa dessa conta. */
  delegacaoModo?: DelegacaoModo;
  /** Padrão "negado": nexo_navegador_* não entra no pack da conversa dessa conta. */
  navegadorModo?: NavegadorModo;
  api?: { provider: ApiProvider; model: string };
  /**
   * Janela efetiva por modelo, aprendida do stream (`effective_window`).
   *
   * Existe porque a janela só se sabe DEPOIS de um turno, e sem gravá-la todo
   * processo novo do daemon voltava a deduzi-la do nome do modelo — palpite que
   * subestimava em 5× (200k contra 980k reais). O efeito era o teto do context
   * pack começar pequeno e a compactação disparar antes da hora, na primeira
   * conversa depois de cada subida.
   *
   * Por modelo, e não por conta: a janela é do modelo que rodou, então trocar o
   * modelo do perfil invalida o número sozinho, sem precisar de limpeza.
   */
  contextWindows?: Record<string, number>;
};

/**
 * Chave do `contextWindows`. NÃO é o `MODEL_RE`: o nome que o CLI carimba no
 * `usage` pode trazer o sufixo de janela (`[1m]`), e o `MODEL_RE` proíbe
 * colchete porque lá o valor vira argv. Aqui é só chave de JSON — o que se quer
 * é limitar tamanho e alfabeto, não passar por shell.
 */
export const WINDOW_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/;

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
  sandboxMode?: CodexSandboxMode;
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
  sandboxMode?: CodexSandboxMode;
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
  /**
   * Em que interface o daemon escuta. `127.0.0.1` é o padrão e a escolha certa
   * pra quase todo mundo: nada de fora da máquina alcança.
   *
   * Existe porque acessar do celular exige que o daemon esteja alcançável, e o
   * loopback nunca está — nem por túnel, porque a interface do Tailscale ou do
   * WireGuard tem IP próprio (`100.x.y.z`), não `127.0.0.1`. Aponte pro IP DO
   * TÚNEL: aí quem alcança é só quem está no seu tailnet.
   *
   * `0.0.0.0` publica na rede inteira. O token é a única barreira e não há TLS
   * — em Wi-Fi compartilhado isso é entregar um shell com um modelo na frente.
   */
  host: string;
  fallbackOrder: string[];
  /** Como tratar a troca de conta quando a quota acaba. */
  switchMode: SwitchMode;
  pack: {
    keepLastMessages: number;
    prefixCharBudget: number;
    /**
     * Resumir o histórico antigo quando ele encosta no teto, em vez de cortar.
     *
     * Ligado por padrão porque a alternativa é o corte de sempre, que guarda os
     * primeiros caracteres do que jogou fora e perde o meio da conversa. Existe
     * o interruptor porque resumir GASTA um turno da sua conta, e há quem
     * prefira o corte a pagar por isso.
     */
    compactar: boolean;
  };
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
  /**
   * Raiz de `~/.nexo/memoria/<hash-do-projeto>/MEMORIA.md`. Vazio = default
   * (dentro do próprio `NEXO_HOME`). Existe pra apontar pra uma pasta já
   * sincronizada entre máquinas (Drive etc.) — é assim que a memória de
   * projeto atravessa PC diferente, sem o Nexo implementar sync nenhum.
   */
  memoriaDir: string;
  /**
   * Raiz de `~/.nexo/grafo/<hash-do-projeto>/` — cache em disco do repo map (índice de
   * arquivos + resumos, ver `repo-map-indice.ts`). Vazio = default (dentro do `NEXO_HOME`).
   * Separado de `memoriaDir` de propósito: o usuário pode querer sincronizar o repo map
   * (regenerável, maior) numa pasta diferente da memória (curada, pequena, mais sensível).
   * Nome mantido do tempo do `graphify` — trocar quebraria config de quem já usa.
   */
  graphDir: string;
  /**
   * Raiz de `~/.nexo/tarefas/<hash-do-projeto>/` — quadro (colunas/marcos/etiquetas) e cada
   * tarefa em um `.md` próprio (ver `tarefas.ts`). Vazio = default (dentro do `NEXO_HOME`).
   * Mesma ideia de `memoriaDir`: apontar pra uma pasta já sincronizada (Drive, OneDrive etc.)
   * é como o quadro de tarefas atravessa de um PC pro outro — não tem sync embutido.
   */
  tarefasDir: string;
  /**
   * Teto de tokens do índice (Camada 1 do repo map) injetado no prompt — ver
   * `repo-map-indice.ts`. Ausente = usa a constante padrão (1200).
   */
  repoMapTetoTokens?: number;
  /**
   * Módulos externos opcionais, cada um ligado/desligado à parte. `rtk` é um proxy de CLI (hook
   * `PreToolUse`) que filtra saída de comando antes dela entrar no contexto; `caveman` é uma skill
   * de comunicação comprimida — nenhum dos dois é instalado nem sincronizado se estiver desligado
   * (ver `modules.ts`). `repoMapResumos` liga um agente + uma regra global de Nexo Hook
   * (`git.post-commit`) que gera/mantém os resumos por IA do repo map sozinho, sem botão manual
   * (ver `repo-map-auto.ts`) — precisa de `repoMapProfileId` (a conta que roda esse agente). O
   * índice em si (Camada 1) não depende deste módulo: roda sempre, sem LLM.
   */
  modulos: {
    rtk: boolean;
    caveman: boolean;
    cavemanNivel: CavemanNivel;
    repoMapResumos: boolean;
    repoMapProfileId: string;
  };
};

export const CAVEMAN_NIVEIS = ["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"] as const;
export type CavemanNivel = (typeof CAVEMAN_NIVEIS)[number];

export const DEFAULT_CONFIG: NexoConfig = {
  port: 7432,
  host: "127.0.0.1",
  fallbackOrder: [],
  switchMode: "manual",
  pack: { keepLastMessages: 20, prefixCharBudget: 2000, compactar: true },
  accent: "#4d9cd6",
  repos: [],
  hiddenRepos: [],
  lastProject: "",
  lastThread: "",
  trustedProjects: [],
  memoriaDir: "",
  graphDir: "",
  tarefasDir: "",
  modulos: { rtk: false, caveman: false, cavemanNivel: "full", repoMapResumos: false, repoMapProfileId: "" },
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
      /**
       * Run de time que criou esta conversa, e qual passo dele. Fica no meta
       * porque é verdade sobre a conversa, não sobre o run: a lista de threads
       * precisa saber disso sem varrer todos os runs do disco.
       */
      runId?: string;
      runStep?: number;
      /** Rótulo do run (time + objetivo), pra lista agrupar sem consultar o run. */
      runTitle?: string;
      /** Config MCP desta conversa; ver `StartOpts.mcpConfig`. */
      mcpConfig?: string;
      /** Ferramentas que esse MCP oferece; ver `StartOpts.mcpTools`. */
      mcpTools?: string[];
    }
  | { ts: string; type: "user"; threadId: string; text: string; attachments?: Attachment[] }
  | { ts: string; type: "assistant"; threadId: string; text: string }
  | {
      ts: string;
      type: "tool";
      threadId: string;
      name: string;
      summary: string;
      /** Id do bloco `tool_use` — casa com o `tool_result` que chega depois, pro chat anexar no lugar certo. */
      id?: string;
      /** Argumentos completos da chamada — a `summary` é só o resumo pra UI fechada; isto é pra expandir. */
      input?: unknown;
    }
  /** Resultado de UMA chamada — sempre depois do `tool` de mesmo `id`, nunca sozinho. */
  | { ts: string; type: "tool_result"; threadId: string; id: string; result: string; isError?: boolean }
  /** `nexo_perguntar` pausou o turno pra perguntar algo — ver perguntas.ts. */
  | {
      ts: string;
      type: "pergunta";
      threadId: string;
      id: string;
      texto: string;
      opcoes?: string[];
      /** Marca quantas opções fizerem sentido antes de confirmar; só com `opcoes`. */
      multiSelect?: boolean;
    }
  /** Resposta que destravou a `pergunta` de mesmo `id` — sempre depois dela, nunca sozinha. */
  | { ts: string; type: "pergunta_resposta"; threadId: string; id: string; resposta: string }
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
  | {
      /**
       * O histórico antigo virou resumo.
       *
       * Aditivo, como o `cleared`: o JSONL guarda tudo pra sempre, e isto só
       * diz ao packer que os primeiros `cobertos` eventos do arquivo estão
       * representados por `text` e não precisam mais ir ao motor.
       *
       * `cobertos` é ÍNDICE no arquivo, não timestamp: o JSONL só cresce no
       * fim, então a posição é estável pra sempre, enquanto dois eventos podem
       * dividir o mesmo milissegundo.
       */
      ts: string;
      type: "compacted";
      threadId: string;
      text: string;
      cobertos: number;
      tokensAntes: number;
      tokensDepois: number;
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
  sandboxMode?: CodexSandboxMode;
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
  | { type: "tool"; name: string; summary: string; id?: string; input?: unknown }
  | { type: "tool_result"; id: string; result: string; isError?: boolean }
  /** Contexto do ÚLTIMO request individual (não somado): o que ocupa a janela agora. */
  | { type: "context"; contextTokens: number }
  /**
   * Janela que o motor DISSE que a sessão tem, não a adivinhada pelo nome do
   * modelo. Vem antes do `session` no stream do CLI, então é evento próprio em
   * vez de campo dele — assim a ordem de chegada não decide qual valor vale.
   */
  | { type: "window"; contextWindow: number }
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
  /**
   * Arquivo de config MCP pro motor de CLI (`--mcp-config`). Dois usos: o
   * supervisor em canal `mcp`, que alcança os membros do time sem sair do
   * turno, e a conversa normal, que ganha as ferramentas de autoria.
   */
  mcpConfig?: string;
  /**
   * Nomes das ferramentas desse servidor MCP, pro `--allowed-tools`.
   *
   * Vem JUNTO do `mcpConfig` em vez de ser deduzido dele porque os dois
   * conjuntos que existem — supervisor e autoria — moram no mesmo servidor, em
   * caminhos diferentes. Liberar a lista errada faz a chamada ser negada em
   * silêncio: em `--print` não há canal pra aprovar permissão, e o modelo
   * conclui que a ferramenta não existe.
   */
  mcpTools?: string[];
  /**
   * Endereço e token do MCP pro motor que NÃO recebe arquivo de config.
   *
   * O `codex` configura MCP por chave de config (`-c mcp_servers.<nome>=…`), e
   * ali o token não vai junto: ele aponta uma VARIÁVEL DE AMBIENTE
   * (`bearer_token_env_var`) que o daemon põe no ambiente do filho. Sai melhor
   * que o arquivo do `claude` na mesma preocupação — o segredo não passa por
   * argv nem por arquivo, só pelo ambiente do processo.
   */
  mcpHttp?: { url: string; token: string };
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
 * `supervisor`: o PRIMEIRO da lista não trabalha — ele decide, a cada rodada,
 * qual dos outros chamar e com que pedido, até dizer que acabou. A ordem dos
 * demais não importa aqui: quem escolhe é ele.
 *
 * As três o daemon executa de fora, sem exigir nada do motor: o supervisor
 * responde a ordem em texto e o daemon é quem a executa, no turno seguinte da
 * mesma conversa. Custa um turno por decisão e roda em qualquer motor.
 *
 * No `fanin` os paralelos ganham árvore de trabalho própria (`git worktree`)
 * quando o projeto é repositório git; sem git eles dividem a mesma pasta e um
 * sobrescreve o outro. No `supervisor` isso não aparece: ele chama um membro de
 * cada vez, e todos trabalham na pasta do projeto.
 */
export type TeamTopology = "pipeline" | "fanin" | "supervisor";
export const TEAM_TOPOLOGIES: TeamTopology[] = ["pipeline", "fanin", "supervisor"];

/**
 * Como o supervisor manda no time.
 *
 * `turno`: ele responde a ordem em texto, o turno fecha, o daemon executa e
 * volta no turno seguinte. Um turno por decisão, e roda em QUALQUER motor.
 * `mcp`: ele chama uma ferramenta e recebe a resposta sem sair do turno — o run
 * inteiro cabe num turno só. Mais barato, mas só em motor que fala MCP
 * (`claude`); nos outros o daemon cai de volta pro `turno` em vez de recusar o
 * run, e registra isso em `canalOff`.
 */
export type TeamCanal = "turno" | "mcp";
export const TEAM_CANAIS: TeamCanal[] = ["turno", "mcp"];

export type TeamDef = {
  id: string;
  name: string;
  description?: string;
  topology: TeamTopology;
  /** Só vale no `supervisor`; nas outras topologias não há decisão pra tomar. */
  canal?: TeamCanal;
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
  /**
   * Time de 1 membro criado automaticamente — `"mencao"` por uma `@menção` de
   * agente avulso no composer (`upsertTimeDeMencao`), `"hook"` por um Nexo Hook
   * (`upsertTimeDeHook`, ver hooks.ts). Não aparece na tela de Times — existe só
   * pra `runs.ts` ter um `teamId` de verdade pra apontar.
   */
  origem?: "mencao" | "hook";
};

export const TEAM_ID_RE = AGENT_ID_RE;
export const TEAM_NAME_MAX = 60;
export const TEAM_DESC_MAX = 200;
export const TEAM_PAPEL_MAX = 200;
export const TEAM_MEMBERS_MAX = 8;
export const TEAMS_MAX = 50;

/**
 * Pareamento do celular: o desktop mostra um código curto, o celular manda, e o
 * daemon troca o código pelo token.
 *
 * É código curto e não o token porque ninguém digita 48 caracteres hex no
 * celular. O QR mostra o mesmo código, nunca o token — assim o token não
 * aparece em tela pra ser fotografado.
 *
 * **Seis caracteres de base32, não seis dígitos.** Pelo mesmo trabalho de
 * digitar, o espaço vai de 10^6 pra 32^6 ≈ 1,07×10^9. Com o teto de 5 erros,
 * são 5 chances em mais de um bilhão pra quem já consegue alcançar a porta — e
 * alcançar a porta já exige estar no túnel ou na LAN. O comprimento é o que
 * limita a paciência de quem digita; a variedade é de graça.
 *
 * O alfabeto é o do Crockford: **sem I, L, O e U**. Os três primeiros porque se
 * confundem com 1, 1 e 0 numa tela lida de longe, e a normalização os aceita de
 * volta; o U porque tirá-lo evita que o sorteio escreva palavra ofensiva.
 *
 * As travas continuam sendo o que sustenta o desenho: vale 2 minutos, serve UMA
 * vez, 5 tentativas erradas queimam o código, e só existe um código vivo.
 */
/**
 * Endereço pronto pra entrar numa URL: IPv6 vai entre colchetes.
 *
 * Sem eles, `http://fd7a:115c::1:7432/` faz o navegador ler `fd7a` como host e
 * `115c` como porta — e endereço de Tailscale é IPv6. O renderer do desktop tem
 * a mesma regra em `apps/desktop/url.js`, porque é JS de navegador e não carrega
 * este pacote.
 */
export function hostNaUrl(host: string): string {
  const h = host.trim();
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
}

export const PAIR_CODE_LEN = 6;
export const PAIR_ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_TTL_MS = 2 * 60 * 1000;
export const PAIR_MAX_ERROS = 5;

/**
 * Deixa a tentativa comparável: maiúscula, sem separador, e com as confusões
 * óbvias desfeitas (I e L viram 1, O vira 0).
 *
 * Normalizar é obrigação de quem valida, não favor: o cliente pode ser um curl.
 * O app de celular repete esta regra em `apps/mobile/pareamento.js` só pra que o
 * campo mostre o que vai ser enviado — quem decide é aqui.
 *
 * **Não corta no tamanho.** Cortar faria `ABC123XYZ` valer por `ABC123`, e
 * tentativa comprida é tentativa errada, não tentativa com sobra. Limitar o
 * tamanho é trabalho do campo que a pessoa digita, não de quem confere.
 */
export function normalizarCodigo(bruto: unknown): string {
  return String(bruto ?? "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .split("")
    .filter((c) => PAIR_ALFABETO.includes(c))
    .join("");
}

/**
 * Até quando o daemon espera um turno de motor fechar. Passado isso, motor que
 * não responde é defeito, e travar a conversa pra sempre seria pior.
 *
 * Mora aqui, e não no `session.ts`, porque quem chama o daemon de fora precisa
 * esperar MAIS que ele (ver `MCP_TOOL_TIMEOUT_MS`) — e `mcp.ts` não pode
 * importar `session.ts` sem fechar ciclo, já que o motor de CLI importa o mcp.
 */
export const TURNO_TETO_MS = 15 * 60 * 1000;

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
  /** Árvore isolada onde este passo trabalhou; vazio = trabalhou na pasta do projeto. */
  worktree?: string;
  /** Branch com o que ele fez. Fica depois do run: é por ele que se acha o trabalho. */
  branch?: string;
  outputChars?: number;
  costUsd?: number;
  tokens?: number;
  error?: string;
  /**
   * Passo que DECIDE em vez de trabalhar (topologia `supervisor`). Fica aberto o
   * run inteiro, numa conversa só, e o custo dele é a soma das decisões — por
   * isso a tela precisa saber que ele não é um passo comum.
   */
  supervisor?: true;
  /** Quantas decisões esse supervisor já tomou. */
  decisoes?: number;
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
  /**
   * Membros paralelos trabalharam em árvores separadas? Quando não, o motivo —
   * projeto sem git, sem commit — fica em `isolationOff`.
   */
  isolated?: boolean;
  isolationOff?: string;
  /**
   * Quantas vezes este run foi posto pra rodar. 1 = nunca foi retomado. Entra
   * no nome do branch dos paralelos, senão a retomada esbarraria no branch que
   * a tentativa anterior deixou.
   */
  tentativas?: number;
  /** Por que o supervisor não usou MCP, quando o time pediu. */
  canalOff?: string;
  /**
   * O que as tentativas anteriores já custaram. Os passos refeitos perdem o
   * `costUsd` deles (a conversa é outra), e sem isso o orçamento esqueceria o
   * gasto e uma retomada poderia custar tudo de novo sem estourar nada.
   */
  gastoAnterior?: number;
};

export type RunEvent =
  | { type: "run_start"; runId: string; teamId: string }
  /**
   * Passo que nasceu no meio do run. Só o `supervisor` produz isso: nas outras
   * topologias a lista de passos já sai pronta do `criarRun`, e a tela pode
   * confiar no índice. Vem antes do `step_start` do mesmo índice.
   */
  | { type: "step_add"; runId: string; step: RunStep }
  | { type: "step_start"; runId: string; index: number; agentId: string; threadId: string }
  | { type: "step_done"; runId: string; index: number; step: RunStep }
  | { type: "run_end"; runId: string; status: RunStatus; error?: string };

export type PackConfig = NexoConfig["pack"];
