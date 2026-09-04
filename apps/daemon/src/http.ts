import { Hono } from "hono";
import { cors } from "hono/cors";
import type { SwitchReason } from "@nexo/shared";
import { getAgent, listAgents, removeAgent, saveAgent, type AgentInput } from "./agents.ts";
import { loadConfig, saveConfig } from "./config.ts";
import {
  accountInfo,
  addProfile,
  applyLoginResult,
  getProfile,
  importGlobalCredentials,
  IMPORT_WARNING,
  listProfiles,
  markReady,
  updateProfile,
  type AddProfileInput,
} from "./profiles.ts";
import { readAttachment, type IncomingImage } from "./attachments.ts";
import { cliAuthStatus } from "./auth-status.ts";
import { cancelLogin, loginStatus, startLogin, submitCode } from "./login-session.ts";
import { createThread, listThreads, projectsFromThreads, readThread, threadHead } from "./threads.ts";
import {
  abortThread,
  agentSnapshots,
  allLimits,
  busyThreads,
  clearThread,
  dropThread,
  postMessage,
  sessionBus,
  switchThread,
} from "./session.ts";
import { threadReport } from "./usage-report.ts";
import {
  autostartServices,
  listServices,
  probeUrl,
  restartService,
  serviceLogs,
  servicesBus,
  servicesChannel,
  startService,
  stopService,
  trustProject,
} from "./services.ts";
import { streamSSE } from "hono/streaming";

