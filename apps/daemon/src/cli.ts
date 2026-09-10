import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { hostNaUrl, type EngineKind } from "@nexo/shared";
import { configPath, ensureHome, nexoHome, tokenPath } from "./home.ts";
import { loadConfig } from "./config.ts";
import {
  accountInfo,
  addProfile,
  getProfile,
  IMPORT_WARNING,
  listProfiles,
  removeProfile,
  updateProfile,
} from "./profiles.ts";
import { HOOK_EVENT_RE } from "./hooks.ts";
import { ensureGraphifyInstalled } from "./graphify.ts";
import { ensureCavemanInstalled, ensureRtkInstalled } from "./modules.ts";
import { sincronizarGrafoAutomatico } from "./grafo-auto.ts";
import { createThread, listThreads, readThread } from "./threads.ts";
import { pingUsoDeTodasAsContas, postMessage, sessionBus, switchThread } from "./session.ts";
import { loginProfile } from "./login.ts";
import { pidPath, startDaemon, waitClosed } from "./server.ts";
import { fecharTudo, pararDeManter } from "./escuta.ts";
import { instalarSkill } from "./skill.ts";
import { apagarBranchesNexo, listarBranchesNexo, podeIsolar } from "./worktree.ts";
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
  // Fire-and-forget, em paralelo ao resto da subida — nunca lançam, então não atrasam nem
  // condicionam o daemon a isso (ver ensureGraphifyInstalled/ensureRtkInstalled/ensureCavemanInstalled).
  void ensureGraphifyInstalled();
  const modulos = loadConfig(home).modulos;
  if (modulos.rtk) void ensureRtkInstalled();
  if (modulos.caveman) void ensureCavemanInstalled(home);
  // Síncrono e barato (só lê agents.json/hooks.json) — sem network, não precisa de fire-and-forget.
  const r = sincronizarGrafoAutomatico(home);
  if (!r.ok) console.error(`grafo automático: ${r.motivo}`);
  /*
   * Limite de uso (5h/7d) só vem junto da resposta de uma mensagem de verdade — não tem consulta
   * de graça. Pinga toda conta claude/codex logada a cada 10min (e uma vez já na subida) pra o
   * painel "Uso de todas as contas" não ficar preso em "sem dado ainda" pra quem não está
   * conversando agora. Gasto real, pequeno, por conta — decisão explícita do usuário.
   */
  const PING_USO_MS = 10 * 60_000;
  void pingUsoDeTodasAsContas(home).catch((e) => console.error("ping de uso:", (e as Error).message));
  const pingUso = setInterval(() => {
    void pingUsoDeTodasAsContas(home).catch((e) => console.error("ping de uso:", (e as Error).message));
  }, PING_USO_MS);
  for (const f of started.falhas) {
    // túnel fora do ar é normal e ele volta sozinho; dizer o motivo evita que
    // "o celular não conecta" vire caça ao tesouro
    console.error(`nexo: não consegui escutar em ${f.host} (${f.motivo})`);
  }
  for (const h of started.hosts) {
    const mostrar = h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h;
    console.log(`nexo up  http://${hostNaUrl(mostrar)}:${started.port}`);
  }
  // serviço é filho nosso: não sobrevive ao daemon
  const shutdown = () => {
    clearInterval(pingUso);
    stopAllServices();
    // os sockets extras seguram o event loop vivo: fechar só o principal
    // deixaria o processo pendurado pra sempre
    pararDeManter();
    fecharTudo();
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

  if (cmd === "skill") {
    if (argv[1] !== "install") throw new Error("uso: nexo skill install");
    const r = instalarSkill();
    if (!r.ok) {
      console.error(r.motivo);
      process.exitCode = 1;
      return;
    }
    console.log(`skill instalada em ${r.destino}`);
    console.log("Ela vale em todos os projetos. As ferramentas de criar agente e time já");
    console.log("funcionavam sem isto — a skill acrescenta o julgamento de QUANDO usá-las.");
    return;
  }

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

  /**
   * Chamado PELO script de hook do git (`.git/hooks/post-commit`/`post-push`/`pre-push`), nunca à
   * mão — quem instala o script é `sincronizarHooksDoProjeto` (hooks.ts), disparada sozinha
   * quando uma regra é criada/editada/apagada pela API/UI ou quando o projeto é aberto no Nexo. Não
   * existe mais `nexo hook install` manual: a v2 não tem um passo que a pessoa precisa lembrar.
   *
   * `post-commit`/`post-push` são fire-and-forget com teto curto e nunca lançam: quem chama já tem
   * `|| true` no shell, mas o motivo real de engolir erro aqui é não travar nem falhar
   * `git commit`/`git push` por causa do daemon estar fechado ou de rede local com problema —
   * FALHA ABERTA pra indisponibilidade de infraestrutura (bem diferente de "agente rodou e não
   * decidiu", que é fechada — ver `dispararPrePush`).
   *
   * `pre-push` é o oposto: sem teto curto (espera o run bloqueante inteiro) e PROPAGA o veredito
   * como exit code — é isso que faz o `git push` ser barrado de verdade.
   */
  if (cmd === "hook" && argv[1] === "fire") {
    const event = argv[2] ?? "";
    if (!HOOK_EVENT_RE.test(event)) return;
    const branch = arg("--branch", argv) ?? "";
    const project = process.cwd();
    if (!existsSync(tokenPath(home))) return; // daemon nunca subiu nesta home — falha aberta
    const token = readFileSync(tokenPath(home), "utf8").trim();
    const port = loadConfig(home).port;
    const bloqueante = event === "git.pre-push";
    const ac = new AbortController();
    const relogio = bloqueante ? undefined : setTimeout(() => ac.abort(), 4000);
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/v1/hooks/fire`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ event, projectPath: project, ...(branch ? { branch } : {}) }),
        signal: ac.signal,
      });
      if (bloqueante) {
        const { aprovado, motivo } = (await resp.json()) as { aprovado?: boolean; motivo?: string };
        if (!aprovado) {
          console.error(motivo || "push barrado por um Nexo Hook");
          process.exitCode = 1;
        }
      }
    } catch {
      // daemon fechado, porta trocada, rede local instável — falha ABERTA de propósito
    } finally {
      if (relogio) clearTimeout(relogio);
    }
    return;
  }

  /*
   * Os branches que o fan-in deixa. Existe porque eles ACUMULAM: o Nexo tira a
   * árvore de trabalho e deixa o branch de propósito (é ele que guarda o que o
   * agente fez), então um repositório com uso regular de time junta um por
   * membro por run e ninguém apaga dezenas à mão.
   */
  if (cmd === "branch" && (argv[1] === "ls" || argv[1] === "rm")) {
    const project = argv[2] && !argv[2].startsWith("--") ? argv[2] : process.cwd();
    const isolar = await podeIsolar(project);
    if (!isolar.pode) {
      console.error(`nexo: ${isolar.motivo}`);
      process.exitCode = 1;
      return;
    }
    const run = arg("--run", argv);
    const todos = await listarBranchesNexo(project);
    const alvo = run ? todos.filter((b) => b.runId === run) : todos;

    if (!alvo.length) {
      console.log(run ? `nenhum branch do run ${run}` : "nenhum branch nexo/*");
      return;
    }

    if (argv[1] === "ls") {
      for (const b of alvo) {
        console.log(`${b.mesclado ? "mesclado    " : "não mesclado"}\t${b.ultimo.slice(0, 10)}\t${b.branch}`);
      }
      const sobrando = alvo.filter((b) => b.mesclado).length;
      console.log(`\n${alvo.length} branch(es); ${sobrando} já no HEAD — 'nexo branch rm' apaga esses.`);
      return;
    }

    /*
     * Só o que já está no HEAD. O resto tem commit que só existe ali: apagar
     * seria perder trabalho que ninguém olhou, que é justamente o que o
     * `removerWorktree` evita ao preservar o branch.
     */
    const guardados = alvo.filter((b) => !b.mesclado);
    const feitos = await apagarBranchesNexo(project, alvo.filter((b) => b.mesclado).map((b) => b.branch));
    for (const f of feitos) console.log(f.ok ? `apagado ${f.branch}` : `falhou  ${f.branch}: ${f.saida}`);
    if (guardados.length) {
      // a linha em branco só quando teve saída antes dela: rodar a limpeza num
      // repositório já limpo abria com linha vazia, parecendo erro engolido
      if (feitos.length) console.log("");
      console.log(`${guardados.length} preservado(s) por terem commit fora do HEAD:`);
      for (const b of guardados) console.log(`  ${b.branch}  (${b.ultimo.slice(0, 10)})`);
      console.log("Olhe com 'git log <branch>'. Pra apagar mesmo assim: git branch -D <branch>");
    }
    if (!feitos.length && !guardados.length) console.log("nada a apagar");
    return;
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
  nexo hook fire <evento> [--branch <nome>]   (chamado pelo script de .git/hooks/, não à mão —
                                               regra e sincronização vivem na API/UI de Hooks)
  nexo thread new <perfil> | ls [pasta] | show <id>
  nexo branch ls | rm [pasta] [--run <id>]   (branches nexo/* dos times; rm só apaga
                                              o que já está no HEAD)
  nexo chat <perfil>        (no chat: /account, /accounts, /cost, /context, /usage,
                             /switch <id>, /help)
  nexo switch <perfil> --thread <id>`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
