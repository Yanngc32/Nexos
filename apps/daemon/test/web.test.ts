import { describe, expect, it } from "vitest";
import { servirWeb } from "../src/web.ts";

/** O que veio, como texto. `null` quando a rota recusa. */
function texto(caminho: string): string | null {
  const r = servirWeb(caminho);
  return r ? r.corpo.toString("utf8") : null;
}

describe("serve a interface web", () => {
  it("/app entrega o index", () => {
    const r = servirWeb("/app");
    expect(r?.tipo).toBe("text/html; charset=utf-8");
    expect(r?.corpo.toString("utf8")).toContain("<title>Nexo</title>");
  });

  it("/app/ e /app/index.html dão o mesmo", () => {
    expect(texto("/app/")).toBe(texto("/app/index.html"));
  });

  it("entrega os arquivos próprios do app, com o tipo certo", () => {
    expect(servirWeb("/app/mobile.js")?.tipo).toBe("text/javascript; charset=utf-8");
    expect(servirWeb("/app/mobile.css")?.tipo).toBe("text/css; charset=utf-8");
    expect(servirWeb("/app/nexo.webmanifest")?.tipo).toBe("application/manifest+json");
    expect(servirWeb("/app/icone.svg")?.tipo).toBe("image/svg+xml");
  });

  it("ignora a query: o navegador põe ?v= pra furar cache", () => {
    expect(texto("/app/mobile.js?v=2")).toBe(texto("/app/mobile.js"));
  });
});

describe("módulos compartilhados com o desktop", () => {
  it("entrega o que está na lista branca", () => {
    for (const nome of ["markdown.js", "format.js", "sse.js", "widget-view.js", "agent-trace.js"]) {
      expect(servirWeb(`/app/comum/${nome}`)?.tipo).toBe("text/javascript; charset=utf-8");
    }
  });

  it("o que o app importa de comum está de fato na lista", () => {
    const app = texto("/app/mobile.js") ?? "";
    const pedidos = [...app.matchAll(/from "\.\/comum\/([^"]+)"/g)].map((m) => m[1] as string);
    expect(pedidos.length).toBeGreaterThan(0);
    for (const nome of pedidos) expect(servirWeb(`/app/comum/${nome}`)).not.toBeNull();
  });

  it("o import relativo de dentro de um módulo compartilhado também resolve", () => {
    // widget-view.js faz `import { samePath } from "./format.js"`, que o
    // navegador pede como /app/comum/format.js
    expect(texto("/app/comum/widget-view.js")).toContain('from "./format.js"');
    expect(servirWeb("/app/comum/format.js")).not.toBeNull();
  });

  it("recusa arquivo do desktop fora da lista, mesmo existindo", () => {
    // existem de verdade, e não têm o que fazer no celular
    for (const nome of ["renderer.js", "main.mjs", "preload.mjs", "team-studio.js"]) {
      expect(servirWeb(`/app/comum/${nome}`)).toBeNull();
    }
  });
});

describe("travessia", () => {
  it("recusa subir de pasta, cru e escapado", () => {
    for (const tentativa of [
      "/app/../daemon/src/http.ts",
      "/app/../../package.json",
      "/app/..%2F..%2Fpackage.json",
      "/app/comum/../renderer.js",
      "/app/comum/..%2Frenderer.js",
      "/app/%2e%2e/%2e%2e/package.json",
    ]) {
      expect(servirWeb(tentativa)).toBeNull();
    }
  });

  it("recusa caminho absoluto", () => {
    expect(servirWeb("/app//etc/passwd")).toBeNull();
    expect(servirWeb("/app/C:/Windows/win.ini")).toBeNull();
  });

  it("recusa extensão que não serve, mesmo dentro da pasta", () => {
    // nada de .ts, .map, .json solto: a lista de tipos é a permissão
    expect(servirWeb("/app/pareamento.ts")).toBeNull();
  });

  it("arquivo que não existe é null, não erro", () => {
    expect(servirWeb("/app/fantasma.js")).toBeNull();
    expect(servirWeb("/app/comum/fantasma.js")).toBeNull();
  });

  it("diretório não é arquivo", () => {
    expect(servirWeb("/app/comum")).toBeNull();
  });
});

/*
 * A barra final de `/app/` é funcional, não cosmética: sem ela o documento tem
 * base `/`, o `./mobile.js` do HTML vira um pedido a `/mobile.js`, e nenhum
 * módulo carrega — a tela abre e simplesmente não responde a nada.
 */
describe("os imports do HTML resolvem dentro de /app/", () => {
  it("o HTML pede tudo relativo, então a base tem que ser a pasta", () => {
    const html = texto("/app/index.html") ?? "";
    const relativos = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1] as string);
    expect(relativos.length).toBeGreaterThan(0);
    for (const rel of relativos) {
      // é assim que o navegador resolve com base em /app/
      expect(servirWeb(`/app/${rel.replace("./", "")}`)).not.toBeNull();
    }
  });

  it("e NÃO resolvem na raiz: é por isso que /app redireciona", () => {
    expect(servirWeb("/mobile.js")).toBeNull();
  });
});
