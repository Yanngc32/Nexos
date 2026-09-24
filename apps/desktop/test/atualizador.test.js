import { createRequire } from "node:module";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const require = createRequire(import.meta.url);
const a = require("../atualizador.cjs");

const WIN = process.platform === "win32";

/** Pasta com cara de Nexos: exe, app.asar e uma marca pra saber qual versão está ali. */
function nexosFalso(dir, marca, { desinstalador = false } = {}) {
  mkdirSync(join(dir, "resources"), { recursive: true });
  writeFileSync(join(dir, "Nexos.exe"), "exe");
  writeFileSync(join(dir, "resources", "app.asar"), "asar");
  writeFileSync(join(dir, "VERSAO"), marca);
  if (desinstalador) writeFileSync(join(dir, "Uninstall Nexos.exe"), "uninst");
}

function pai() {
  // com espaço de propósito: nome de usuário com espaço é comum, e o cmd /c reinterpreta aspas
  return mkdtempSync(join(tmpdir(), "nexos upd-"));
}

function esperar(cond, ms) {
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
    }, 100);
  });
}

describe("versões e estado", () => {
  it("compara MAJOR.MINOR.PATCH como número, não como texto", () => {
    expect(a.compararVersoes("0.10.0", "0.9.9")).toBe(1);
    expect(a.compararVersoes("0.6.1", "0.6.1")).toBe(0);
    expect(a.compararVersoes("0.6.1", "0.7.0")).toBe(-1);
  });

  it("pronta só com marcador de versão MAIOR e pasta inteira", () => {
    const p = pai();
    const inst = join(p, "Nexos");
    nexosFalso(inst, "0.6.1");
    const c = a.caminhos(inst);
    expect(a.atualizacaoPronta(inst, "0.6.1")).toBeNull();
    writeFileSync(c.marcador, JSON.stringify({ versao: "0.7.0" }));
    expect(a.atualizacaoPronta(inst, "0.6.1")).toBeNull(); // sem a pasta
    nexosFalso(c.proxima, "0.7.0");
    expect(a.atualizacaoPronta(inst, "0.6.1")).toEqual({ versao: "0.7.0" });
    expect(a.atualizacaoPronta(inst, "0.7.0")).toBeNull(); // já está nela
  });

  it.runIf(WIN)("pode trocar só onde escreve, e com o exe lá", () => {
    const p = pai();
    const inst = join(p, "Nexos");
    expect(a.podeTrocar(inst)).toBe(false);
    nexosFalso(inst, "x");
    expect(a.podeTrocar(inst)).toBe(true);
  });
});

