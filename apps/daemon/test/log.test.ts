import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { tokenPath } from "../src/home.ts";
import { fecharLog, formatarLinha, iniciarLog, log, recarregarNivel, registrarErrosSemDono } from "../src/log.ts";
import { vigiarCongelamento } from "../src/congelamento.ts";
import { tempHome } from "./helpers.ts";

const LINHA = /^\S+ (DEBUG|INFO |AVISO|ERRO ) \[\w+\] /;

function linhas(home: string, arq = "daemon.log"): string[] {
  const p = join(home, arq);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

afterEach(() => {
  fecharLog();
  delete process.env.NEXOS_LOG;
});

describe("log", () => {
  it("formato: hora local com fuso, nível em 5, origem e dados numa linha", () => {
    const l = formatarLinha("aviso", "motor", "porta 7777 ocupada", { pid: 1234 }, new Date(2026, 8, 24, 16, 53, 1, 123));
    expect(l).toMatch(/^2026-09-24T16:53:01\.123[+-]\d\d:\d\d AVISO \[motor\] porta 7777 ocupada \{"pid":1234\}\n$/);
    expect(formatarLinha("info", "sync", "a\nb")).toMatch(LINHA);
    expect(formatarLinha("info", "sync", "a\nb").trimEnd()).not.toContain("\n");
  });

  it("info esconde debug; NEXOS_LOG=debug liga; config troca sem reiniciar", () => {
    const home = tempHome();
    iniciarLog(home);
    log.debug("saude", "escondido");
    log.info("saude", "visivel");
    expect(linhas(home).join("\n")).not.toContain("escondido");
    expect(linhas(home).join("\n")).toContain("visivel");

    saveConfig(home, { logNivel: "debug" });
    recarregarNivel(home); // o que o PUT /v1/config faz
    log.debug("saude", "agora-sim");
    expect(linhas(home).join("\n")).toContain("agora-sim");

    saveConfig(home, { logNivel: "erro" });
    process.env.NEXOS_LOG = "debug";
    recarregarNivel(home);
    log.debug("saude", "env-ganha");
    expect(linhas(home).join("\n")).toContain("env-ganha");
    for (const l of linhas(home)) expect(l).toMatch(LINHA);
  });

  it("rotação: 12 MB viram daemon.log, .1 e .2, nenhum passa de 5 MB", () => {
    const home = tempHome();
    iniciarLog(home);
    const bloco = "x".repeat(8000);
    for (let i = 0; i < (12 * 1024 * 1024) / 8000; i++) log.info("copia", bloco);
    for (const s of ["daemon.log", "daemon.log.1", "daemon.log.2"]) {
      expect(existsSync(join(home, s)), s).toBe(true);
      expect(statSync(join(home, s)).size).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
    expect(existsSync(join(home, "daemon.log.3"))).toBe(false);
  });

  it("com o .3 cheio, o mais antigo some", () => {
    const home = tempHome();
    iniciarLog(home, { maxBytes: 1000 });
    log.info("copia", "PRIMEIRA");
    for (let i = 0; i < 60; i++) log.info("copia", "y".repeat(200));
    expect(existsSync(join(home, "daemon.log.3"))).toBe(true);
    expect(existsSync(join(home, "daemon.log.4"))).toBe(false);
    const tudo = ["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"].flatMap((a) => linhas(home, a)).join("\n");
    expect(tudo).not.toContain("PRIMEIRA");
  });

  it("nunca escreve o token do home", () => {
    const home = tempHome();
    const token = "ab12".repeat(12);
    writeFileSync(tokenPath(home), token, "utf8");
    iniciarLog(home);
    log.info("motor", `url com ${token}`, { token, refresh_token: "rt-segredo", cabecalho: `Bearer ${token}` });
    log.aviso("drive", "authorization", { authorization: "Bearer abcdefghijk" });
    const tudo = linhas(home).join("\n");
    expect(tudo).not.toContain(token);
    expect(tudo).not.toContain("rt-segredo");
    expect(tudo).not.toContain("abcdefghijk");
    expect(tudo).toContain('"token":"***"');
  });

  it("exceção sem dono vira linha ERRO com a stack", () => {
    const home = tempHome();
    iniciarLog(home);
    registrarErrosSemDono();
    const e = new Error("explodiu");
    (process.emit as (ev: string, ...a: unknown[]) => boolean)("uncaughtExceptionMonitor", e, "uncaughtException");
    const l = linhas(home).find((x) => x.includes("explodiu"));
    expect(l).toMatch(/^\S+ ERRO  \[motor\] exceção sem dono: explodiu /);
    expect(l).toContain('"stack":"Error: explodiu');
  });

  it("congelamento: event loop parado vira aviso com a duração", async () => {
    const home = tempHome();
    iniciarLog(home);
    const parar = vigiarCongelamento({ tickMs: 50, limiteMs: 300 });
    await new Promise((r) => setTimeout(r, 120));
    const ate = Date.now() + 600;
    while (Date.now() < ate) {
      /* trava o loop de propósito */
    }
    await new Promise((r) => setTimeout(r, 120));
    parar();
    const avisos = linhas(home).filter((l) => l.includes("[congelamento]"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/^\S+ AVISO \[congelamento\] motor ficou \d+(\.\d)? s sem responder \{"ms":\d+\}$/);
  });
});
