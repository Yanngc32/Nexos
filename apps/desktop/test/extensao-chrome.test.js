import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { acharChrome, origemDaExtensao, prepararExtensao } = require("../extensao-chrome.cjs");

function extensao(dir, versao, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: versao }));
  for (const [nome, conteudo] of Object.entries(extra)) writeFileSync(join(dir, nome), conteudo);
}

describe("prepararExtensao", () => {
  it("copia na 1ª vez, não recopia a mesma versão e troca inteira na versão nova", () => {
    const tmp = mkdtempSync(join(tmpdir(), "chx-"));
    const origem = join(tmp, "origem");
    const destino = join(tmp, "destino");
    extensao(origem, "0.1.0", { "velho.js": "1" });
    expect(prepararExtensao(origem, destino)).toEqual({ pasta: destino, versao: "0.1.0", copiou: true });
    expect(prepararExtensao(origem, destino).copiou).toBe(false);

    const origem2 = join(tmp, "origem2");
    extensao(origem2, "0.2.0", { "novo.js": "2" });
    expect(prepararExtensao(origem2, destino)).toMatchObject({ versao: "0.2.0", copiou: true });
    expect(existsSync(join(destino, "velho.js"))).toBe(false);
    expect(readFileSync(join(destino, "novo.js"), "utf8")).toBe("2");
  });

  it("na subida do app, só atualiza quem já instalou", () => {
    const tmp = mkdtempSync(join(tmpdir(), "chx-"));
    extensao(join(tmp, "o"), "0.1.0");
    const r = prepararExtensao(join(tmp, "o"), join(tmp, "d"), { soSeJaInstalada: true });
    expect(r).toMatchObject({ versao: null, copiou: false });
    expect(existsSync(join(tmp, "d"))).toBe(false);
  });

  it("sem extensão no app, erro que diz o que fazer", () => {
    const tmp = mkdtempSync(join(tmpdir(), "chx-"));
    expect(() => prepararExtensao(join(tmp, "nada"), join(tmp, "d"))).toThrow(/pnpm chrome/);
  });
});

describe("origemDaExtensao / acharChrome", () => {
  it("empacotado lê de resources; dev, do dist do build", () => {
    expect(origemDaExtensao({ isPackaged: true, resourcesPath: "R", here: "H" })).toBe(join("R", "chrome-extension"));
    expect(origemDaExtensao({ isPackaged: false, resourcesPath: "R", here: join("x", "desktop") })).toBe(
      join("x", "chrome-extension", "dist", "nexos-chrome"),
    );
  });

  it("procura por máquina e por usuário", () => {
    const alvo = join("L", "Google", "Chrome", "Application", "chrome.exe");
    expect(acharChrome({ PROGRAMFILES: "P", LOCALAPPDATA: "L" }, (p) => p === alvo)).toBe(alvo);
    expect(acharChrome({ PROGRAMFILES: "P" }, () => false)).toBeNull();
  });
});
