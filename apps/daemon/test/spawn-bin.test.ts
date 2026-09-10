import { describe, it, expect } from "vitest";
import { isNodeScript, resolveShimEntry } from "../src/spawn-bin.ts";
import { resolveTsxCli, daemonRoot } from "../scripts/resolve-tsx.mjs";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isNodeScript", () => {
  it("reconhece .mjs no Windows", () => {
    expect(isNodeScript("C:\\foo\\bar\\fake-claude.mjs")).toBe(true);
    expect(isNodeScript("C:\\foo\\bar\\fake-claude.MJS")).toBe(true);
    expect(isNodeScript("claude")).toBe(false);
    expect(isNodeScript("claude.cmd")).toBe(false);
  });
});

/*
 * `resolveShimEntry` existe porque o `.cmd` que o `npm install -g` gera no Windows
 * tem `&`/`||` no PRÓPRIO corpo, ANTES de `%*` — todo argv passado a ele (a URL do
 * MCP do codex sempre tem `&`) atravessa DOIS parses de cmd.exe e quebra no
 * segundo, sem escape que resolva os dois ao mesmo tempo (medido contra o `codex`
 * de verdade — ver spawn-bin.ts). A correção é não tocar o `.cmd`: ler o `.js`
 * real que ele invoca e chamar `node` nele direto. Fixture abaixo é o texto do
 * `codex.cmd` real, byte a byte (npm 11, Windows), não um template inventado.
 */
describe("resolveShimEntry", () => {
  function shimReal(dir: string, jsRelPath: string): string {
    return [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      "",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${jsRelPath}" %*`,
      "",
    ].join("\r\n");
  }

  it("acha o .js real por trás do shim .cmd de verdade do npm", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexo-shim-"));
    mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    const entryReal = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    writeFileSync(entryReal, "// fake entry\n", "utf8");
    const cmdPath = join(dir, "codex.cmd");
    writeFileSync(cmdPath, shimReal(dir, "node_modules\\@openai\\codex\\bin\\codex.js"), "utf8");
    expect(resolveShimEntry(cmdPath)).toBe(entryReal);
  });

  it("sem o .js apontado no disco, não inventa caminho", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexo-shim-"));
    const cmdPath = join(dir, "codex.cmd");
    // aponta pro .js mas o arquivo nunca foi criado — instalação incompleta/estranha
    writeFileSync(cmdPath, shimReal(dir, "node_modules\\@openai\\codex\\bin\\codex.js"), "utf8");
    expect(resolveShimEntry(cmdPath)).toBeUndefined();
  });

  it("arquivo sem o padrão de shim do npm (ou inexistente) não vira crash, só undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexo-shim-"));
    const cmdPath = join(dir, "algo.cmd");
    writeFileSync(cmdPath, "@ECHO off\r\necho isto nao e um cmd-shim do npm\r\n", "utf8");
    expect(resolveShimEntry(cmdPath)).toBeUndefined();
    expect(resolveShimEntry(join(dir, "nao-existe.cmd"))).toBeUndefined();
  });
});

describe("resolveTsxCli", () => {
  it("acha tsx em apps/daemon/node_modules/tsx", () => {
    const cli = resolveTsxCli(daemonRoot());
    expect(cli.replaceAll("\\", "/")).toMatch(/node_modules\/tsx\/dist\/cli\.mjs$/);
    expect(existsSync(cli)).toBe(true);
  });
});
