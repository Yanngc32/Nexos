import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { startDaemon, waitClosed } from "../src/server.ts";
import { tokenPath } from "../src/home.ts";
import { saveConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

const live: Server[] = [];

afterEach(async () => {
  await Promise.all(
    live.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

function listenDummy(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

describe("startDaemon", () => {
  it("EADDRINUSE = already up e não rotaciona token", async () => {
    const home = tempHome();
    const dummy = await listenDummy((_q, r) => {
      r.statusCode = 404;
      r.end();
    });
    live.push(dummy.server);
    saveConfig(home, { port: dummy.port });
    const result = await startDaemon(home, { port: dummy.port });
    expect(result.alreadyUp).toBe(true);
    expect(existsSync(tokenPath(home))).toBe(false);
  });

  it("segundo up com health ok = already up e token igual", async () => {
    const home = tempHome();
    const first = await startDaemon(home, { port: 0 });
    expect(first.alreadyUp).toBe(false);
    if (first.alreadyUp) return;
    live.push(first.server);
    const t1 = readFileSync(tokenPath(home), "utf8");
    const second = await startDaemon(home, { port: first.port });
    expect(second.alreadyUp).toBe(true);
    expect(readFileSync(tokenPath(home), "utf8")).toBe(t1);
  });

  it("não resolve waitClosed até server.close", async () => {
    const home = tempHome();
    const started = await startDaemon(home, { port: 0 });
    expect(started.alreadyUp).toBe(false);
    if (started.alreadyUp) return;
    live.push(started.server);
    let closed = false;
    const pending = waitClosed(started.server).then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(closed).toBe(false);
    started.server.close();
    await pending;
    expect(closed).toBe(true);
    live.length = 0;
  });
});
