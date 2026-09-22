import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { EngineEvent, EngineOverrides, Profile, StartOpts } from "@nexo/shared";
import type { EffortLevel, EsforcoEscolhido } from "@nexo/shared";
import {
  CODEX_SANDBOX_MODES,
  EFFORT_LEVELS,
  ESFORCO_AUTO,
  MODELO_AUTO,
  MODELO_AUTO_FALLBACK,
  MODEL_RE,
  PERMISSION_MODES,
  TOOL_PATTERN_RE,
} from "@nexo/shared";
import type { Engine, EngineHandler, EngineMcp } from "./types.ts";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentsDir, enginePidPath, globalSkillsDir } from "../home.ts";
import { killTree } from "../kill-tree.ts";
import { spawnCwd } from "../project-cwd.ts";
import { agentOverrides } from "../agents.ts";
import { loadConfig } from "../config.ts";
import { engineEnv, engineSpawnEnv, getProfile } from "../profiles.ts";
import { syncGlobalSkills } from "../skills.ts";
import { syncRtkHook } from "../modules.ts";
import { isNodeScript, spawnBin } from "../spawn-bin.ts";
import { ENV_TOKEN_MCP, flagsDeMcpCodex, MCP_TOOLS } from "../mcp.ts";
import { sessaoIdValido } from "../claude-session.ts";
import { parseCliLine } from "./parse-claude.ts";
import { parseCodexLine } from "./parse-codex.ts";

export { parseCliLine };

/** CLI perdeu a sessão que `--resume` apontava — vale um retry com o pack. */
const SESSAO_PERDIDA =
  /no conversation found|session.{0,80}(not found|unknown|expired|invalid)|could not (find|load) session/i;

/*
 * Era embrulho manual em `cmd.exe /d /s /c` pra bin que não é script — quebrava com
 * QUALQUER argv que tivesse `&` (a URL do MCP do codex sempre tem), porque o shim
 * `.cmd` do npm re-parseia a linha inteira e não tem escape que sobreviva aos dois
 * parses de cmd.exe ao mesmo tempo. `spawnBin` resolve o `.js` real do shim e chama
 * `node` nele direto — ver o comentário em spawn-bin.ts pro porquê medido.
 */
function spawnEngine(bin: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  return spawnBin(bin, args, opts) as ChildProcessWithoutNullStreams;
}

/**
 * "auto" no esforço é marca de escolha dinâmica, não nível — mesmo papel do
 * `MODELO_AUTO`. Se a escolha do turno não veio, vale o padrão do fallback em
 * vez de mandar `--effort auto` (que o CLI recusa).
 */
function esforcoEfetivo(effort: EsforcoEscolhido | undefined): EffortLevel | undefined {
  if (!effort) return undefined;
  return effort === ESFORCO_AUTO ? MODELO_AUTO_FALLBACK.effort : effort;
}

/**
 * Flags do `codex exec` pra modelo/esforço/sandbox — medidas contra `codex exec --help`
 * (codex-cli 0.154.0) e um `models_cache.json` real, não chutadas:
 *
 * - Modelo é `-m/--model <MODEL>`, string livre (o catálogo real tem slug tipo
 *   `gpt-5.6-terra`) — daí `MODEL_RE` só validar formato, não pertencimento a lista.
 * - Esforço não tem flag própria: é config key (`-c model_reasoning_effort=…`), e
 *   o valor de string precisa ir entre aspas — sem aspas o parser de TOML do
 *   `codex` rejeita.
 * - Não existe `--permission-mode`: o equivalente é `-s/--sandbox` (política do
 *   que o processo pode tocar), semântica bem diferente do fluxo de aprovação do
 *   Claude — por isso campo próprio (`sandboxMode`) em vez de reaproveitar
 *   `permissionMode`.
 * - `--allowed-tools` também não existe: no `codex exec` a permissão é toda do
 *   sandbox, não por ferramenta.
 */
