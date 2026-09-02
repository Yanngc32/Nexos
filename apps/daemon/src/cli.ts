import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import type { EngineKind } from "@nexo/shared";
import { createApp } from "./http.ts";
import { configPath, ensureHome, nexoHome, tokenPath } from "./home.ts";
import { loadConfig } from "./config.ts";
import { addProfile, getProfile, listProfiles, markReady } from "./profiles.ts";
import { createThread, listThreads, readThread } from "./threads.ts";
import { postMessage, sessionBus, switchThread } from "./session.ts";
import { join } from "node:path";

function homeFromEnv(): string {
  return ensureHome(nexoHome());
}

function writeToken(home: string): string {
  const token = randomBytes(24).toString("hex");
  writeFileSync(tokenPath(home), token, { encoding: "utf8", mode: 0o600 });
  return token;
}

function pidPath(home: string): string {
  return join(home, "run", "daemon.pid");
}

async function cmdUp(): Promise<void> {
  const home = homeFromEnv();
  const cfg = loadConfig(home);
  const token = writeToken(home);
  const app = createApp(home, token);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: cfg.port }, (info) => {
    writeFileSync(pidPath(home), String(process.pid), "utf8");
    console.log(`nexo up  http://127.0.0.1:${info.port}`);
  }) as ReturnType<typeof createServer>;
  void server;
}

function cmdDown(): void {
  const home = homeFromEnv();
  const path = pidPath(home);
  if (!existsSync(path)) {
    console.error("daemon não está up");
    process.exitCode = 1;
    return;
  }
  const pid = Number(readFileSync(path, "utf8"));
  try {
    process.kill(pid);
  } catch {
    console.error("não matou pid", pid);
  }
  unlinkSync(path);
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const home = homeFromEnv();

  if (cmd === "up") return cmdUp();
  if (cmd === "down") return cmdDown();

  if (cmd === "profile" && argv[1] === "ls") {
    for (const p of listProfiles(home)) console.log(`${p.id}\t${p.engine}\t${p.status}`);
    return;
  }

  if (cmd === "profile" && argv[1] === "add") {
    const id = argv[2];
    const engine = (arg("--engine", argv) ?? "stub") as EngineKind;
    const provider = arg("--provider", argv) as "anthropic" | "openai" | "gemini" | undefined;
    const model = arg("--model", argv);
    const apiKey = arg("--key", argv);
    if (!id) throw new Error("uso: nexo profile add <id> --engine stub|claude|codex|api");
    addProfile(
      {
        id,
        engine,
        ...(engine === "api" && provider && model ? { api: { provider, model } } : {}),
      },
      home,
      { apiKey, skipBinCheck: engine === "stub" },
    );
    console.log("ok", id);
    return;
  }

  if (cmd === "login") {
    const id = argv[1];
    if (!id) throw new Error("uso: nexo login <perfil>");
    const p = getProfile(id, home);
    if (!p) throw new Error("perfil não existe");
    if (p.engine === "stub" || p.engine === "api") {
      markReady(id, home);
      console.log("ready", id);
      return;
    }
    throw new Error(`login de ${p.engine}: rode o CLI do produto no perfil isolado (fatia spawn ainda)`);
  }

  if (cmd === "thread" && argv[1] === "ls") {
    const project = argv[2] ?? process.cwd();
    for (const t of listThreads(project, home)) console.log(t.id, t.profileId);
    return;
  }

  if (cmd === "thread" && argv[1] === "new") {
    const profileId = argv[2];
    if (!profileId) throw new Error("uso: nexo thread new <perfil>");
    const t = createThread({ projectPath: process.cwd(), profileId }, home);
    console.log(t.id);
    return;
  }

  if (cmd === "thread" && argv[1] === "show") {
    const id = argv[2];
    if (!id) throw new Error("uso: nexo thread show <id>");
    for (const e of readThread(id, home)) console.log(JSON.stringify(e));
    return;
  }

  if (cmd === "switch") {
    const profileId = argv[1];
    const threadId = arg("--thread", argv) ?? argv[2];
    if (!profileId || !threadId) throw new Error("uso: nexo switch <perfil> --thread <id>");
    await switchThread(threadId, { profileId, confirmed: true, reason: "user" }, home);
    console.log("switched", profileId);
    return;
  }

  if (cmd === "chat") {
    const profileId = argv[1];
    if (!profileId) throw new Error("uso: nexo chat <perfil>");
    const t = createThread({ projectPath: process.cwd(), profileId }, home);
    console.log("thread", t.id);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    sessionBus.on(t.id, (ev: { type: string; text?: string; suggestedProfileId?: string; chatOnly?: boolean }) => {
      if (ev.type === "text") process.stdout.write(ev.text ?? "");
      if (ev.type === "done") process.stdout.write("\n");
      if (ev.type === "quota") {
        const warn = ev.chatOnly ? " (chat, sem tools)" : "";
        console.log(`\nQuota. Ir para ${ev.suggestedProfileId ?? "?"}${warn}? (y/n)`);
      }
    });
    const ask = (): void => {
      rl.question("> ", async (line) => {
        if (line === "/quit") {
          rl.close();
          return;
        }
        if (line.startsWith("/switch ")) {
          await switchThread(t.id, { profileId: line.slice(8).trim(), confirmed: true, reason: "user" }, home);
          ask();
          return;
        }
        await postMessage(t.id, line, home);
        ask();
      });
    };
    ask();
    return;
  }

  console.log(`nexo — config ${configPath(home)}
  nexo up | down
  nexo profile add <id> --engine stub|claude|codex|api
  nexo profile ls
  nexo login <id>
  nexo thread new <perfil> | ls [pasta] | show <id>
  nexo chat <perfil>
  nexo switch <perfil> --thread <id>`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
