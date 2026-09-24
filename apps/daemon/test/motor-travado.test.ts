import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { resetEscutaForTest } from "../src/escuta.ts";
import { reapRunPids } from "../src/kill-tree.ts";
import { fecharLog, iniciarLog } from "../src/log.ts";
import { probeHealth, startDaemon } from "../src/server.ts";
import { tempHome } from "./helpers.ts";

const vivos: ChildProcess[] = [];
const servidores: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  fecharLog();
  resetEscutaForTest();
  for (const c of vivos.splice(0)) c.kill();
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servidores.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function dorminhoco(): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  vivos.push(c);
  return c;
}

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Aceita a conexão e nunca responde: é o motor com o event loop parado. */
function servidorMudo(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((sock) => sockets.push(sock));
    servidores.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
  });
}

describe("motor travado", () => {
  it("probeHealth distingue fechado de sem resposta", async () => {
    const mudo = await servidorMudo();
    expect(await probeHealth(mudo, 300)).toBe("sem_resposta");
    const livre = await servidorMudo();
    await new Promise<void>((r) => servidores.pop()!.close(() => r()));
    expect(await probeHealth(livre, 300)).toBe("fechado");
  });

  it("porta ocupada sem resposta: startDaemon diz travado com o PID e não mata nada de run/", async () => {
    const home = tempHome();
    iniciarLog(home);
    const porta = await servidorMudo();
    saveConfig(home, { port: porta });
    const motor = dorminhoco();
    const agente = dorminhoco();
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "daemon.pid"), String(motor.pid), "utf8");
    writeFileSync(join(home, "run", "engine-t1.pid"), String(agente.pid), "utf8");

    const r = await startDaemon(home, { port: porta });
    expect(r).toEqual({ alreadyUp: true, port: porta, travado: true, pid: motor.pid });
    expect(vivo(motor.pid!)).toBe(true);
    expect(vivo(agente.pid!)).toBe(true);
    expect(existsSync(join(home, "run", "engine-t1.pid"))).toBe(true);
    const logado = readFileSync(join(home, "daemon.log"), "utf8");
    expect(logado).toContain(`AVISO [motor] porta ${porta} ocupada, PID ${motor.pid} não responde`);
    expect(logado).toContain('"codigoSaida":3');
  });

  it("reapRunPids pula daemon.pid pelo nome e mata o resto", async () => {
    const home = tempHome();
    iniciarLog(home);
    const motor = dorminhoco();
    const agente = dorminhoco();
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "daemon.pid"), String(motor.pid), "utf8");
    writeFileSync(join(home, "run", "engine-t2.pid"), String(agente.pid), "utf8");
    const saiu = new Promise((r) => agente.once("exit", r));
    reapRunPids(home);
    await saiu;
    expect(vivo(motor.pid!)).toBe(true);
    expect(existsSync(join(home, "run", "daemon.pid"))).toBe(true);
    expect(existsSync(join(home, "run", "engine-t2.pid"))).toBe(false);
    const logado = readFileSync(join(home, "daemon.log"), "utf8");
    expect(logado).toContain("INFO  [motor] reapRunPids pulou daemon.pid");
    expect(logado).toContain(`INFO  [motor] reapRunPids matou PID ${agente.pid}`);
  });
});
