// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  agruparVars,
  ajustarATela,
  baseHrefDoProjeto,
  cardsDeFundamentos,
  cardsPendentes,
  elementosParaConstruir,
  urlsDeFontes,
  cssDoBruto,
  digitaisDe,
  elementosNovos,
  paraHexInput,
  setNoCaminho,
  temasDoCss,
  textoParaBruto,
  tokensUsados,
  varsMudadas,
  zoomEm,
} from "../canvas-ds.js";

describe("tokensUsados", () => {
  it("pega cada var(--x) uma vez", () => {
    expect([...tokensUsados("a{color:var(--c);b:var( --c );m:var(--s-2, 4px)}")]).toEqual(["--c", "--s-2"]);
  });
});

describe("setNoCaminho", () => {
  it("troca o $value sem mexer na árvore original", () => {
    const t = { color: { $type: "color", bg: { $value: "#000" } } };
    const n = setNoCaminho(t, "color.bg", "#fff");
    expect(n.color.bg.$value).toBe("#fff");
    expect(t.color.bg.$value).toBe("#000");
  });

  it("entra no $value de composto", () => {
    const t = { titulo: { $type: "typography", $value: { fontSize: "32px", fontWeight: 700 } } };
    expect(setNoCaminho(t, "titulo.fontSize", "40px").titulo.$value).toEqual({ fontSize: "40px", fontWeight: 700 });
  });

  it("caminho inexistente não cria nada", () => {
    expect(setNoCaminho({ a: { $value: 1 } }, "x.y", 2)).toEqual({ a: { $value: 1 } });
  });
});

describe("textoParaBruto / cssDoBruto", () => {
  it("mantém o formato do original", () => {
    expect(textoParaBruto("24px", { value: 16, unit: "px" })).toEqual({ value: 24, unit: "px" });
    expect(textoParaBruto("600", 400)).toBe(600);
    expect(textoParaBruto('"IBM Plex Sans", system-ui', ["Inter"])).toEqual(["IBM Plex Sans", "system-ui"]);
    expect(textoParaBruto(" #fff ", "#000")).toBe("#fff");
  });

  it("gera o CSS do override", () => {
    expect(cssDoBruto({ value: 24, unit: "px" })).toBe("24px");
    expect(cssDoBruto(["IBM Plex Sans", "system-ui"])).toBe('"IBM Plex Sans", system-ui');
    expect(cssDoBruto("{color.bg}")).toBe("var(--color-bg)");
  });
});

describe("paraHexInput", () => {
  it("só hex simples vira valor de <input type=color>", () => {
    expect(paraHexInput("#C81E2C")).toBe("#c81e2c");
    expect(paraHexInput("#abc")).toBe("#aabbcc");
    expect(paraHexInput("var(--x)")).toBeNull();
    expect(paraHexInput("rgb(0 0 0)")).toBeNull();
  });
});

describe("zoomEm / ajustarATela", () => {
  it("o ponto sob o cursor fica parado", () => {
    const v = zoomEm({ escala: 1, x: 0, y: 0 }, 100, 50, 2);
    expect(v.escala).toBe(2);
    // o ponto do board sob (100,50) antes do zoom continua sob (100,50) depois
    expect((100 - v.x) / v.escala).toBe(100);
    expect((50 - v.y) / v.escala).toBe(50);
  });

  it("respeita os limites", () => {
    expect(zoomEm({ escala: 2.4, x: 0, y: 0 }, 0, 0, 10).escala).toBe(2.5);
    expect(zoomEm({ escala: 0.25, x: 0, y: 0 }, 0, 0, 0.1).escala).toBe(0.2);
  });

  it("ajustar cabe o board na área sem passar de 100%", () => {
    expect(ajustarATela(1560, 3000, 1000, 800).escala).toBeCloseTo((800 - 64) / 3000);
    expect(ajustarATela(400, 300, 2000, 2000).escala).toBe(1);
  });
});

describe("elementosNovos", () => {
  function raiz(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d;
  }

  it("acha só o que entrou ou mudou, e não repete o filho de quem já entrou", () => {
    const antes = digitaisDe(raiz(`<div class="a"><b>x</b></div><p>oi</p>`));
    const depois = raiz(`<div class="a"><b>x</b></div><p>oi</p><section><span>novo</span></section><p>oi mudado</p>`);
    const novos = elementosNovos(antes, depois);
    expect(novos.map((e) => e.tagName)).toEqual(["SECTION", "P"]);
  });

  it("conta repetição: segundo botão igual também é novo", () => {
    const antes = digitaisDe(raiz(`<button>a</button>`));
    const novos = elementosNovos(antes, raiz(`<button>a</button><button>a</button>`));
    expect(novos).toHaveLength(1);
  });

  it("ignora <style>", () => {
    expect(elementosNovos([], raiz(`<style>.x{}</style>`))).toEqual([]);
  });
});

