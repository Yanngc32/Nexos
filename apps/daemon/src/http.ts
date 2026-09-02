import { Hono } from "hono";
import type { SwitchReason } from "@nexo/shared";
import { loadConfig, saveConfig } from "./config.ts";
import { addProfile, getProfile, listProfiles, markReady, type AddProfileInput } from "./profiles.ts";
import { createThread, listThreads, readThread } from "./threads.ts";
import { postMessage, sessionBus, switchThread } from "./session.ts";
import { streamSSE } from "hono/streaming";

export function createApp(home: string, token: string): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/v1/health", (c) => c.json({ ok: true }));

  app.use("/v1/*", async (c, next) => {
    if (c.req.path.endsWith("/health")) return next();
    const hdr = c.req.header("authorization") ?? "";
    if (hdr !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/v1/profiles", (c) => c.json(listProfiles(home)));

  app.post("/v1/profiles", async (c) => {
    const body = (await c.req.json()) as AddProfileInput & { apiKey?: string };
    try {
      const p = addProfile(body, home, { apiKey: body.apiKey, skipBinCheck: body.engine === "stub" });
      return c.json(p, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.get("/v1/profiles/:id", (c) => {
    const p = getProfile(c.req.param("id"), home);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p);
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
    return c.json(listThreads(projectPath, home));
  });

  app.post("/v1/threads", async (c) => {
    const body = (await c.req.json()) as { projectPath: string; profileId: string };
    try {
      return c.json(createThread(body, home), 201);
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
    const body = (await c.req.json()) as { text: string };
    try {
      await postMessage(c.req.param("id"), body.text, home);
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
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
      await switchThread(
        c.req.param("id"),
        { profileId: body.profileId, confirmed: true, reason: body.reason ?? "user" },
        home,
      );
      return c.json({ ok: true });
    } catch (e) {
      const status = (e as Error & { status?: number }).status ?? 400;
      return c.json({ error: (e as Error).message }, status as 400);
    }
  });

  app.post("/v1/threads/:id/abort", async (c) => {
    const { getLive } = await import("./session.ts");
    await getLive(c.req.param("id"))?.engine.abort();
    return c.json({ ok: true });
  });

  app.get("/v1/config", (c) => c.json(loadConfig(home)));
  app.put("/v1/config", async (c) => {
    const body = await c.req.json();
    return c.json(saveConfig(home, body));
  });

  return app;
}
