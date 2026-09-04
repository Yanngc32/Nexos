import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { ensureHome, tokenPath } from "./home.ts";
import { createApp } from "./http.ts";
import { reapRunPids } from "./kill-tree.ts";

export function pidPath(home: string): string {
  return join(home, "run", "daemon.pid");
}

export type StartResult =
  | { alreadyUp: true; port: number }
  | { alreadyUp: false; port: number; token: string; server: Server };

export async function probeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export function waitClosed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.once("close", () => resolve());
  });
}

export async function startDaemon(home: string, opts?: { port?: number }): Promise<StartResult> {
  const cfg = loadConfig(home);
  const port = opts?.port !== undefined ? opts.port : cfg.port;

  if (await probeHealth(port)) {
    return { alreadyUp: true, port };
  }

  ensureHome(home);
  reapRunPids(home);

  const token = randomBytes(24).toString("hex");
  const app = createApp(home, token);

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
      if (settled) return;
      settled = true;
      writeFileSync(tokenPath(home), token, { encoding: "utf8", mode: 0o600 });
      writeFileSync(pidPath(home), String(process.pid), "utf8");
      resolve({
        alreadyUp: false,
        port: Number(info.port),
        token,
        server: server as Server,
      });
    }) as Server;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      server.close();
      if (err.code === "EADDRINUSE") {
        resolve({ alreadyUp: true, port });
        return;
      }
      reject(err);
    });
  });
}