function codexFlags(profile: Profile, over: EngineOverrides = {}, resumindo = false): string[] {
  const escolhido = over.model ?? profile.model;
  // Mesmo motivo do claude: "auto" é marca de escolha dinâmica, não nome de modelo.
  const usaFallbackAuto = escolhido === MODELO_AUTO;
  const model = usaFallbackAuto ? MODELO_AUTO_FALLBACK.model : escolhido;
  const effort = esforcoEfetivo(usaFallbackAuto ? (over.effort ?? MODELO_AUTO_FALLBACK.effort) : (over.effort ?? profile.effort));
  const sandbox = over.sandboxMode ?? profile.sandboxMode;
  const out: string[] = [];
  if (model && MODEL_RE.test(model)) out.push("-m", model);
  if (effort && EFFORT_LEVELS.includes(effort)) out.push("-c", `model_reasoning_effort="${effort}"`);
  /*
   * `-s` NÃO existe no `exec resume` — medido contra o codex-cli 0.155.1, que
   * responde `error: unexpected argument '-s' found` e nem chega a rodar. Sem
   * este desvio, todo turno retomado morreria no parser de argumentos. `-m` e
   * `-c` o resume aceita normalmente, então esses seguem.
   *
   * A política de sandbox da sessão retomada é a que ela já tinha: é sessão
   * continuada, não nova.
   */
  if (!resumindo && sandbox && CODEX_SANDBOX_MODES.includes(sandbox)) out.push("-s", sandbox);
  return out;
}

/**
 * Prefixo das ferramentas `nexo_windows_*` (controle de QUALQUER app do Windows,
 * ver `windows-control.ts`) — o único jeito de saber se algo é uma delas sem
 * importar a lista inteira aqui.
 */
const PREFIXO_WINDOWS_CONTROL = "mcp__nexo__nexo_windows_";

/**
 * `over` são os ajustes do agente personalizado: vencem os da conta quando existem.
 *
 * `home` é o único parâmetro que existe SÓ pra checar `windowsControlEnabled` —
 * é o gate mestre de `nexo_windows_*`, e este é o ÚNICO ponto onde `--allowed-tools`
 * de fato sai pro CLI. Filtra aqui, incondicionalmente, tanto o que veio de
 * `extraTools` (calculado por sessão) quanto o que o usuário escreveu à mão no
 * `allowedTools` do próprio perfil — nenhum dos dois pode religar sozinho o que
 * esta config desligou.
 */
function profileFlags(
  profile: Profile,
  home: string,
  over: EngineOverrides = {},
  extraTools: string[] = [],
  resumindo = false,
): string[] {
  if (profile.engine === "codex") return codexFlags(profile, over, resumindo);
  if (profile.engine !== "claude") return [];
  const escolhido = over.model ?? profile.model;
  const efetivo = escolhido ?? "";
  /*
   * "auto" não é modelo: é a marca de escolha dinâmica por complexidade. Quando
   * a escolha do turno não chegou (roteamento desligado, sem key, erro/timeout),
   * cai no fallback aqui — mandar `--model auto` pro CLI seria erro na cara.
   */
  const usaFallbackAuto = efetivo === MODELO_AUTO;
  const model = usaFallbackAuto ? MODELO_AUTO_FALLBACK.model : escolhido;
  const effort = esforcoEfetivo(usaFallbackAuto ? (over.effort ?? MODELO_AUTO_FALLBACK.effort) : (over.effort ?? profile.effort));
  const permissionMode = over.permissionMode ?? profile.permissionMode;
  const out: string[] = [];
  if (model && MODEL_RE.test(model)) out.push("--model", model);
  if (effort && EFFORT_LEVELS.includes(effort)) out.push("--effort", effort);
  if (permissionMode && PERMISSION_MODES.includes(permissionMode)) {
    out.push("--permission-mode", permissionMode);
  }
  /*
   * Em --print não existe canal pra responder pedido de permissão: tudo que
   * precisaria de aprovação (git push, gh, comando novo) é negado em silêncio.
   * Isso libera só o que o perfil declarou — bem mais estreito que desligar a
   * permissão inteira com bypassPermissions.
   */
  /*
   * UMA ocorrência de --allowed-tools, com tudo dentro. A opção é variádica no
   * CLI: repeti-la faria a segunda substituir a primeira, e as ferramentas do
   * MCP entrariam no lugar das que o perfil declarou (ou o contrário).
   */
  const allowed = [...(profile.allowedTools ?? []).filter((t) => TOOL_PATTERN_RE.test(t)), ...extraTools];
  const podeControlarWindows = loadConfig(home).windowsControlEnabled === true;
  const allowedFiltrado = podeControlarWindows ? allowed : allowed.filter((t) => !t.startsWith(PREFIXO_WINDOWS_CONTROL));
  if (allowedFiltrado.length) out.push("--allowed-tools", ...allowedFiltrado);
  return out;
}

type CliEngineOpts = {
  home: string;
  profileId: string;
  binEnv: "NEXO_CLAUDE_BIN" | "NEXO_CODEX_BIN";
  defaultBin: string;
  args: string[];
  /**
   * Tradutor do stream deste CLI. Passa como opção porque `claude` e `codex`
   * não têm nada em comum na saída — antes o `codex` era parseado com o parser
   * do Claude, o que ajudou a esconder que ele nunca rodou um turno.
   */
  parse: (linha: string) => EngineEvent[];
};

