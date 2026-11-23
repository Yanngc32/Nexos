import { describe, it, expect } from "vitest";
import { createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { cofreDir, gravarSegredo, lerSegredo, listarSegredos, redigirSegredos, varrerSegredos } from "../src/memorias/index.ts";

const arquivo = (home: string) => join(cofreDir(home), "segredos.json");

describe("memorias: cofre", () => {
  it("cofreDir fica em <home>/cofre", () => {
    const home = tempHome();
    expect(cofreDir(home)).toBe(join(home, "cofre"));
  });

  it("grava, lê e lista; nunca deixa o valor em texto puro", () => {
    const home = tempHome();
    gravarSegredo(home, "banco.senha", "hunter2-valor");
    gravarSegredo(home, "api.token", "tok-123456");
    expect(lerSegredo(home, "banco.senha")).toBe("hunter2-valor");
    expect(lerSegredo(home, "api.token")).toBe("tok-123456");
    expect(lerSegredo(home, "nada")).toBeUndefined();
    expect(listarSegredos(home).map((s) => s.nome)).toEqual(["api.token", "banco.senha"]);
    expect(listarSegredos(home)[0]!.atualizadoEm).toMatch(/^\d{4}-\d\d-\d\dT/);
    const bruto = readFileSync(arquivo(home), "utf8");
    expect(bruto).not.toContain("hunter2-valor");
    expect(bruto).not.toContain("tok-123456");
  });

  it("envelope e cifra iguais aos do Agent Code (version 2, AES-256-GCM iv|tag|corpo)", () => {
    const home = tempHome();
    gravarSegredo(home, "x", "valor-x");
    const env = JSON.parse(readFileSync(arquivo(home), "utf8"));
    expect(env.version).toBe(2);
    expect(Buffer.from(env.key, "base64")).toHaveLength(32);
    expect(env.records).toHaveLength(1);
    expect(env.records[0]).toMatchObject({ name: "x", createdAt: expect.any(String), updatedAt: expect.any(String), ciphertext: expect.any(String) });
    const buf = Buffer.from(env.records[0].ciphertext, "base64");
    const d = createDecipheriv("aes-256-gcm", Buffer.from(env.key, "base64"), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    expect(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")).toBe("valor-x");
  });

  it("trocar o valor mantém createdAt e a chave", () => {
    const home = tempHome();
    gravarSegredo(home, "x", "um");
    const antes = JSON.parse(readFileSync(arquivo(home), "utf8"));
    gravarSegredo(home, "x", "dois");
    const depois = JSON.parse(readFileSync(arquivo(home), "utf8"));
    expect(depois.key).toBe(antes.key);
    expect(depois.records).toHaveLength(1);
    expect(depois.records[0].createdAt).toBe(antes.records[0].createdAt);
    expect(lerSegredo(home, "x")).toBe("dois");
  });

  it("gravação atômica: sem sobra de .tmp na pasta", () => {
    const home = tempHome();
    gravarSegredo(home, "a", "1");
    gravarSegredo(home, "b", "2");
    expect(readdirSync(cofreDir(home))).toEqual(["segredos.json"]);
  });

  it.skipIf(process.platform === "win32")("arquivo com permissão 0600", () => {
    const home = tempHome();
    gravarSegredo(home, "a", "1");
    expect(statSync(arquivo(home)).mode & 0o777).toBe(0o600);
  });

  it("recusa nome inválido e valor vazio", () => {
    const home = tempHome();
    expect(() => gravarSegredo(home, "../fora", "v")).toThrow();
    expect(() => gravarSegredo(home, "", "v")).toThrow();
    expect(() => gravarSegredo(home, "ok", "")).toThrow();
    expect(existsSync(arquivo(home))).toBe(false);
  });

  it.each([
    ["não é JSON", "{ quebrado"],
    ["versão errada", JSON.stringify({ version: 1, key: "", records: [] })],
    ["chave curta", JSON.stringify({ version: 2, key: Buffer.alloc(8).toString("base64"), records: [] })],
    ["registros não lista", JSON.stringify({ version: 2, key: Buffer.alloc(32).toString("base64"), records: {} })],
  ])("cofre inválido (%s) não derruba: lê vazio e não grava por cima", (_nome, conteudo) => {
    const home = tempHome();
    mkdirSync(cofreDir(home), { recursive: true });
    writeFileSync(arquivo(home), conteudo);
    expect(lerSegredo(home, "x")).toBeUndefined();
    expect(listarSegredos(home)).toEqual([]);
    expect(() => gravarSegredo(home, "x", "v")).toThrow(/ilegível/);
    expect(readFileSync(arquivo(home), "utf8")).toBe(conteudo);
  });

  it("registro adulterado: lerSegredo devolve undefined sem lançar", () => {
    const home = tempHome();
    gravarSegredo(home, "x", "valor");
    const env = JSON.parse(readFileSync(arquivo(home), "utf8"));
    env.records[0].ciphertext = Buffer.alloc(40, 7).toString("base64");
    writeFileSync(arquivo(home), JSON.stringify(env));
    expect(lerSegredo(home, "x")).toBeUndefined();
    expect(listarSegredos(home).map((s) => s.nome)).toEqual(["x"]);
  });
});

describe("memorias: varredura e redação de segredos", () => {
  it.each([
    ["openai-key", "chave sk-proj-" + "a".repeat(24)],
    ["github-token", "token ghp_" + "B".repeat(24)],
    ["aws-access-key", "AKIA" + "ABCDEFGHIJKLMNOP"],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"],
    ["bearer-token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
    ["url-password", "postgres://user:s3nh4forte@db.local/app"],
    ["assigned-secret", "DB_PASSWORD=supersecreta1"],
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"],
  ])("acha %s", (tipo, texto) => {
    const achados = varrerSegredos(texto);
    expect(achados).toHaveLength(1);
    expect(achados[0]!.tipo).toBe(tipo);
    expect(achados[0]!.fim).toBeGreaterThan(achados[0]!.inicio);
  });

  it("ignora lacunas e placeholders", () => {
    expect(varrerSegredos("senha: <preencha aqui>")).toEqual([]);
    expect(varrerSegredos("password=changeme")).toEqual([]);
    expect(varrerSegredos("token={{secret:x.1}}")).toEqual([]);
    expect(varrerSegredos("a chave é {{secret:chaves.1}} no texto")).toEqual([]);
    expect(varrerSegredos("api_key=${API_KEY}")).toEqual([]);
    expect(varrerSegredos("a frase só fala de senha")).toEqual([]);
    expect(varrerSegredos("")).toEqual([]);
  });

  it("trechos ordenados e sem sobreposição; o valor é texto.slice(inicio, fim)", () => {
    const tok = "ghp_" + "C".repeat(24);
    const texto = `password=${"sk-" + "z".repeat(24)} e depois ${tok}`;
    const achados = varrerSegredos(texto);
    expect(achados.map((a) => a.tipo)).toEqual(["openai-key", "github-token"]);
    expect(texto.slice(achados[1]!.inicio, achados[1]!.fim)).toBe(tok);
    expect(achados[0]!.fim).toBeLessThanOrEqual(achados[1]!.inicio);
  });

  it("redigirSegredos troca por {{secret:<base>.N}} sem gravar no cofre", () => {
    const t1 = "ghp_" + "D".repeat(24);
    const t2 = "sk-" + "e".repeat(24);
    const r = redigirSegredos(`um ${t1}, dois ${t2}, de novo ${t1}`, "infra/vps.md");
    expect(r.texto).toBe("um {{secret:infra.vps.1}}, dois {{secret:infra.vps.2}}, de novo {{secret:infra.vps.1}}");
    expect(r.segredos).toEqual([
      { nome: "infra.vps.1", valor: t1 },
      { nome: "infra.vps.2", valor: t2 },
    ]);
  });

  it("redigirSegredos sem nada achado devolve o texto igual", () => {
    expect(redigirSegredos("nada aqui", "a")).toEqual({ texto: "nada aqui", segredos: [] });
  });
});
