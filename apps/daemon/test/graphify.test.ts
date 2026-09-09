import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

/*
 * `graphify` real não está instalado no ambiente de teste — mocka o
 * `execFile` pra exercitar o parse de resultado/erro sem depender do
 * binário. `graphifyDisponivel` (existência do graph.json) não precisa de
 * mock nenhum: é só `fs.existsSync`.
 */
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const {
  atualizarGrafo,
  caminhoDaArvoreDoGrafo,
  ensureGraphifyInstalled,
  ferramentasDeGraphify,
  graphifyDisponivel,
  importarGrafoManual,
  sincronizarGrafoCompartilhado,
  statusDoGrafo,
} = await import("../src/graphify.ts");

function comGrafo(): string {
  const dir = tempHome();
  mkdirSync(join(dir, "graphify-out"), { recursive: true });
  writeFileSync(join(dir, "graphify-out", "graph.json"), "{}", "utf8");
  return dir;
}

describe("graphifyDisponivel", () => {
  it("falso quando graphify-out/graph.json não existe", () => {
    expect(graphifyDisponivel(tempHome())).toBe(false);
  });

  it("verdadeiro quando o grafo já foi construído", () => {
    expect(graphifyDisponivel(comGrafo())).toBe(true);
  });
});

describe("ferramentasDeGraphify", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("lista vazia sem grafo — nada a oferecer", () => {
    expect(ferramentasDeGraphify(tempHome())()).toEqual([]);
  });

  it("duas ferramentas quando o grafo existe, com os nomes esperados", () => {
    const nomes = ferramentasDeGraphify(comGrafo())().map((f) => f.name);
    expect(nomes).toEqual(["nexo_grafo_perguntar", "nexo_grafo_explicar"]);
  });

  it("nexo_grafo_perguntar roda 'graphify query' e devolve a saída", async () => {
    const dir = comGrafo();
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null, { stdout: "resposta do grafo\n" }));
    const [perguntar] = ferramentasDeGraphify(dir)();
    const r = await perguntar!.executar({ pergunta: "onde fica o RoleChecker?" });
    expect(r).toEqual({ ok: true, texto: "resposta do grafo" });
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["query", "onde fica o RoleChecker?"]);
  });

  it("sem pergunta é erro DE FERRAMENTA, não trava nem chama o CLI", async () => {
    const [perguntar] = ferramentasDeGraphify(comGrafo())();
    const r = await perguntar!.executar({});
    expect(r.ok).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("CLI falhando vira texto pro modelo ler, não exceção", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) =>
      cb(Object.assign(new Error("comando não achado"), { stderr: "" }), undefined),
    );
    const [perguntar] = ferramentasDeGraphify(comGrafo())();
    const r = await perguntar!.executar({ pergunta: "x" });
    expect(r.ok).toBe(true);
    expect(r.texto).toMatch(/comando não achado/);
  });

  it("nexo_grafo_explicar roda 'graphify explain'", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null, { stdout: "explicação\n" }));
    const [, explicar] = ferramentasDeGraphify(comGrafo())();
    const r = await explicar!.executar({ no: "RoleChecker" });
    expect(r).toEqual({ ok: true, texto: "explicação" });
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["explain", "RoleChecker"]);
  });
});

describe("ensureGraphifyInstalled", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("já instalado: não tenta uv nem pip", async () => {
    execFileMock.mockImplementation((bin, _args, _opts, cb) => {
      if (bin === "graphify") return cb(null, { stdout: "graphify 1.0\n" });
      return cb(new Error("não devia chamar"), undefined);
    });
    await ensureGraphifyInstalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("ausente: tenta uv, e se der certo não tenta pip", async () => {
    execFileMock.mockImplementation((bin, _args, _opts, cb) => {
      if (bin === "graphify") return cb(new Error("não achado"), undefined);
      if (bin === "uv") return cb(null, { stdout: "" });
      return cb(new Error("não devia chamar pip"), undefined);
    });
    await ensureGraphifyInstalled();
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(["graphify", "uv"]);
  });

  it("uv e pip indisponíveis: nunca lança, só loga", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(new Error("não achado"), undefined));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(ensureGraphifyInstalled()).resolves.toBeUndefined();
      expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(["graphify", "uv", "pip"]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/não consegui instalar/));
    } finally {
      log.mockRestore();
    }
  });
});