describe("varsMudadas / temasDoCss", () => {
  it("detecta valor alterado, novo e removido", () => {
    const a = [{ nome: "--a", valor: "1" }, { nome: "--b", valor: "2" }];
    const b = [{ nome: "--a", valor: "1" }, { nome: "--b", valor: "3" }, { nome: "--c", valor: "4" }];
    expect([...varsMudadas(a, b)].sort()).toEqual(["--b", "--c"]);
    expect([...varsMudadas(b, a)].sort()).toEqual(["--b", "--c"]);
  });

  it("lista temas do CSS", () => {
    expect(temasDoCss(':root{}\n:root[data-tema="claro"]{}\n:root[data-tema="alto"]{}')).toEqual(["claro", "alto"]);
  });
});

describe("Fundamentos", () => {
  const vars = [
    { nome: "--color-bg", caminho: "color.bg", tipo: "color", valor: "#161616" },
    { nome: "--font-family-body", caminho: "font.family.body", tipo: "fontFamily", valor: "Inter" },
    { nome: "--space-2", caminho: "space.2", tipo: "dimension", valor: "8px" },
    { nome: "--radius-md", caminho: "radius.md", tipo: "dimension", valor: "8px" },
    { nome: "--shadow-1", caminho: "shadow.1", tipo: "shadow", valor: "0 1px 2px black" },
    { nome: "--z-top", caminho: "z.top", valor: "10" },
  ];

  it("agrupa cada variável num grupo só", () => {
    const g = agruparVars(vars);
    expect(g.get("cor").map((v) => v.nome)).toEqual(["--color-bg"]);
    expect(g.get("tipo").map((v) => v.nome)).toEqual(["--font-family-body"]);
    expect(g.get("espaco").map((v) => v.nome)).toEqual(["--space-2"]);
    expect(g.get("forma").map((v) => v.nome)).toEqual(["--radius-md", "--shadow-1"]);
    expect(g.get("outros").map((v) => v.nome)).toEqual(["--z-top"]);
  });

  it("gera um card por grupo com var() e escapa o texto", () => {
    const cards = cardsDeFundamentos([...vars, { nome: "--x", caminho: "<b>", valor: "1" }]);
    expect(cards.map((c) => c.id)).toEqual(["fund-cores", "fund-tipografia", "fund-espaco", "fund-forma", "fund-outros"]);
    expect(cards[0].html).toContain("background:var(--color-bg)");
    expect(cards.at(-1).html).toContain("&lt;b&gt;");
  });
});

describe("urlsDeFontes", () => {
  it("uma URL por família (primeira de cada token de fonte), sem as do sistema", () => {
    const urls = urlsDeFontes([
      { nome: "--font-family-body", caminho: "font.family.body", tipo: "fontFamily", valor: '"IBM Plex Sans", system-ui' },
      { nome: "--font-family-mono", caminho: "font.family.mono", tipo: "fontFamily", valor: "ui-monospace, monospace" },
      { nome: "--font-family-display", caminho: "font.family.display", valor: "Archivo, sans-serif" },
      { nome: "--color-bg", caminho: "color.bg", tipo: "color", valor: "#000" },
    ]);
    expect(urls).toEqual([
      "https://fonts.googleapis.com/css?family=Archivo:400,500,600,700&display=swap",
      "https://fonts.googleapis.com/css?family=IBM+Plex+Sans:400,500,600,700&display=swap",
    ]);
    expect(urlsDeFontes([{ nome: "--f", caminho: "font.family.x", valor: "system-ui" }])).toEqual([]);
  });
});

describe("elementosParaConstruir", () => {
  it("pai antes do filho; corta profundidade quando passa do teto", () => {
    const d = document.createElement("div");
    d.innerHTML = `<style>.x{}</style><section><h2>a</h2><div><p>b</p><p>c</p></div></section>`;
    expect(elementosParaConstruir(d).map((e) => e.tagName)).toEqual(["SECTION", "H2", "DIV", "P", "P"]);
    expect(elementosParaConstruir(d, 3).map((e) => e.tagName)).toEqual(["SECTION", "H2", "DIV"]);
  });
});

describe("cardsPendentes", () => {
  const geracao = {
    status: "rodando",
    etapas: [{ id: "core", status: "rodando", cards: ["core-logo", "core-botoes"] }],
    plano: [
      { id: "core-logo", titulo: "Logo", secao: "core" },
      { id: "core-botoes", titulo: "Botões", secao: "core" },
    ],
  };

  it("só o que ainda não está em disco, com o status da etapa", () => {
    const p = cardsPendentes(geracao, [{ id: "core-botoes" }]);
    expect(p).toEqual([expect.objectContaining({ id: "core-logo", pendente: true, etapaStatus: "rodando", html: "" })]);
  });

  it("geração parada não deixa esqueleto", () => {
    expect(cardsPendentes({ ...geracao, status: "concluida" }, [])).toEqual([]);
    expect(cardsPendentes(null, [])).toEqual([]);
  });
});

describe("baseHrefDoProjeto", () => {
  it("Windows e POSIX viram file:// da raiz do projeto, com barra no fim", () => {
    expect(baseHrefDoProjeto("C:\\proj\\minha loja")).toBe("file:///C:/proj/minha%20loja/");
    expect(baseHrefDoProjeto("/home/x/app/")).toBe("file:///home/x/app/");
  });
});
