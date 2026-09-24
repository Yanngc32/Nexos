import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listarProcessos, matarProcesso } from "../src/processos.ts";
import { resetServicesForTest, startService, stopAllServices } from "../src/services.ts";
import { tempHome } from "./helpers.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-service.mjs");
const node = JSON.stringify(process.execPath);

const soltos: ChildProcess[] = [];

afterEach(() => {
  stopAllServices();
  resetServicesForTest();
  for (const p of soltos.splice(0)) p.kill();
});

function esperar(cond: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const fim = Date.now() + ms;
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() > fim) {
        clearInterval(t);
        reject(new Error("timeout"));
      }
    }, 25);
  });
}

/** Processo vivo "esquecido" com um .pid em <home>/run, como o daemon deixa. */
async function orfao(home: string, arquivo: string): Promise<ChildProcess> {
  const p = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "ignore"] });
  soltos.push(p);
  await new Promise<void>((r) => p.stdout?.once("data", () => r()));
  mkdirSync(join(home, "run"), { recursive: true });
  writeFileSync(join(home, "run", arquivo), String(p.pid), "utf8");
  return p;
}

describe("listarProcessos", () => {
  it("serviço rodando aparece com projeto e porta, de qualquer projeto; matar para ele", async () => {
    const home = tempHome();
    const dir = tempHome();
    writeFileSync(join(dir, "nexos.json"), JSON.stringify({ services: [{ id: "svc", name: "Meu", cmd: `${node} ${JSON.stringify(fixture)}` }] }), "utf8");
    startService(dir, "svc", home);
    const [p] = listarProcessos(home);
    expect(p).toMatchObject({ tipo: "servico", nome: "Meu", servicoId: "svc", projectPath: dir });
    expect(matarProcesso(home, p!.chave)).toBe(true);
    expect(listarProcessos(home)).toEqual([]);
  });

  it.runIf(process.platform === "win32")("pid esquecido em run/ vira órfão; matar derruba e apaga o .pid", async () => {
    const home = tempHome();
    const p = await orfao(home, "engine-t-parado.pid");
    const lista = listarProcessos(home);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ tipo: "orfao", pid: p.pid, motivo: expect.stringMatching(/motor/) });
    expect(lista[0]!.nome).toMatch(/node/i);
    expect(matarProcesso(home, lista[0]!.chave)).toBe(true);
    await esperar(() => p.exitCode !== null || p.signalCode !== null);
    expect(existsSync(join(home, "run", "engine-t-parado.pid"))).toBe(false);
  });

  it.runIf(process.platform === "win32")("PID reusado (processo nasceu depois do .pid) não é nosso e não entra", async () => {
    const home = tempHome();
    await orfao(home, "svc-velho.pid");
    const antigo = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(join(home, "run", "svc-velho.pid"), antigo, antigo);
    expect(listarProcessos(home)).toEqual([]);
  });

  it.runIf(process.platform === "win32")("daemon.pid é o próprio Nexos: nunca vira órfão", async () => {
    const home = tempHome();
    await orfao(home, "daemon.pid");
    expect(listarProcessos(home)).toEqual([]);
  });

  it("pid morto não aparece, e chave de fora da lista não mata nada", () => {
    const home = tempHome();
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(join(home, "run", "engine-t-morto.pid"), "999999", "utf8");
    expect(listarProcessos(home)).toEqual([]);
    expect(matarProcesso(home, `orfao:engine-t-morto.pid:${process.pid}`)).toBe(false);
  });
});
