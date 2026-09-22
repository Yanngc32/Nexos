import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apkDir, construirApk, estadoAtualBuild, resetApkBuildForTest } from "../src/apk-build.ts";
import { tempHome } from "./helpers.ts";

beforeEach(resetApkBuildForTest);

const ORIG_JAVA_HOME = process.env.JAVA_HOME;
const ORIG_ANDROID_HOME = process.env.ANDROID_HOME;
const ORIG_ANDROID_SDK_ROOT = process.env.ANDROID_SDK_ROOT;

afterEach(() => {
  if (ORIG_JAVA_HOME === undefined) delete process.env.JAVA_HOME;
  else process.env.JAVA_HOME = ORIG_JAVA_HOME;
  if (ORIG_ANDROID_HOME === undefined) delete process.env.ANDROID_HOME;
  else process.env.ANDROID_HOME = ORIG_ANDROID_HOME;
  if (ORIG_ANDROID_SDK_ROOT === undefined) delete process.env.ANDROID_SDK_ROOT;
  else process.env.ANDROID_SDK_ROOT = ORIG_ANDROID_SDK_ROOT;
});

function esperar(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ateSair(home: string, de: string, timeoutMs = 2000) {
  const t0 = Date.now();
  while (estadoAtualBuild(home).fase === de) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`ainda em "${de}" depois de ${timeoutMs}ms`);
    await esperar(10);
  }
}

describe("construirApk sem SDK do Android (ambiente sem ANDROID_HOME/ANDROID_SDK_ROOT)", () => {
  beforeEach(() => {
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
  });

  it("falha rápido, com mensagem clara, ANTES de gerar keystore ou projeto nenhum", async () => {
    const home = tempHome();
    construirApk(home, { hostname: "maquina.tail1234.ts.net", port: 7433 });
    await ateSair(home, "construindo");
    const e = estadoAtualBuild(home);
    expect(e).toMatchObject({ fase: "erro" });
    expect((e as { motivo: string }).motivo).toMatch(/SDK do Android/);
    // não deve ter tocado o disco em ~/.nexos/apk pra nada — falhou antes de qualquer passo
    expect(existsSync(apkDir(home))).toBe(false);
  });

  it("uma tentativa de cada vez: chamar de novo enquanto a primeira ainda não voltou não faz nada extra", async () => {
    const home = tempHome();
    construirApk(home, { hostname: "a.tail1234.ts.net", port: 1 });
    construirApk(home, { hostname: "b.tail1234.ts.net", port: 2 }); // ignorado
    await ateSair(home, "construindo");
    expect(estadoAtualBuild(home)).toMatchObject({ fase: "erro" });
  });

  it("depois de terminar (mesmo com erro), uma nova chamada tenta de novo", async () => {
    const home = tempHome();
    construirApk(home, { hostname: "a.tail1234.ts.net", port: 1 });
    await ateSair(home, "construindo");
    construirApk(home, { hostname: "a.tail1234.ts.net", port: 1 });
    await ateSair(home, "construindo");
    expect(estadoAtualBuild(home)).toMatchObject({ fase: "erro" });
  });
});

describe("estadoAtualBuild", () => {
  it("sem nada salvo: ocioso", () => {
    expect(estadoAtualBuild(tempHome())).toEqual({ fase: "ocioso" });
  });

  it("relê atual.json do disco (sobrevive a reiniciar o daemon) — só se o arquivo do apk ainda existir", () => {
    const home = tempHome();
    mkdirSync(apkDir(home), { recursive: true });
    const apkFalso = join(apkDir(home), "nexo.apk");
    writeFileSync(apkFalso, "conteudo-falso");
    const salvo = { caminho: apkFalso, sha256: "abc123", hostname: "maquina.tail1234.ts.net", versao: "20260101000000", criadoEm: 1 };
    writeFileSync(join(apkDir(home), "atual.json"), JSON.stringify(salvo), "utf8");
    expect(estadoAtualBuild(home)).toEqual({ fase: "pronto", ...salvo });
  });

  it("atual.json aponta pra um .apk que sumiu do disco: não finge que está pronto", () => {
    const home = tempHome();
    mkdirSync(apkDir(home), { recursive: true });
    const salvo = {
      caminho: join(apkDir(home), "nexo-que-nao-existe.apk"),
      sha256: "abc123",
      hostname: "maquina.tail1234.ts.net",
      versao: "20260101000000",
      criadoEm: 1,
    };
    writeFileSync(join(apkDir(home), "atual.json"), JSON.stringify(salvo), "utf8");
    expect(estadoAtualBuild(home)).toEqual({ fase: "ocioso" });
  });

  it("atual.json corrompido: não lança, segue ocioso", () => {
    const home = tempHome();
    mkdirSync(apkDir(home), { recursive: true });
    writeFileSync(join(apkDir(home), "atual.json"), "{ isto não é json", "utf8");
    expect(estadoAtualBuild(home)).toEqual({ fase: "ocioso" });
  });
});