export function createApp(home: string, token: string): Hono {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path.endsWith("/health")) return next();
    const hdr = c.req.header("authorization") ?? "";
    if (hdr !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/v1/profiles", (c) => c.json(listProfiles(home)));

  app.get("/v1/accounts", (c) => c.json(listProfiles(home).map((p) => accountInfo(p, home))));

  // Antes de /v1/accounts/:id, senão o Hono casa :id = "limits".
  app.get("/v1/accounts/limits", (c) => {
    const seen = allLimits();
    return c.json(
      listProfiles(home).map((p) => ({
        id: p.id,
        engine: p.engine,
        status: p.status,
        limits: seen[p.id] ?? null,
      })),
    );
  });

  app.get("/v1/accounts/:id", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    const info = accountInfo(applyLoginResult(p.id, home), home);
    // live=1 gasta um spawn do CLI; só quando a UI pede o painel.
    if (c.req.query("live") === "1") {
      const cli = cliAuthStatus(p, home);
      if (cli) info.cli = cli;
    }
    return c.json(info);
  });

  app.post("/v1/profiles/:id/login/start", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    try {
      return c.json(await startLogin(c.req.param("id"), home, { email: body.email }));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.post("/v1/profiles/:id/login/code", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string; code?: string };
    if (!body.loginId || !body.code) return c.json({ error: "loginId e code obrigatórios" }, 400);
    try {
      const res = await submitCode(body.loginId, body.code, home);
      return c.json(res, res.ok ? 200 : 400);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/profiles/:id/login/status", (c) => {
    const loginId = c.req.query("loginId") ?? "";
    if (!loginId) return c.json({ error: "loginId obrigatório" }, 400);
    try {
      return c.json(loginStatus(loginId, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.post("/v1/profiles/:id/login/cancel", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { loginId?: string };
    if (body.loginId) cancelLogin(body.loginId);
    return c.json({ ok: true });
  });

  app.post("/v1/profiles", async (c) => {
    const body = (await c.req.json()) as AddProfileInput & { apiKey?: string };
    try {
      const p = addProfile(body, home, { apiKey: body.apiKey, skipBinCheck: body.engine === "stub" });
      return c.json(p, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.patch("/v1/profiles/:id", async (c) => {
    const body = (await c.req.json()) as {
      model?: string | null;
      effort?: string | null;
      permissionMode?: string | null;
      allowedTools?: string[] | null;
    };
    try {
      return c.json(updateProfile(c.req.param("id"), home, body));
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.includes("não existe") ? 404 : 400);
    }
  });

  app.get("/v1/profiles/:id", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p.status === "ready" ? p : applyLoginResult(p.id, home));
  });

  app.post("/v1/profiles/:id/import", (c) => {
    try {
      return c.json({ ...importGlobalCredentials(c.req.param("id"), home), warning: IMPORT_WARNING });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes("não existe") ? 404 : 400;
      return c.json({ error: msg }, status as 400);
    }
  });

  app.post("/v1/profiles/:id/login", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    if (p.engine === "stub" || p.engine === "api") {
      return c.json(markReady(p.id, home));
    }
    return c.json({ error: "abra o terminal: nexo login " + p.id }, 202);
  });

  app.get("/v1/threads", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    // `busy` é estado vivo (memória), não vem do JSONL: por isso é carimbado aqui.
    const busy = new Set(busyThreads());
    return c.json(listThreads(projectPath, home).map((t) => ({ ...t, busy: busy.has(t.id) })));
  });

  /**
   * Uma linha por conversa com motor de pé — conta, modelo, o que está escrevendo
   * agora. É o que o painel de agentes mostra quando há trabalho em paralelo.
   */
  app.get("/v1/agents", (c) => {
    const agents = agentSnapshots().map((a) => {
      const head = threadHead(a.threadId, home);
      const def = a.agentId ? getAgent(a.agentId, home) : undefined;
      return {
        ...a,
        projectPath: head?.projectPath ?? "",
        preview: head?.preview ?? "",
        updatedAt: head?.updatedAt ?? "",
        engine: getProfile(a.profileId, home)?.engine ?? "",
        // Nome e cor vêm daqui pro painel não ter que cruzar duas listas.
        ...(def ? { agentName: def.name, ...(def.color ? { agentColor: def.color } : {}) } : {}),
      };
    });
    return c.json(agents);
  });

  /* ---------- agentes personalizados (definições) ---------- */

  app.get("/v1/agents/defs", (c) => c.json(listAgents(home)));

  app.post("/v1/agents/defs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AgentInput;
    try {
      return c.json(saveAgent(body, home), 201);
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.put("/v1/agents/defs/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AgentInput;
    try {
      // A rota manda no id: body sem id (ou com outro) não renomeia nada.
      return c.json(saveAgent({ ...body, id: c.req.param("id") }, home));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.delete("/v1/agents/defs/:id", (c) => {
    try {
      removeAgent(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 404) as 404);
    }
  });

  /** Stream global: o "*" do bus recebe o evento de qualquer conversa. */
  app.get("/v1/agents/events", (c) => {
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      sessionBus.on("*", onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sessionBus.off("*", onEv);
          resolve();
        });
      });
    });
  });

  app.post("/v1/threads", async (c) => {
    const body = (await c.req.json()) as { projectPath: string; profileId?: string; agentId?: string };
    try {
      // Com agente, a conta dele é o padrão — mas um profileId explícito ainda manda.
      const def = body.agentId ? getAgent(body.agentId, home) : undefined;
      if (body.agentId && !def) return c.json({ error: `agente não existe: ${body.agentId}` }, 400);
      const profileId = body.profileId || def?.profileId || "";
      if (!profileId) return c.json({ error: "profileId obrigatório" }, 400);
      return c.json(
        createThread(
          { projectPath: body.projectPath, profileId, ...(def ? { agentId: def.id } : {}) },
          home,
        ),
        201,
      );
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/v1/threads/:id", (c) => {
    try {
      return c.json(readThread(c.req.param("id"), home));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.get("/v1/threads/:id/usage", (c) => {
    try {
      return c.json(threadReport(c.req.param("id"), home));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.get("/v1/threads/:id/events", (c) => {
    const threadId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      sessionBus.on(threadId, onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sessionBus.off(threadId, onEv);
          resolve();
        });
      });
    });
  });

  app.post("/v1/threads/:id/messages", async (c) => {
    const body = (await c.req.json()) as { text?: string; images?: IncomingImage[] };
    const text = typeof body.text === "string" ? body.text : "";
    const images = Array.isArray(body.images) ? body.images : [];
    // Mensagem só de imagem vale; vazia de tudo, não.
    if (!text.trim() && images.length === 0) return c.json({ error: "mensagem vazia" }, 400);
    try {
      await postMessage(c.req.param("id"), text, home, images);
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });

  /** Serve a imagem colada pro chat renderizar o histórico depois de recarregar. */
  app.get("/v1/threads/:id/attachments/:file", (c) => {
    try {
      const { buf, mime } = readAttachment(c.req.param("id"), c.req.param("file"), home);
      // Uint8Array novo: o Buffer do node não casa com o tipo de corpo do Hono.
      return c.body(new Uint8Array(buf), 200, { "content-type": mime, "cache-control": "no-store" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.post("/v1/threads/:id/switch", async (c) => {
    const body = (await c.req.json()) as {
      profileId: string;
      confirmed?: boolean;
      reason?: SwitchReason;
    };
    if (body.confirmed !== true) return c.json({ error: "confirmed obrigatório" }, 400);
    try {
      const resumed = await switchThread(
        c.req.param("id"),
        { profileId: body.profileId, confirmed: true, reason: body.reason ?? "user" },
        home,
      );
      // `resumed`: o cliente precisa saber que a conta nova já está respondendo o turno.
      return c.json({ ok: true, resumed });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });

  app.post("/v1/threads/:id/abort", async (c) => {
    await abortThread(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** "/clear": grava o corte de contexto e derruba a live em memória — não some do JSONL. */
  app.post("/v1/threads/:id/clear", async (c) => {
    try {
      await clearThread(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.delete("/v1/threads/:id", async (c) => {
    try {
      await dropThread(c.req.param("id"), home);
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 404;
      return c.json({ error: (e as Error).message }, status as 404);
    }
  });

  /** Lista de pastas: o que o app salvou + o que as conversas revelam. */
  app.get("/v1/projects", (c) => {
    const cfg = loadConfig(home);
    const chave =(p: string) => p.replace(/[\u005c]/g, "/").replace(/\/+$/, "").toLowerCase();
    // Escondida vence a dedução: senão tirar da lista era desfeito pelas conversas gravadas.
    const escondidas = new Set(cfg.hiddenRepos.map(chave));
    const merged = cfg.repos.filter((p) => !escondidas.has(chave(p)));
    const doConfig = merged.length;
    const vistos = new Set(merged.map(chave));
    for (const p of projectsFromThreads(home)) {
      if (vistos.has(chave(p)) || escondidas.has(chave(p))) continue;
      vistos.add(chave(p));
      merged.push(p);
    }
    return c.json({
      repos: merged,
      hiddenRepos: cfg.hiddenRepos,
      lastProject: cfg.lastProject,
      lastThread: cfg.lastThread,
      fromConfig: doConfig,
      fromThreads: merged.length - doConfig,
    });
  });

  /* ---------- serviços locais do projeto ---------- */

  app.get("/v1/services", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json(listServices(projectPath, home));
  });

  /** Marca o projeto como confiável: sem isso o autostart do nexo.json é ignorado. */
  app.post("/v1/services/trust", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({ trustedProjects: trustProject(body.projectPath, home) });
  });

  /** Sobe o que está marcado com autostart. Sem efeito em projeto não confiável. */
  app.post("/v1/services/autostart", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
    if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    try {
      return c.json({ started: autostartServices(body.projectPath, home) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 422);
    }
  });

  app.get("/v1/services/events", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    const canal = servicesChannel(projectPath);
    return streamSSE(c, async (stream) => {
      const onEv = (ev: unknown) => {
        void stream.writeSSE({ data: JSON.stringify(ev) });
      };
      servicesBus.on(canal, onEv);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          servicesBus.off(canal, onEv);
          resolve();
        });
      });
    });
  });

  app.get("/v1/services/:id/logs", (c) => {
    const projectPath = c.req.query("projectPath");
    if (!projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
    return c.json({ id: c.req.param("id"), log: serviceLogs(projectPath, c.req.param("id")) });
  });

  for (const acao of ["start", "stop", "restart"] as const) {
    app.post(`/v1/services/:id/${acao}`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { projectPath?: string };
      if (!body.projectPath) return c.json({ error: "projectPath obrigatório" }, 400);
      try {
        const id = c.req.param("id");
        const status =
          acao === "start"
            ? startService(body.projectPath, id, home)
            : acao === "stop"
              ? stopService(body.projectPath, id, home)
              : await restartService(body.projectPath, id, home);
        return c.json(status);
      } catch (e) {
        const err = e as Error & { status?: number };
        // erro de parse do nexo.json não é culpa do request: 422
        const status = err.status ?? (/nexo\.json/.test(err.message) ? 422 : 400);
        return c.json({ error: err.message }, status as 400);
      }
    });
  }

  app.get("/v1/probe", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "url obrigatória" }, 400);
    try {
      return c.json(await probeUrl(url));
    } catch (e) {
      const err = e as Error & { status?: number };
      return c.json({ error: err.message }, (err.status ?? 400) as 400);
    }
  });

  app.get("/v1/config", (c) => c.json(loadConfig(home)));
  app.put("/v1/config", async (c) => {
    const body = await c.req.json();
    return c.json(saveConfig(home, body));
  });

  return app;
}