export class CliEngine implements Engine {
  private child?: ChildProcessWithoutNullStreams;
  private handler?: EngineHandler;
  private pack = "";
  private cwd = "";
  private extra: Record<string, string> = {};
  private spawnEnv: NodeJS.ProcessEnv = {};
  private bin = "";
  private readonly home: string;
  private readonly profileId: string;
  private readonly binEnv: CliEngineOpts["binEnv"];
  private readonly defaultBin: string;
  private readonly baseArgs: string[];
  private readonly parse: (linha: string) => EngineEvent[];
  private args: string[];
  private threadId = "";
  private agentId?: string;
  private mcpConfig?: string;
  private mcpTools?: string[];
  private mcpHttp?: { url: string; token: string };
  private aborted = false;
  private finished = false;
  /** Sessão do CLI `claude` pra `--resume`. Vazio = pack no stdin, como antes. */
  private resumeSessionId?: string;
  /** Override só deste turno (modelo escolhido por complexidade). Ver `updateOverrides`. */
  private overridesDoTurno: EngineOverrides = {};
  lastEnv: Record<string, string | undefined> = {};
  lastCwd?: string;
  lastArgs: string[] = [];
  /** O que o binário REAL receberia no stdin (o fixture node só vê `text`). */
  lastPayload = "";

  constructor(opts: CliEngineOpts) {
    this.home = opts.home;
    this.profileId = opts.profileId;
    this.binEnv = opts.binEnv;
    this.defaultBin = opts.defaultBin;
    this.baseArgs = opts.args;
    this.args = opts.args;
    this.parse = opts.parse;
  }

  async start(opts: StartOpts, onEvent: EngineHandler): Promise<void> {
    const profile = getProfile(this.profileId, this.home);
    if (!profile) throw new Error("perfil não existe");
    this.threadId = opts.threadId;
    this.agentId = opts.agentId;
    this.mcpConfig = opts.mcpConfig;
    this.mcpTools = opts.mcpTools;
    this.mcpHttp = opts.mcpHttp;
    this.syncArgs();
    this.extra = engineEnv(profile, this.home);
    this.spawnEnv = engineSpawnEnv(profile, this.home);
    this.cwd = opts.cwdOverride ? spawnCwd(opts.cwdOverride) : spawnCwd(opts.projectPath);
    this.bin = process.env[this.binEnv] ?? this.defaultBin;
    this.pack = opts.contextPack;
    this.threadId = opts.threadId;
    this.handler = onEvent;
    this.lastCwd = this.cwd;
    this.lastEnv = this.extra;
    this.lastArgs = this.args;
    this.aborted = false;
    this.finished = false;
  }

  updatePack(pack: string): void {
    this.pack = pack;
  }

  updateMcp(mcp: EngineMcp): void {
    this.mcpConfig = mcp.mcpConfig;
    this.mcpTools = mcp.mcpTools;
    this.mcpHttp = mcp.mcpHttp;
  }

  updateResume(sessionId?: string): void {
    this.resumeSessionId = sessionId && sessaoIdValido(sessionId) ? sessionId : undefined;
  }

  updateOverrides(over: EngineOverrides): void {
    this.overridesDoTurno = over;
  }

