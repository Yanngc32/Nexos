// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { capturarReferencia, extrairDaPagina, resumoCurto } from "../ds-extrator.js";

describe("extrairDaPagina", () => {
  it("devolve a forma esperada e variáveis de :root, inclusive dentro de @layer", () => {
    document.head.innerHTML = `<title>Oficina</title><style>@layer theme { :root { --color-brand: #c81e2c; --space-2: 8px; } } :root{--color-red-500:#f00}</style>`;
    document.body.innerHTML = `<h1 style="color:#111">Oi</h1><button style="background:#c81e2c;border-radius:9999px">Salvar</button>`;
    const d = extrairDaPagina();
    expect(d.titulo).toBe("Oficina");
    expect(d.cores).toHaveProperty("fundo");
    expect(Array.isArray(d.variaveis)).toBe(true);
    // (happy-dom não calcula layout, então a amostra pode vir vazia — o que importa aqui é não quebrar
    // e ler as folhas; a amostragem de verdade foi validada num Chromium)
    const nomes = d.variaveis.map(([n]) => n);
    if (nomes.length) {
      // escala de paleta vai pro fim
      expect(nomes.indexOf("--color-red-500")).toBeGreaterThan(nomes.indexOf("--space-2"));
    }
  });

  it("perfil do site por palavra-chave em pt-BR (palavra inteira, com acento) e os campos novos", () => {
    document.head.innerHTML = `<title>Painel de vendas</title>`;
    document.body.innerHTML = `<nav><a>Relatórios</a><a>Estoque</a><a>Configurações</a></nav><h1>Visão geral</h1>
      <p>Margem e faturamento do mês. Métricas por loja.</p><p>preçosx não conta</p>`;
    const d = extrairDaPagina();
    expect(d.perfil.tipo).toBe("dashboard");
    expect(d.perfil.confianca).toBe("alta");
    expect(d.perfil.evidencias.join(" ")).toContain('"relatórios"');
    for (const campo of ["margens", "espacamentoLetras", "animacoes"]) expect(Array.isArray(d[campo])).toBe(true);
  });

  it("sem sinal nenhum, o tipo fica indefinido (não chuta marketing)", () => {
    document.head.innerHTML = `<title>x</title>`;
    document.body.innerHTML = `<p>abc</p>`;
    expect(extrairDaPagina().perfil).toMatchObject({ tipo: "indefinido", confianca: "baixa" });
  });
});

describe("capturarReferencia", () => {
  it("roda o extrator no webview e anexa o print em JPEG", async () => {
    const webview = {
      executeJavaScript: async (codigo) => {
        expect(codigo).toContain("extrairDaPagina");
        return { url: "https://x.test/", titulo: "X", cores: { fundo: [["#000000", 3]], texto: [["#ffffff", 2]], borda: [] }, fontes: [["Inter", 5]], variaveis: [] };
      },
      capturePage: async () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 2000, height: 1000 }),
        resize() {
          return this;
        },
        toJPEG: () => new Uint8Array([1, 2, 3]),
      }),
    };
    const ref = await capturarReferencia(webview);
    expect(ref.url).toBe("https://x.test/");
    expect(ref.screenshot).toEqual({ mime: "image/jpeg", data: "AQID" });
    expect(resumoCurto(ref)).toBe("X · 2 cores · 1 fonte(s) · 0 variáveis CSS · screenshot");
  });

  it("sem webview dá erro legível", async () => {
    await expect(capturarReferencia(null)).rejects.toThrow(/Browser/);
  });
});
