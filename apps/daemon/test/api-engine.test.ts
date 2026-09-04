import { createServer, type RequestListener } from "node:http";
import { describe, it, expect, afterEach } from "vitest";
import { addProfile } from "../src/profiles.ts";
import { ApiEngine } from "../src/engines/api.ts";
import { tempHome } from "./helpers.ts";
import type { EngineEvent } from "@nexo/shared";

let server: ReturnType<typeof createServer> | undefined;
let base = "";

// RequestListener, não Parameters<typeof createServer>[0]: createServer é
// sobrecarregado e Parameters pega a última assinatura, que é ServerOptions.
async function listen(handler: RequestListener): Promise<void> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  base = `http://127.0.0.1:${addr.port}`;
  process.env.NEXO_API_BASE = base;
}

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.NEXO_API_BASE;
});

function collect(engine: ApiEngine): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  return new Promise((resolve, reject) => {
    engine
      .start(
        { threadId: "t-1", projectPath: "/p", profileId: "api-1", contextPack: "" },
        (ev) => {
          events.push(ev);
          if (ev.type === "done" || ev.type === "quota" || ev.type === "error") resolve(events);
        },
      )
      .then(() => engine.send("oi"))
      .catch(reject);
  });
}

describe("ApiEngine", () => {
  it("emite text+done e não inclui a key nos eventos", async () => {
    const home = tempHome();
    addProfile(
      { id: "api-1", engine: "api", api: { provider: "anthropic", model: "x" } },
      home,
      { apiKey: "sk-secret" },
    );
    await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "hi" }] }));
    });
    const engine = new ApiEngine({ home, profileId: "api-1" });
    const events = await collect(engine);
    expect(events).toEqual([{ type: "text", text: "hi" }, { type: "done" }]);
    expect(JSON.stringify(events)).not.toContain("sk-secret");
  });

  it("429 vira quota", async () => {
    const home = tempHome();
    addProfile(
      { id: "api-1", engine: "api", api: { provider: "anthropic", model: "x" } },
      home,
      { apiKey: "sk-secret" },
    );
    await listen((_req, res) => {
      res.writeHead(429);
      res.end("rate");
    });
    const engine = new ApiEngine({ home, profileId: "api-1" });
    const events = await collect(engine);
    expect(events[0]?.type).toBe("quota");
  });
});