  /**
   * Relê perfil e agente a cada envio: mudar modelo/esforço na UI — na conta ou
   * no agente personalizado — vale já na próxima mensagem. O override do turno
   * (modelo "Automático") entra por último, ganhando de conta e de agente.
   */
  private syncArgs(): void {
    const profile = getProfile(this.profileId, this.home);
    const over: EngineOverrides = { ...agentOverrides(this.agentId, this.home), ...this.overridesDoTurno };
    const mcp = this.mcpFlags(profile?.engine);
    /*
     * Retomar a conversa do CLI em vez de nascer amnésico. Sem isso o Nexo
     * reenvia o histórico no stdin a cada turno e a quota some 2–5× mais
     * rápido (cache-create de system+tools+histórico toda vez, compactação
     * extra do Nexo, etc.).
     *
     * Os dois CLIs fazem isso de formas DIFERENTES, e é por isso que há dois
     * caminhos aqui:
     * - `claude`: flag (`--resume <id>`), que entra no fim como qualquer outra.
     * - `codex`: SUBCOMANDO (`exec resume <UUID> -`), que precisa vir logo
     *   depois do `exec`, antes das opções. O `-` é o prompt: no `exec` comum o
     *   stdin é lido sozinho, mas o help do `resume` só promete ler stdin
     *   quando `-` é passado — explicitar custa nada e fecha a ambiguidade.
     *
     * Medido contra o codex-cli 0.155.1: com o UUID certo, o `thread.started`
     * devolve o MESMO id em vez de abrir sessão nova.
     */
    const resumindoCodex = profile?.engine === "codex" && Boolean(this.resumeSessionId);
    // `slice(1)` pula o subcomando (`exec`) e mantém `--json`/`--skip-git-repo-check`
    // numa fonte só, em vez de repetir a lista aqui.
    const base = resumindoCodex
      ? ["exec", "resume", this.resumeSessionId as string, "-", ...this.baseArgs.slice(1)]
      : [...this.baseArgs];
    this.args = profile ? [...base, ...profileFlags(profile, this.home, over, mcp.tools, resumindoCodex)] : base;
    if (profile?.engine === "claude" && this.resumeSessionId) {
      this.args.push("--resume", this.resumeSessionId);
    }
    this.args.push(...this.attachmentFlags(profile?.engine));
    this.args.push(...mcp.flags);
    this.lastArgs = this.args;
    // Skill de `~/.nexo/skills` só chega no motor se estiver dentro do CLAUDE_CONFIG_DIR
    // isolado deste perfil — sincroniza a cada turno pra qualquer conta enxergar a mesma skill.
    if (profile?.engine === "claude") {
      const dir = engineEnv(profile, this.home).CLAUDE_CONFIG_DIR;
      if (dir) {
        syncGlobalSkills(join(dir, "skills"), globalSkillsDir(this.home));
        // Fire-and-forget: `jaTemHookRtk` (modules.ts) já deixa isso quase grátis depois da
        // primeira vez, mas não vale esperar nem a primeira tentativa — não pode atrasar o envio.
        if (loadConfig(this.home).modulos.rtk) void syncRtkHook(dir);
      }
    }
  }

  /**
   * Liga o servidor MCP do daemon, pro supervisor alcançar os membros do time
   * sem sair do turno.
   *
   * `--strict-mcp-config` porque o que vale aqui é a ferramenta do run, e só
   * ela: servidor herdado do `~/.claude.json` do usuário entraria no turno de um
   * agente que ele não configurou pra isso.
   *
   * As ferramentas saem em `tools` e não em `flags` porque quem monta o
   * `--allowed-tools` é o `profileFlags` — uma ocorrência só. Elas PRECISAM
   * estar lá: em `--print` não há canal pra aprovar permissão, então sem isso a
   * chamada seria negada em silêncio e o supervisor acharia que a ferramenta não
   * existe.
   */
  private mcpFlags(engine?: string): { flags: string[]; tools: string[] } {
    /*
     * O `codex` não tem arquivo de config por invocação: ele recebe a chave de
     * config direto (`-c mcp_servers.nexo={…}`), e o token por variável de
     * ambiente que ele lê pelo nome. Também não tem `--allowed-tools`: em
     * `codex exec` a permissão é do sandbox, não por ferramenta — então `tools`
     * volta vazio e não há nada a liberar.
     */
    if (engine === "codex") {
      return this.mcpHttp ? { flags: flagsDeMcpCodex(this.mcpHttp.url), tools: [] } : { flags: [], tools: [] };
    }
    if (engine !== "claude" || !this.mcpConfig) return { flags: [], tools: [] };
    return {
      flags: ["--mcp-config", this.mcpConfig, "--strict-mcp-config"],
      tools: [...(this.mcpTools?.length ? this.mcpTools : MCP_TOOLS)],
    };
  }

  /**
   * Imagem colada no chat mora no home do nexo, fora da pasta do projeto — e o
   * CLI nasce com cwd no projeto. Sem liberar essa pasta, a leitura do anexo é
   * negada (em --print não há como pedir permissão) e o motor diz que não vê
   * imagem nenhuma. `--add-dir` é exatamente pra isso.
   */
  private attachmentFlags(engine?: string): string[] {
    if (engine !== "claude" || !this.threadId) return [];
    const dir = attachmentsDir(this.threadId, this.home);
    // a pasta só nasce quando a primeira imagem é salva; --add-dir em pasta que
    // não existe é recusado pelo CLI
    mkdirSync(dir, { recursive: true });
    return ["--add-dir", dir];
  }