/** Zip de uma pasta com o bsdtar do Windows — o mesmo que o atualizador usa pra abrir. */
function zipar(origem, zip) {
  const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  const r = spawnSync(tar, ["-a", "-cf", zip, "-C", origem, "."], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

function fetchDe(arquivos) {
  return async (url) => {
    const nome = decodeURIComponent(url.split("/").pop());
    const corpo = arquivos[nome];
    if (corpo === undefined) return new Response("não achei", { status: 404 });
    return new Response(corpo, { status: 200, headers: { "content-length": String(corpo.length) } });
  };
}

describe.runIf(WIN)("prepararAtualizacao", () => {
  function release(versao, { sha } = {}) {
    const p = pai();
    const conteudo = join(p, "conteudo");
    nexosFalso(conteudo, versao);
    const zip = join(p, `Nexos-${versao}-win.zip`);
    zipar(conteudo, zip);
    const bytes = readFileSync(zip);
    const info = {
      version: versao,
      arquivo: `Nexos-${versao}-win.zip`,
      sha512: sha ?? createHash("sha512").update(bytes).digest("base64"),
      tamanho: bytes.length,
    };
    return fetchDe({ "nexos-portatil.json": JSON.stringify(info), [info.arquivo]: bytes });
  }

  it("baixa, confere, extrai em .proxima e marca; de novo não baixa", async () => {
    const inst = join(pai(), "Nexos");
    nexosFalso(inst, "0.6.1");
    const progresso = [];
    const r = await a.prepararAtualizacao({ instalacao: inst, versao: "0.7.0", baseUrl: "https://x", fetchImpl: release("0.7.0"), onProgresso: (n) => progresso.push(n) });
    expect(r).toEqual({ versao: "0.7.0", jaEstava: false });
    const c = a.caminhos(inst);
    expect(readFileSync(join(c.proxima, "VERSAO"), "utf8")).toBe("0.7.0");
    expect(a.atualizacaoPronta(inst, "0.6.1")).toEqual({ versao: "0.7.0" });
    expect(existsSync(c.download)).toBe(false);
    expect(progresso.at(-1)).toBe(100);
    const deNovo = await a.prepararAtualizacao({ instalacao: inst, versao: "0.7.0", baseUrl: "https://x", fetchImpl: async () => { throw new Error("não devia baixar"); } });
    expect(deNovo.jaEstava).toBe(true);
  });

  it("sha512 que não bate: recusa e não deixa nada pronto", async () => {
    const inst = join(pai(), "Nexos");
    nexosFalso(inst, "0.6.1");
    await expect(
      a.prepararAtualizacao({ instalacao: inst, versao: "0.7.0", baseUrl: "https://x", fetchImpl: release("0.7.0", { sha: "errado" }) }),
    ).rejects.toThrow(/sha512/);
    expect(a.atualizacaoPronta(inst, "0.6.1")).toBeNull();
    expect(existsSync(a.caminhos(inst).download)).toBe(false);
  });

  it("release sem o json portátil: lança (quem chama cai no instalador)", async () => {
    const inst = join(pai(), "Nexos");
    nexosFalso(inst, "0.6.1");
    await expect(a.prepararAtualizacao({ instalacao: inst, versao: "0.7.0", baseUrl: "https://x", fetchImpl: fetchDe({}) })).rejects.toThrow(/sem nexos-portatil/);
  });
});

describe.runIf(WIN)("script de troca", () => {
  /** Instalação 0.6.1 rodando + 0.7.0 pronta; `abrir` simula o Nexos novo subindo (ou não). */
  function cenario({ confirma }) {
    const p = pai();
    const inst = join(p, "Nexos");
    nexosFalso(inst, "0.6.1", { desinstalador: true });
    const c = a.caminhos(inst);
    nexosFalso(c.proxima, "0.7.0");
    writeFileSync(c.marcador, JSON.stringify({ versao: "0.7.0" }));
    const abrir = join(p, "abrir.cmd");
    // o "app novo" confirma que subiu só se a pasta no lugar for a 0.7.0 — a antiga não confirma
    writeFileSync(
      abrir,
      confirma ? `@findstr /c:"0.7.0" "${join(inst, "VERSAO")}" >nul && echo ok> "${c.subiuOk}"\r\n` : "@rem não sobe\r\n",
    );
    // processo "do app" que o script espera morrer antes de trocar
    const app = spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"]);
    return { inst, c, abrir, app };
  }

  it("troca as pastas, leva o desinstalador, abre a nova e apaga a antiga depois da confirmação", async () => {
    const { inst, c, abrir, app } = cenario({ confirma: true });
    a.aplicar({ instalacao: inst, versao: "0.7.0", versaoAntiga: "0.6.1", pid: app.pid, prazoBootS: 20, abrir });
    await esperar(() => existsSync(c.log) && readFileSync(c.log, "utf8").includes("pronto"), 40_000);
    expect(readFileSync(join(inst, "VERSAO"), "utf8")).toBe("0.7.0");
    expect(existsSync(join(inst, "Uninstall Nexos.exe"))).toBe(true);
    expect(existsSync(c.antiga)).toBe(false);
    expect(existsSync(c.proxima)).toBe(false);
    expect(existsSync(c.marcador)).toBe(false);
  }, 60_000);

  it("nova não confirma no prazo: volta a antiga e recusa a versão", async () => {
    const { inst, c, abrir, app } = cenario({ confirma: false });
    a.aplicar({ instalacao: inst, versao: "0.7.0", versaoAntiga: "0.6.1", pid: app.pid, prazoBootS: 3, abrir });
    await esperar(() => existsSync(c.log) && readFileSync(c.log, "utf8").includes("não confirmou"), 40_000);
    await esperar(() => a.recusada(inst, "0.7.0"), 20_000);
    expect(readFileSync(join(inst, "VERSAO"), "utf8")).toBe("0.6.1");
    await esperar(() => !existsSync(`${inst}.quebrada`), 20_000);
    expect(existsSync(c.antiga)).toBe(false);
  }, 60_000);
});
