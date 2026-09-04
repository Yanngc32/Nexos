import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import type { EngineKind } from "@nexo/shared";
import { configPath, ensureHome, nexoHome } from "./home.ts";
import {
  accountInfo,
  addProfile,
  getProfile,
  IMPORT_WARNING,
  listProfiles,
  removeProfile,
  updateProfile,
} from "./profiles.ts";
import { createThread, listThreads, readThread } from "./threads.ts";
import { postMessage, sessionBus, switchThread } from "./session.ts";
import { loginProfile } from "./login.ts";
import { pidPath, startDaemon, waitClosed } from "./server.ts";
import {
  isTrusted,
  listServices,
  restartService,
  serviceLogs,
  servicesBus,
  stopAllServices,
  servicesChannel,
  startService,
  stopService,
  trustProject,
} from "./services.ts";
import { contextLines, costLines, limitsLines, threadReport } from "./usage-report.ts";

function homeFromEnv(): string {
  return ensureHome(nexoHome());
}

async function cmdUp(): Promise<void> {
  const home = homeFromEnv();
  const started = await startDaemon(home);
  if (started.alreadyUp) {
    console.log(`nexo already up  http://127.0.0.1:${started.port}`);
    return;
  }
  console.log(`nexo up  http://127.0.0.1:${started.port}`);
  // serviço é filho nosso: não sobrevive ao daemon
  const shutdown = () => {
    stopAllServices();
    started.server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await waitClosed(started.server);
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

type ChatEvent = {
  type: string;
  text?: string;
  detail?: string;
  suggestedProfileId?: string;
  chatOnly?: boolean;
  toProfileId?: string;
};

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

  if (cmd === "profile" && argv[1] === "set") {
    const id = argv[2];
    if (!id) throw new Error("uso: nexo profile set <id> [--model opus] [--effort high] [--mode auto]");
    const model = arg("--model", argv);
    const effort = arg("--effort", argv);
    const permissionMode = arg("--mode", argv);
    // --allow "Bash(git *),Bash(gh *)" — vazio ("") limpa a lista
    const allowRaw = arg("--allow", argv);
    const allowedTools = allowRaw === undefined ? undefined : allowRaw.split(",").map((t) => t.trim()).filter(Boolean);
    if (model === undefined && effort === undefined && permissionMode === undefined && allowedTools === undefined) {
      throw new Error("nada pra mudar: use --model, --effort, --mode e/ou --allow");
    }
    const p = updateProfile(id, home, {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
    });
    console.log(
      `${p.id}\tmodel=${p.model ?? "(padrão)"}\teffort=${p.effort ?? "(padrão)"}\tmode=${p.permissionMode ?? "(padrão)"}\tallow=${p.allowedTools?.join(",") || "(nenhuma)"}`,
    );
    return;
  }

  if (cmd === "profile" && argv[1] === "rm") {
    const id = argv[2];
    if (!id) throw new Error("uso: nexo profile rm <id>");
    removeProfile(id, home);
    console.log("rm", id);
    return;
  }

  if (cmd === "login") {
    const id = argv[1];
    if (!id) throw new Error("uso: nexo login <perfil> [--from-global]");
    const fromGlobal = argv.includes("--from-global");
    await loginProfile(id, home, { fromGlobal });
    console.log("ready", id);
    if (fromGlobal) console.warn(IMPORT_WARNING);
    return;
  }

  if (cmd === "svc") {
    const sub = argv[1];
    const project = process.cwd();
    if (sub === "ls" || sub === undefined) {
      const rel = listServices(project, home);
      if (rel.error) {
        console.error(rel.error);
        process.exitCode = 1;
        return;
      }
      if (!rel.services.length) {
        console.log(`nenhum serviço em nexo.json (${project})`);
        return;
      }
      if (!rel.trusted) console.warn("projeto não confiável: autostart ignorado (nexo svc trust)");
      for (const s of rel.services) {
        const porta = s.portNumber ? `:${s.portNumber}` : "";
        const estado = s.proc === "exited" ? `exited(${s.exitCode})` : s.proc;
        console.log(`${s.id}	${estado}${porta}	${s.name}`);
      }
      return;
    }
    if (sub === "trust") {
      trustProject(project, home);
      console.log("confiável:", project);
      return;
    }
    const todos = argv.includes("--all");
    const id = argv[2];
    if (!todos && !id) throw new Error("uso: nexo svc up|down|restart <id> | --all");
    const alvos = todos ? listServices(project, home).services.map((s) => s.id) : [id as string];

    if (sub === "up" || sub === "down" || sub === "restart") {
      for (const alvo of alvos) {
        const st =
          sub === "up"
            ? startService(project, alvo, home)
            : sub === "down"
              ? stopService(project, alvo, home)
              : await restartService(project, alvo, home);
        console.log(`${st.id}	${st.proc}${st.pid ? ` pid=${st.pid}` : ""}`);
      }
      // `up` sem daemon: o processo do CLI é dono do filho, então precisa ficar vivo.
      if (sub !== "down") {
        console.log("(ctrl+c derruba os serviços)");
        await new Promise(() => {});
      }
      return;
    }
    if (sub === "logs") {
      if (!id) throw new Error("uso: nexo svc logs <id>");
      process.stdout.write(serviceLogs(project, id));
      const canal = servicesChannel(project);
      servicesBus.on(canal, (ev: { type: string; id?: string; chunk?: string }) => {
        if (ev.type === "log" && ev.id === id && ev.chunk) process.stdout.write(ev.chunk);
      });
      await new Promise(() => {});
      return;
    }
    throw new Error("uso: nexo svc ls|up|down|restart|logs|trust");
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
    let pendingQuota: { suggested?: string; chatOnly?: boolean } | null = null;
    sessionBus.on(t.id, (ev: ChatEvent) => {
      if (ev.type === "text") process.stdout.write(ev.text ?? "");
      if (ev.type === "done") process.stdout.write("\n");
      if (ev.type === "quota") {
        // Sem sugestão o daemon já resolveu (switchMode auto) ou não vai trocar (denied).
        if (!ev.suggestedProfileId) {
          console.log(`\nQuota da conta acabou.${ev.detail ? ` ${ev.detail}` : ""}`);
        } else {
          pendingQuota = { suggested: ev.suggestedProfileId, chatOnly: ev.chatOnly };
          const warn = ev.chatOnly ? " (chat, sem tools)" : "";
          console.log(`\nQuota. Ir para ${ev.suggestedProfileId}${warn}? (y/n)`);
        }
      }
      if (ev.type === "switched") {
        console.log(`\nTrocou para ${ev.toProfileId ?? "?"} e continuou.`);
      }
      if (ev.type === "auth") {
        pendingQuota = { suggested: ev.suggestedProfileId, chatOnly: ev.chatOnly };
        console.log(`\n${ev.detail ?? "conta precisa de login"}`);
        if (ev.suggestedProfileId) {
          const warn = ev.chatOnly ? " (chat, sem tools)" : "";
          console.log(`Ir para ${ev.suggestedProfileId}${warn}? (y/n)`);
        }
      }
      if (ev.type === "error" && ev.suggestedProfileId) {
        pendingQuota = { suggested: ev.suggestedProfileId, chatOnly: ev.chatOnly };
        const warn = ev.chatOnly ? " (chat, sem tools)" : "";
        console.log(`\nMotor caiu. Ir para ${ev.suggestedProfileId}${warn}? (y/n)`);
      }
    });
    const ask = (): void => {
      rl.question("> ", async (line) => {
        if (line === "/quit" || line === "/exit") {
          rl.close();
          return;
        }
        if (pendingQuota) {
          const yn = line.trim().toLowerCase();
          const suggested = pendingQuota.suggested;
          pendingQuota = null;
          try {
            if ((yn === "y" || yn === "s") && suggested) {
              const resumed = await switchThread(
                t.id,
                { profileId: suggested, confirmed: true, reason: "quota" },
                home,
              );
              console.log("agora:", suggested, resumed ? "(continuando o turno)" : "");
            } else {
              console.log("ok, sem troca");
            }
          } catch (e) {
            console.error((e as Error).message);
          }
          ask();
          return;
        }
        if (line === "/profiles" || line === "/ls" || line === "/accounts") {
          for (const p of listProfiles(home)) console.log(`${p.id}\t${p.engine}\t${p.status}`);
          ask();
          return;
        }
        if (line === "/account" || line.startsWith("/account ")) {
          const id = line.slice(8).trim() || profileId;
          const p = getProfile(id, home);
          if (!p) console.error(`perfil não existe: ${id}`);
          else {
            for (const [k, v] of Object.entries(accountInfo(p, home))) {
              if (v !== undefined) console.log(`${k}\t${Array.isArray(v) ? v.join(",") : String(v)}`);
            }
          }
          ask();
          return;
        }
        if (line === "/cost" || line === "/context" || line === "/usage") {
          // Só disco e memória: nenhum destes comandos fala com o motor.
          try {
            const r = threadReport(t.id, home);
            const out =
              line === "/cost"
                ? costLines(r.totals)
                : line === "/context"
                  ? contextLines(r.totals, r.session)
                  : limitsLines(r.limits);
            for (const l of out) console.log(l);
          } catch (e) {
            console.error((e as Error).message);
          }
          ask();
          return;
        }
        if (line === "/help" || line === "/?") {
          console.log("/account [id]  /accounts  /cost  /context  /usage  /switch <id>  /quit");
          ask();
          return;
        }
        try {
          if (line.startsWith("/switch ")) {
            const target = line.slice(8).trim();
            if (!target) throw new Error("uso: /switch <perfil>");
            await switchThread(t.id, { profileId: target, confirmed: true, reason: "user" }, home);
            console.log("agora:", target);
          } else if (line.length > 0) {
            await postMessage(t.id, line, home);
          }
        } catch (e) {
          console.error((e as Error).message);
          if ((e as Error).message.includes("perfil não existe")) {
            const ids = listProfiles(home).map((p) => p.id);
            console.error("perfis:", ids.length ? ids.join(", ") : "(nenhum — nexo profile add …)");
          }
        }
        ask();
      });
    };
    ask();
    return;
  }

  console.log(`nexo — config ${configPath(home)}
  nexo up | down
  nexo profile add <id> --engine stub|claude|codex|api
  nexo profile ls | rm <id>
  nexo profile set <id> [--model opus|sonnet|haiku|fable] [--effort low|medium|high|xhigh|max]
                        [--mode auto|manual|acceptEdits|plan|bypassPermissions]
  nexo login <id>
  nexo svc ls | up <id>|--all | down <id>|--all | restart <id> | logs <id> | trust
  nexo thread new <perfil> | ls [pasta] | show <id>
  nexo chat <perfil>        (no chat: /account, /accounts, /cost, /context, /usage,
                             /switch <id>, /help)
  nexo switch <perfil> --thread <id>`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