  async send(text: string): Promise<void> {
    if (!this.handler) throw new Error("engine sem start");
    this.syncArgs();
    await this.killChild();
    this.aborted = false;
    this.finished = false;
    const resumindo = Boolean(this.resumeSessionId);
    /*
     * Sem `--resume`, o pack vai no stdin: o CLI não guarda conversa entre
     * `--print`. Com `--resume`, o pack NÃO vai — senão cada turno duplica o
     * histórico e a quota explode (é exatamente o que o Claude Code interativo
     * não faz).
     */
    const full = resumindo ? text : [this.pack, text].filter(Boolean).join("\n\n");
    this.lastPayload = full;
    let suppressClose = false;
    const emit = (ev: EngineEvent) => {
      if (this.finished) return;
      if (this.aborted && ev.type !== "done") return;
      if (ev.type === "quota" || ev.type === "auth") suppressClose = true;
      if (ev.type === "done" || ev.type === "error" || ev.type === "quota" || ev.type === "auth") {
        this.finished = true;
      }
      this.handler?.(ev);
    };
    const child = spawnEngine(this.bin, this.args, {
      cwd: this.cwd,
      env: {
        ...this.spawnEnv,
        NEXO_CONTEXT_PACK: this.pack,
        // só o codex usa: o nome da variável está no `-c` que ele recebeu
        ...(this.mcpHttp ? { [ENV_TOKEN_MCP]: this.mcpHttp.token } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid) writeFileSync(enginePidPath(this.threadId, this.home), String(child.pid), "utf8");
    let outRest = "";
    let errRest = "";
    let stderrBuf = "";
    const flush = (chunk: string, rest: string, stderr: boolean): string => {
      const parts = (rest + chunk).split(/\r?\n/);
      const leftover = parts.pop() ?? "";
      for (const line of parts) {
        for (const ev of this.parse(line)) {
          if (stderr && ev.type === "text") continue;
          emit(ev);
        }
      }
      return leftover;
    };
    child.stdout.on("data", (buf: Buffer) => {
      outRest = flush(buf.toString("utf8"), outRest, false);
    });
    child.stderr.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      stderrBuf += s;
      errRest = flush(s, errRest, true);
    });
    child.on("error", (err) => emit({ type: "error", message: err.message }));
    child.on("close", (code) => {
      outRest = flush("\n", outRest, false);
      errRest = flush("\n", errRest, true);
      if (this.aborted || this.finished || suppressClose) return;
      const stderr = stderrBuf.trim();
      if (code && code !== 0 && resumindo && SESSAO_PERDIDA.test(stderr)) {
        // Sessão sumiu: próximo spawn manda o pack de novo, uma vez.
        this.resumeSessionId = undefined;
        void this.send(text);
        return;
      }
      if (code && code !== 0) emit({ type: "error", message: stderr || `exit ${code}` });
      else emit({ type: "done" });
    });
    const payload = isNodeScript(this.bin) ? text : full;
    child.stdin.write(`${payload}\n`);
    child.stdin.end();
  }

  async abort(): Promise<void> {
    this.aborted = true;
    await this.killChild();
    if (!this.finished) {
      this.finished = true;
      this.handler?.({ type: "done" });
    }
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    const pidPath = this.threadId ? enginePidPath(this.threadId, this.home) : "";
    const pid = child?.pid;
    if (pid) killTree(pid);
    else if (child && !child.killed) child.kill();
    if (pidPath && existsSync(pidPath)) {
      try {
        unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
  }
}

export function claudeEngine(home: string, profileId: string): CliEngine {
  return new CliEngine({
    home,
    profileId,
    binEnv: "NEXO_CLAUDE_BIN",
    defaultBin: "claude",
    args: ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages"],
    parse: parseCliLine,
  });
}

/**
 * `exec` e não a TUI, `--json` pra ter evento parseável.
 *
 * O que havia antes era `args: []`, ou seja `codex` puro — que abre a interface
 * interativa e morre na hora com stdin em pipe ("Error: stdin is not a
 * terminal"). O motor nunca completou um turno, e nenhum teste o exercitava.
 *
 * `--skip-git-repo-check` porque o `codex exec` se recusa a rodar fora de um
 * repositório git. É uma proteção dele — sem git, o que o modelo escreve não tem
 * como ser desfeito — e desligá-la é escolha, não descuido: o Nexo já aceita
 * projeto que não é repositório nos outros motores, e manter a recusa faria o
 * `codex` ser o único a falhar em projeto que funciona hoje. Quem quer a rede
 * usa git no projeto, que é o que o fan-in já exige pra isolar membro.
 *
 * O prompt vai por stdin, que é o que o `exec` lê quando não recebe argumento —
 * e é o que o `send` já faz.
 */
export function codexEngine(home: string, profileId: string): CliEngine {
  return new CliEngine({
    home,
    profileId,
    binEnv: "NEXO_CODEX_BIN",
    defaultBin: "codex",
    args: ["exec", "--json", "--skip-git-repo-check"],
    parse: parseCodexLine,
  });
}
