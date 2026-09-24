import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { resetEscutaForTest } from "../src/escuta.ts";
import { googleAuthPath } from "../src/home.ts";
import { fecharLog, iniciarLog } from "../src/log.ts";
import { projetosRoot, resetTetoCopiaForTest, trazerPastaManualProDrive } from "../src/projeto-dir.ts";
import { startDaemon } from "../src/server.ts";
import { tempHome } from "./helpers.ts";

afterEach(() => {
  fecharLog();
  resetTetoCopiaForTest();
  resetEscutaForTest();
});

/** Pasta manual com um projeto do Nexos de `n` arquivos, e o Google "conectado". */
function cenario(n: number): { home: string; destino: string } {
  const home = tempHome();
  const manual = mkdtempSync(join(tmpdir(), "nexo-manual-"));
  const proj = join(manual, "proj-a");
  mkdirSync(join(proj, "memoria"), { recursive: true });
  writeFileSync(join(proj, "meta.json"), "{}");
  for (let i = 1; i < n; i++) writeFileSync(join(proj, "memoria", `n${i}.md`), `nota ${i}`);
  saveConfig(home, { projetosDir: manual });
  writeFileSync(googleAuthPath(home), JSON.stringify({ refreshToken: "rt", email: "a@b" }));
  return { home, destino: projetosRoot(home) };
}

describe("cópia da pasta manual pro Drive", () => {
  it("2 mil arquivos: o /health responde em menos de 500 ms durante a cópia", async () => {
    const { home, destino } = cenario(2000);
    iniciarLog(home);
    const r = await startDaemon(home, { port: 0 });
    if (r.alreadyUp) throw new Error("subiu errado");
    try {
      let pior = 0;
      let checagens = 0;
      let acabou = false;
      const copia = trazerPastaManualProDrive(home, destino).finally(() => {
        acabou = true;
      });
      while (!acabou) {
        const t = performance.now();
        const res = await fetch(`http://127.0.0.1:${r.port}/health`);
        await res.text();
        pior = Math.max(pior, performance.now() - t);
        checagens += 1;
      }
      expect(await copia).toBe(2000);
      expect(checagens).toBeGreaterThan(1);
      expect(pior).toBeLessThan(500);
      const log = readFileSync(join(home, "daemon.log"), "utf8");
      expect(log).toContain("INFO  [copia] começou a trazer a pasta manual pro Drive");
      expect(log).toMatch(/INFO {2}\[copia\] terminou: 2000 arquivo\(s\) trazidos .*"arquivos":2000,"bytes":\d+,"ms":\d+/);
    } finally {
      r.server.close();
    }
  }, 60_000);

  it("20 001 arquivos: para, não grava a marca e avisa uma vez só", async () => {
    const { home, destino } = cenario(20_001);
    iniciarLog(home);
    expect(await trazerPastaManualProDrive(home, destino)).toBe(0);
    expect(await trazerPastaManualProDrive(home, destino)).toBe(0);
    expect(existsSync(join(home, "pasta-manual-migrada.json"))).toBe(false);
    expect(existsSync(join(destino, "proj-a", "memoria"))).toBe(false);
    const avisos = readFileSync(join(home, "daemon.log"), "utf8")
      .split("\n")
      .filter((l) => l.includes("AVISO [copia] teto atingido"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("mais de 20000 arquivos");
  }, 120_000);
});
