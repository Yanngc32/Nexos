// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  classesEstaveis,
  gerarSeletor,
  truncar,
  outerHtmlResumido,
  textoVisivel,
  capturarElemento,
} from "../inspector-selector.cjs";

describe("classesEstaveis", () => {
  it("mantém classe legível, descarta hash de CSS-in-JS/CSS Modules", () => {
    const el = document.createElement("button");
    el.className = "btn-cta css-a1b2c3 Button_module__x7f3d primary";
    expect(classesEstaveis(el)).toEqual(["btn-cta", "primary"]);
  });

  it("corta em 2 classes", () => {
    const el = document.createElement("div");
    el.className = "a b c d";
    expect(classesEstaveis(el)).toHaveLength(2);
  });
});

describe("gerarSeletor", () => {
  it("usa #id quando existe, e para de subir", () => {
    document.body.innerHTML = `<div id="card"><button id="cta">Comprar</button></div>`;
    expect(gerarSeletor(document.getElementById("cta"))).toBe("#cta");
  });

  it("usa tag.classes quando não tem id", () => {
    document.body.innerHTML = `<div class="hero"><button class="btn-cta primary">Comprar</button></div>`;
    const btn = document.querySelector("button");
    expect(gerarSeletor(btn)).toBe("div.hero > button.btn-cta.primary");
  });

  it("cai em nth-child só quando há mais de um irmão do mesmo tipo", () => {
    document.body.innerHTML = `<ul><li>um</li><li>dois</li><li>três</li></ul>`;
    const segundo = document.querySelectorAll("li")[1];
    expect(gerarSeletor(segundo)).toBe("ul > li:nth-child(2)");
  });

  it("filho único do tipo não ganha nth-child", () => {
    document.body.innerHTML = `<section><h1>Título</h1><p>texto</p></section>`;
    expect(gerarSeletor(document.querySelector("h1"))).toBe("section > h1");
  });

  it("não sobe além do teto de ancestrais", () => {
    document.body.innerHTML = `<div><div><div><div><div><span id="fundo">x</span></div></div></div></div></div>`;
    const seletor = gerarSeletor(document.getElementById("fundo"), 2);
    // achou #id no próprio elemento — não precisa subir nada além dele
    expect(seletor).toBe("#fundo");
  });
});

describe("truncar / outerHtmlResumido / textoVisivel", () => {
  it("não mexe em texto curto", () => {
    expect(truncar("oi", 10)).toBe("oi");
  });

  it("corta e marca com … texto longo", () => {
    expect(truncar("a".repeat(20), 10)).toBe(`${"a".repeat(10)}…`);
  });

  it("outerHtmlResumido corta o outerHTML inteiro (tag + subárvore), não só a tag de abertura", () => {
    const el = document.createElement("div");
    el.innerHTML = "x".repeat(400);
    const html = outerHtmlResumido(el, 50);
    expect(html.endsWith("…")).toBe(true);
    expect(html.length).toBe(51);
  });

  it("textoVisivel colapsa espaço/quebra de linha e trunca", () => {
    const el = document.createElement("p");
    el.textContent = "  linha  um\n\n linha dois  ";
    expect(textoVisivel(el, 100)).toBe("linha um linha dois");
  });
});

describe("capturarElemento", () => {
  it("junta seletor, outerHTML resumido e texto visível", () => {
    document.body.innerHTML = `<button id="cta">Comprar agora</button>`;
    const dados = capturarElemento(document.getElementById("cta"));
    expect(dados.seletor).toBe("#cta");
    expect(dados.texto).toBe("Comprar agora");
    expect(dados.outerHtml).toContain("Comprar agora");
  });
});

