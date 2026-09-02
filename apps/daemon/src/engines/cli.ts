import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { EngineEvent, StartOpts } from "@nexo/shared";
import type { Engine, EngineHandler } from "./types.ts";
import { spawnCwd } from "../sandbox.ts";
import { engineEnv, getProfile } from "../profiles.ts";

type CliEngineOpts = {
  home: string;
  profileId: string;
  binEnv: "NEXO_CLAUDE_BIN" | "NEXO_CODEX_BIN";
  defaultBin: string;
};

export class CliEngine implements Engine {
  private child?: ChildProcessWithoutNullStreams;
  private handler?: EngineHandler;
  private readonly home: string;
  private readonly profileId: string;
  private readonly binEnv: CliEngineOpts["binEnv"];
  private readonly defaultBin: string;
  lastEnv: Record<string, string | undefined> = {};
  lastCwd?: string;

  constructor(opts: CliEngineOpts) {
    this.home = opts.home;
    this.profileId = opts.profileId;
    this.binEnv = opts.binEnv;
    this.defaultBin = opts.defaultBin;
  }

  async start(opts: StartOpts, onEvent: EngineHandler): Promise<void> {
    const profile = getProfile(this.profileId, this.home);
    if (!profile) throw new Error("perfil não existe");
    const extra = engineEnv(profile, this.home);
    const cwd = spawnCwd(opts.projectPath);
    const bin = process.env[this.binEnv] ?? this.defaultBin;
    this.lastCwd = cwd;
    this.lastEnv = extra;
    this.handler = onEvent;
    let finished = false;
    const emit = (ev: EngineEvent) => {
      if (finished && (ev.type === "done" || ev.type === "error" || ev.type === "quota")) return;
      if (ev.type === "done" || ev.type === "error" || ev.type === "quota") finished = true;
      onEvent(ev);
    };
    const child =
      bin.endsWith(".mjs") || bin.endsWith(".js")
        ? spawn(process.execPath, [bin], {
            cwd,
            env: { ...process.env, ...extra, NEXO_CONTEXT_PACK: opts.contextPack },
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(bin, [], {
            cwd,
            env: { ...process.env, ...extra, NEXO_CONTEXT_PACK: opts.contextPack },
            stdio: ["pipe", "pipe", "pipe"],
          });
    this.child = child;
    const onLine = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (!line) continue;
        if (/rate_limit|quota|\b429\b/i.test(line)) {
          emit({ type: "quota" });
          continue;
        }
        if (line.startsWith("tool:")) {
          const [name, ...rest] = line.slice(5).split(" ");
          emit({ type: "tool", name: name ?? "tool", summary: rest.join(" ") });
          continue;
        }
        emit({ type: "text", text: line });
      }
    };
    child.stdout.on("data", onLine);
    child.stderr.on("data", onLine);
    child.on("exit", (code) => {
      if (code && code !== 0) emit({ type: "error", message: `exit ${code}` });
      else emit({ type: "done" });
    });
  }

  async send(text: string): Promise<void> {
    this.child?.stdin.write(`${text}\n`);
  }

  async abort(): Promise<void> {
    this.child?.kill();
    this.child = undefined;
  }
}

export function claudeEngine(home: string, profileId: string): CliEngine {
  return new CliEngine({ home, profileId, binEnv: "NEXO_CLAUDE_BIN", defaultBin: "claude" });
}

export function codexEngine(home: string, profileId: string): CliEngine {
  return new CliEngine({ home, profileId, binEnv: "NEXO_CODEX_BIN", defaultBin: "codex" });
}
