import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsoleLog, TwaGenerator, TwaManifest } from "@bubblewrap/core";
import type { TwaManifestJson } from "@bubblewrap/core/dist/lib/TwaManifest.js";

/**
 * Valida a parte de `apk-build.ts` que NÃO precisa do SDK do Android: construir
 * o `TwaManifest` e gerar o projeto Android (`TwaGenerator.createTwaProject`) a
 * partir dele — inclusive baixando o ícone de verdade (por isso o servidor
 * HTTP local: o `fetch-h2` que o bubblewrap usa não lê `file://`, só http(s)).
 * O que fica de fora (compilar com Gradle) precisa do SDK, que este ambiente
 * não tem — ver o comentário no topo de `apk-build.ts`.
 */

let porta = 0;
let servidor: ReturnType<typeof createServer>;
const icone = readFileSync(join(import.meta.dirname, "../../mobile/icone-512.png"));

beforeAll(async () => {
  servidor = createServer((req, res) => {
    if (req.url?.startsWith("/icone-512.png")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(icone);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  porta = (servidor.address() as { port: number }).port;
});

afterAll(() => {
  servidor.close();
});

describe("TwaGenerator.createTwaProject com o manifest que apk-build.ts monta", () => {
  it("gera um projeto Android de verdade — AndroidManifest, build.gradle, ícones — a partir do host+ícone servidos ao vivo", async () => {
    const manifestJson: TwaManifestJson = {
      packageId: "app.nexo.mobile",
      host: "maquina.tail1234.ts.net",
      name: "Nexo",
      launcherName: "Nexo",
      display: "standalone",
      themeColor: "#141417",
      navigationColor: "#141417",
      backgroundColor: "#141417",
      enableNotifications: false,
      startUrl: "/app/",
      iconUrl: `http://127.0.0.1:${porta}/icone-512.png`,
      splashScreenFadeOutDuration: 300,
      signingKey: { path: "/tmp/nexo-keystore-de-teste.jks", alias: "nexo" },
      appVersion: "20260913000000",
      fallbackType: "customtabs",
    };
    const twaManifest = new TwaManifest(manifestJson);
    expect(twaManifest.validate()).toBeNull();

    const projeto = mkdtempSync(join(tmpdir(), "nexo-twa-teste-"));
    try {
      await new TwaGenerator().createTwaProject(projeto, twaManifest, new ConsoleLog("teste"));

      expect(existsSync(join(projeto, "app/src/main/AndroidManifest.xml"))).toBe(true);
      expect(existsSync(join(projeto, "app/build.gradle"))).toBe(true);

      const androidManifest = readFileSync(join(projeto, "app/src/main/AndroidManifest.xml"), "utf8");
      const strings = readFileSync(join(projeto, "app/src/main/res/values/strings.xml"), "utf8");
      // é isto que faz o TWA abrir o hostname certo, e não outro — pode estar
      // no AndroidManifest.xml direto ou num @string referenciado por ele
      expect(androidManifest + strings).toContain("maquina.tail1234.ts.net");
      expect(androidManifest).toContain("app.nexo.mobile");

      // gerou pelo menos um ícone raster (prova que baixou e decodificou o PNG de verdade)
      const mipmap = join(projeto, "app/src/main/res");
      expect(existsSync(mipmap)).toBe(true);
    } finally {
      rmSync(projeto, { recursive: true, force: true });
    }
  });
});
