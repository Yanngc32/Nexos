import AdmZip from "adm-zip";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "./helpers.ts";
import { APK_DEPS_URL, apkDepsDir, carregarBubblewrap, carregarDaPastaParaTeste, resetApkDepsForTest } from "../src/apk-deps.ts";

afterEach(() => resetApkDepsForTest());

/** Zip no formato do real (node_modules/@bubblewrap/core), com um módulo falso. */
function zipFalso(): Buffer {
  const z = new AdmZip();
  z.addFile("node_modules/@bubblewrap/core/package.json", Buffer.from(JSON.stringify({ name: "@bubblewrap/core", version: "0.0.0", main: "index.js" })));
  z.addFile("node_modules/@bubblewrap/core/index.js", Buffer.from("class TwaGenerator {}\nmodule.exports = { TwaGenerator, marca: 'falsa' };\n"));
  z.addFile(
    "node_modules/@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools.js",
    Buffer.from("module.exports = { BUILD_TOOLS_VERSION: '34.0.0' };\n"),
  );
  return z.toBuffer();
}

// carregar a @bubblewrap/core de verdade leva ~20s (googleapis e cia.) na primeira vez do processo
describe("gerador de APK sob demanda", { timeout: 60_000 }, () => {
  it("em desenvolvimento carrega a devDependency, sem baixar nada", async () => {
    let baixou = false;
    const bw = await carregarBubblewrap(tempHome(), { fetchImpl: (async () => { baixou = true; throw new Error("não devia baixar"); }) as unknown as typeof fetch });
    expect(baixou).toBe(false);
    expect(typeof bw.TwaGenerator).toBe("function");
    expect(bw.BUILD_TOOLS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("baixa o zip pra ~/.nexos/apk-deps/v<n>, extrai e carrega de lá", async () => {
    const home = tempHome();
    // o caminho "baixado" (sem devDependency) testado direto: baixar + carregar da pasta
    const mod = await import("../src/apk-deps.ts");
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response(new Uint8Array(zipFalso()), { status: 200 });
    }) as unknown as typeof fetch;
    // força o download chamando a parte interna via carregarBubblewrap numa pasta sem nada:
    const dir = apkDepsDir(home);
    const baixar = (mod as unknown as { __baixarParaTeste?: (h: string, d: string, o: object) => Promise<void> }).__baixarParaTeste;
    expect(typeof baixar).toBe("function");
    let avisou = false;
    await baixar!(home, dir, { fetchImpl, aoBaixar: () => (avisou = true) });
    expect(url).toBe(APK_DEPS_URL);
    expect(avisou).toBe(true);
    expect(existsSync(join(dir, "node_modules", "@bubblewrap", "core", "index.js"))).toBe(true);
    expect(readFileSync(join(dir, "versao.txt"), "utf8")).toBe("1");
    const bw = carregarDaPastaParaTeste(dir) as unknown as { marca: string; BUILD_TOOLS_VERSION: string };
    expect(bw.marca).toBe("falsa");
    expect(bw.BUILD_TOOLS_VERSION).toBe("34.0.0");
  });

  it("download que falha ou zip sem a bubblewrap não deixa pasta pela metade", async () => {
    const home = tempHome();
    const mod = (await import("../src/apk-deps.ts")) as unknown as { __baixarParaTeste: (h: string, d: string, o: object) => Promise<void> };
    const dir = apkDepsDir(home);
    await expect(mod.__baixarParaTeste(home, dir, { fetchImpl: (async () => new Response("x", { status: 404 })) as unknown as typeof fetch })).rejects.toThrow(/HTTP 404/);
    const vazio = new AdmZip();
    vazio.addFile("node_modules/outra/index.js", Buffer.from(""));
    await expect(
      mod.__baixarParaTeste(home, dir, { fetchImpl: (async () => new Response(new Uint8Array(vazio.toBuffer()), { status: 200 })) as unknown as typeof fetch }),
    ).rejects.toThrow(/incompleto/);
    expect(existsSync(dir)).toBe(false);
  });
});
