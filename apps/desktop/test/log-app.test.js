import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { criarLog, formatarLinha } = require("../log.cjs");

const LINHA = /^\S+ (DEBUG|INFO |AVISO|ERRO ) \[\w+\] /;

describe("log do app", () => {
  it("mesmo formato do motor", () => {
    const l = formatarLinha("aviso", "app", "motor sem resposta", { pid: 1 }, new Date(2026, 8, 24, 16, 53, 1, 123));
    expect(l).toMatch(/^2026-09-24T16:53:01\.123[+-]\d\d:\d\d AVISO \[app\] motor sem resposta \{"pid":1\}\n$/);
  });

  it("respeita o logNivel do config, NEXOS_LOG ganha, e nunca escreve o token", () => {
    const h = mkdtempSync(join(tmpdir(), "nexos-logapp-"));
    const token = "cd34".repeat(12);
    writeFileSync(join(h, "daemon.token"), token);
    writeFileSync(join(h, "config.json"), JSON.stringify({ logNivel: "aviso" }));
    let t = 0;
    const log = criarLog({ home: () => h, agora: () => t, env: {} });
    log.info("app", "escondido");
    log.aviso("app", `token ${token}`, { token });
    writeFileSync(join(h, "config.json"), JSON.stringify({ logNivel: "debug" }));
    t = 10_000; // passou do intervalo: relê o nível
    log.debug("saude", "agora-sim");
    const tudo = readFileSync(join(h, "daemon.log"), "utf8");
    expect(tudo).not.toContain("escondido");
    expect(tudo).toContain("agora-sim");
    expect(tudo).not.toContain(token);
    for (const l of tudo.split("\n").filter(Boolean)) expect(l).toMatch(LINHA);

    const comEnv = criarLog({ home: () => h, env: { NEXOS_LOG: "erro" } });
    comEnv.aviso("app", "abafado-pelo-env");
    expect(readFileSync(join(h, "daemon.log"), "utf8")).not.toContain("abafado-pelo-env");
  });
});
