import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliAuthStatus, cliAuthStatusDetalhado } from "../src/auth-status.ts";
import { addProfile } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

/** CLI falso: um `.mjs` que o daemon roda com o node (ver `isNode` em auth-status.ts). */
function cliFalso(corpo: string): string {
  const arquivo = join(mkdtempSync(join(tmpdir(), "nexo-auth-")), "claude.mjs");
  writeFileSync(arquivo, corpo, "utf8");
  return arquivo;
}

afterEach(() => {
  delete process.env.NEXOS_CLAUDE_BIN;
});

describe("cliAuthStatusDetalhado", () => {
  it("CLI que responde: devolve o status, sem falha", () => {
    const home = tempHome();
    const p = addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXOS_CLAUDE_BIN = cliFalso(`console.log(JSON.stringify({ loggedIn: true, email: "a@b.c" }));`);
    const r = cliAuthStatusDetalhado(p, home);
    expect(r.falha).toBeUndefined();
    expect(r.status).toMatchObject({ loggedIn: true, email: "a@b.c" });
  });

  it("CLI que quebra sem JSON: falha com o motivo, não 'deslogado'", () => {
    const home = tempHome();
    const p = addProfile({ id: "c2", engine: "claude" }, home, { skipBinCheck: true });
    process.env.NEXOS_CLAUDE_BIN = cliFalso(`process.stderr.write("config corrompida"); process.exit(2);`);
    const r = cliAuthStatusDetalhado(p, home);
    expect(r.status).toBeUndefined();
    expect(r.falha).toContain("config corrompida");
    // quem só quer a resposta continua recebendo undefined
    expect(cliAuthStatus(p, home)).toBeUndefined();
  });
});