describe("sincronizarGrafoCompartilhado / statusDoGrafo / importarGrafoManual", () => {
  it("sem graphDir configurado: no-op, mesmo com grafo local", () => {
    const home = tempHome();
    const projeto = comGrafo();
    sincronizarGrafoCompartilhado(projeto, home);
    expect(existsSync(join(home, "grafo"))).toBe(false);
  });

  it("com graphDir: local mais novo empurra pra pasta compartilhada", () => {
    const home = tempHome();
    const graphDir = tempHome();
    saveConfig(home, { graphDir });
    const projeto = comGrafo();
    sincronizarGrafoCompartilhado(projeto, home);
    const status = statusDoGrafo(projeto, home);
    expect(status.compartilhado).toBe(true);
    expect(status.disponivel).toBe(true);
    // achou a pasta certa (hash do projeto) dentro de graphDir, com o graph.json copiado
    const hashes = readdirSync(graphDir);
    expect(hashes.length).toBe(1);
    expect(existsSync(join(graphDir, hashes[0], "graph.json"))).toBe(true);
  });

  it("pasta compartilhada mais nova puxa pro projeto (que ainda não tinha nada)", () => {
    const home = tempHome();
    const graphDir = tempHome();
    saveConfig(home, { graphDir });
    const origem = comGrafo();
    // primeiro empurra o grafo de `origem` pra dentro de graphDir
    sincronizarGrafoCompartilhado(origem, home);

    // simula reabrir o MESMO projeto sem grafo local (apagado) — puxa de volta da pasta compartilhada
    rmSync(join(origem, "graphify-out"), { recursive: true, force: true });
    sincronizarGrafoCompartilhado(origem, home);
    expect(graphifyDisponivel(origem)).toBe(true);
  });

  it("importarGrafoManual aceita pasta que É graphify-out (com graph.json direto)", () => {
    const home = tempHome();
    const projeto = tempHome();
    const origem = comGrafo(); // aqui `comGrafo()` cria <origem>/graphify-out/graph.json
    importarGrafoManual(projeto, join(origem, "graphify-out"), home);
    expect(graphifyDisponivel(projeto)).toBe(true);
  });

  it("importarGrafoManual aceita pasta que CONTÉM graphify-out/", () => {
    const home = tempHome();
    const projeto = tempHome();
    const origem = comGrafo();
    importarGrafoManual(projeto, origem, home);
    expect(graphifyDisponivel(projeto)).toBe(true);
  });

  it("importarGrafoManual sem graph.json em lugar nenhum: 400", () => {
    const home = tempHome();
    const projeto = tempHome();
    const origemVazia = tempHome();
    expect(() => importarGrafoManual(projeto, origemVazia, home)).toThrow(/não tem graph\.json/);
  });
});

describe("atualizarGrafo", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("atualizarGrafo roda 'graphify update <projeto>' e sincroniza depois", async () => {
    const home = tempHome();
    const projeto = tempHome();
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null, { stdout: "atualizado\n" }));
    const r = await atualizarGrafo(projeto, home);
    expect(r).toEqual({ ok: true, texto: "atualizado" });
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["update", projeto]);
  });

  it("atualizarGrafo: CLI falhando vira { ok: false }, não exceção", async () => {
    const home = tempHome();
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(new Error("graphify não achado"), undefined));
    const r = await atualizarGrafo(tempHome(), home);
    expect(r.ok).toBe(false);
    expect(r.texto).toMatch(/não achado/);
  });
});

describe("caminhoDaArvoreDoGrafo", () => {
  it("aponta pro graph.html quando ele já existe — não roda CLI nenhum, o graphify já gerou", () => {
    const projeto = comGrafo();
    writeFileSync(join(projeto, "graphify-out", "graph.html"), "<html></html>", "utf8");
    const r = caminhoDaArvoreDoGrafo(projeto);
    expect(r).toEqual({ ok: true, arquivo: join(projeto, "graphify-out", "graph.html") });
  });

  it("sem graph.html ainda: ok false com motivo, sem arquivo", () => {
    const r = caminhoDaArvoreDoGrafo(comGrafo());
    expect(r.ok).toBe(false);
    expect(r.arquivo).toBe("");
    expect(r.texto).toMatch(/ainda não existe/);
  });
});
