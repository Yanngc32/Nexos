import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { EngineEvent, EngineOverrides, Profile, StartOpts } from "@nexo/shared";
import { EFFORT_LEVELS, MODEL_RE, PERMISSION_MODES, TOOL_PATTERN_RE } from "@nexo/shared";
import type { Engine, EngineHandler } from "./types.ts";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { attachmentsDir, enginePidPath } from "../home.ts";
import { killTree } from "../kill-tree.ts";
import { spawnCwd } from "../sandbox.ts";
import { agentOverrides } from "../agents.ts";
import { engineEnv, engineSpawnEnv, getProfile } from "../profiles.ts";
import { isNodeScript, spawnBin } from "../spawn-bin.ts";
import { parseCliLine } from "./parse-claude.ts";

export { parseCliLine };

function spawnEngine(bin: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  if (isNodeScript(bin)) {
    return spawnBin(bin, args, opts) as ChildProcessWithoutNullStreams;
  }
  if (process.platform === "win32") {
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", bin, ...args], {
      ...opts,
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }
  return spawn(bin, args, { ...opts, shell: false }) as ChildProcessWithoutNullStreams;
}

/**
 * Só claude tem --model/--effort/--permission-mode confirmados; codex fica no padrão dele.
 * `over` são os ajustes do agente personalizado: vencem os da conta quando existem.
 */
function profileFlags(profile: Profile, over: EngineOverrides = {}): string[] {
  if (profile.engine !== "claude") return [];
  const model = over.model ?? profile.model;
  const effort = over.effort ?? profile.effort;
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
  const allowed = (profile.allowedTools ?? []).filter((t) => TOOL_PATTERN_RE.test(t));
  if (allowed.length) out.push("--allowed-tools", ...allowed);
  return out;
}

type CliEngineOpts = {
  home: string;
  profileId: string;
  binEnv: "NEXO_CLAUDE_BIN" | "NEXO_CODEX_BIN";
  defaultBin: string;
  args: string[];
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
  private args: string[];
  private threadId = "";
  private agentId?: string;
  private aborted = false;
  private finished = false;
  lastEnv: Record<string, string | undefined> = {};
  lastCwd?: string;
  lastArgs: string[] = [];

  constructor(opts: CliEngineOpts) {
    this.home = opts.home;
    this.profileId = opts.profileId;
    this.binEnv = opts.binEnv;
    this.defaultBin = opts.defaultBin;
    this.baseArgs = opts.args;
    this.args = opts.args;
  }

  async start(opts: StartOpts, onEvent: EngineHandler): Promise<void> {
    const profile = getProfile(this.profileId, this.home);
    if (!profile) throw new Error("perfil não existe");
    this.threadId = opts.threadId;
    this.agentId = opts.agentId;
    this.syncArgs();
    this.extra = engineEnv(profile, this.home);
    this.spawnEnv = engineSpawnEnv(profile, this.home);
    this.cwd = spawnCwd(opts.projectPath);
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

  /**
   * Relê perfil e agente a cada envio: mudar modelo/esforço na UI — na conta ou
   * no agente personalizado — vale já na próxima mensagem.
   */
  private syncArgs(): void {
    const profile = getProfile(this.profileId, this.home);
    const over: EngineOverrides = agentOverrides(this.agentId, this.home);
    this.args = profile ? [...this.baseArgs, ...profileFlags(profile, over)] : [...this.baseArgs];
    this.args.push(...this.attachmentFlags(profile?.engine));
    this.lastArgs = this.args;
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
      env: { ...this.spawnEnv, NEXO_CONTEXT_PACK: this.pack },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    if (child.pid) writeFileSync(enginePidPath(this.threadId, this.home), String(child.pid), "utf8");
    let outRest = "";
    let errRest = "";
    const flush = (chunk: string, rest: string, stderr: boolean): string => {
      const parts = (rest + chunk).split(/\r?\n/);
      const leftover = parts.pop() ?? "";
      for (const line of parts) {
        for (const ev of parseCliLine(line)) {
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
      errRest = flush(buf.toString("utf8"), errRest, true);
    });
    child.on("error", (err) => emit({ type: "error", message: err.message }));
    child.on("close", (code) => {
      outRest = flush("\n", outRest, false);
      errRest = flush("\n", errRest, true);
      if (this.aborted || this.finished || suppressClose) return;
      if (code && code !== 0) emit({ type: "error", message: `exit ${code}` });
      else emit({ type: "done" });
    });
    const payload = isNodeScript(this.bin) ? text : [this.pack, text].filter(Boolean).join("\n\n");
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
  });
}

export function codexEngine(home: string, profileId: string): CliEngine {
  return new CliEngine({
    home,
    profileId,
    binEnv: "NEXO_CODEX_BIN",
    defaultBin: "codex",
    args: [],
  });
}
