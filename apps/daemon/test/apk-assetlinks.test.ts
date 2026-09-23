import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assetLinksPath, gerarAssetLinks } from "../src/apk-keystore.ts";
import { tempHome } from "./helpers.ts";

const JDK = process.env.JAVA_HOME;

/**
 * Sem isto, o TWA nunca abre em tela cheia — o Android não verifica o
 * Digital Asset Link e cai pro Chrome com a barra de endereço à mostra. Só
 * dá pra testar com keytool de verdade (é ele que extrai o fingerprint do
 * keystore), então roda só onde há JAVA_HOME.
 */
// carregar a @bubblewrap/core de verdade leva ~20s (googleapis e cia.) na primeira vez do processo
describe.runIf(JDK)("gerarAssetLinks (JDK real via JAVA_HOME)", { timeout: 60_000 }, () => {
  it("gera um assetlinks.json válido, com o fingerprint SHA-256 de verdade do keystore", async () => {
    const home = tempHome();
    const conteudo = await gerarAssetLinks(home, JDK as string, "app.nexo.mobile");
    const json = JSON.parse(conteudo);

    expect(json).toHaveLength(1);
    expect(json[0].relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(json[0].target.namespace).toBe("android_app");
    expect(json[0].target.package_name).toBe("app.nexo.mobile");
    expect(json[0].target.sha256_cert_fingerprints).toHaveLength(1);
    // formato de verdade do keytool: 32 pares hex separados por dois-pontos
    expect(json[0].target.sha256_cert_fingerprints[0]).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    // e ficou salvo em disco, é isto que a rota HTTP serve
    expect(readFileSync(assetLinksPath(home), "utf8")).toBe(conteudo);
  });

  it("chamar de novo dá o MESMO fingerprint — reusa o keystore, não gera um novo", async () => {
    const home = tempHome();
    const primeiro = await gerarAssetLinks(home, JDK as string, "app.nexo.mobile");
    const segundo = await gerarAssetLinks(home, JDK as string, "app.nexo.mobile");
    expect(segundo).toBe(primeiro);
  });

  it("applicationId diferente muda o package_name, não o fingerprint", async () => {
    const home = tempHome();
    const a = JSON.parse(await gerarAssetLinks(home, JDK as string, "app.nexo.mobile"));
    const b = JSON.parse(await gerarAssetLinks(home, JDK as string, "app.outro.id"));
    expect(a[0].target.sha256_cert_fingerprints).toEqual(b[0].target.sha256_cert_fingerprints);
    expect(b[0].target.package_name).toBe("app.outro.id");
  });
});
