// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { MAX_CHARS, coletarDaPagina, paginaParaMarkdown } from "../pagina-markdown.js";

const libs = { Readability, TurndownService, DOMParser };
const paragrafos = (n, txt = "Texto corrido do artigo com bastante conteúdo pra contar como artigo.") =>
  Array.from({ length: n }, (_, i) => `<p>${txt} Parágrafo ${i + 1}.</p>`).join("");
const md = (corpo, extra = {}) =>
  paginaParaMarkdown({ html: `<html><head><title>T</title></head><body>${corpo}</body></html>`, url: "https://x.dev/a", titulo: "T", ...extra }, libs);

describe("paginaParaMarkdown", () => {
  it("bloco de código sai cercado e com a linguagem, inclusive sem <code> (GitHub) e em classe 'brush:' (MDN)", () => {
    const out = md(`<article><h1>Guia</h1>${paragrafos(6)}
      <div class="highlight highlight-source-shell"><pre>npm install @mozilla/readability</pre></div>
      <pre class="brush: js notranslate">const a = [1].map((x) =&gt; x * 2);</pre>
      <pre><code class="language-python">print("oi")</code></pre></article>`);
    expect(out).toContain("```shell\nnpm install @mozilla/readability\n```");
    expect(out).toContain("```js\nconst a = [1].map((x) => x * 2);\n```");
    expect(out).toContain('```python\nprint("oi")\n```');
  });

  it("Sandpack (react.dev): só nome de linguagem conhecido; sem declaração, sem chute", () => {
    const out = md(`<article>${paragrafos(6)}<div class="sp-code-editor"><pre class="sp-cm sp-pristine sp-javascript flex">let x = 1;</pre></div>
      <pre class="shiki tailwindcss-theme"><code>&lt;div class="p-4"&gt;&lt;/div&gt;</code></pre></article>`);
    expect(out).toContain("```javascript\nlet x = 1;\n```");
    expect(out).toContain('```\n<div class="p-4"></div>\n```');
  });

  it("título embrulhado em div com âncora (README do GitHub) não some", () => {
    const secao = (t) => `<div class="markdown-heading"><h2 class="heading-element">${t}</h2><a class="anchor" href="#${t}"></a></div>${paragrafos(3)}`;
    const out = md(`<article class="markdown-body">${secao("Installation")}${secao("Basic usage")}</article>`);
    expect(out).toContain("## Installation");
    expect(out).toContain("## Basic usage");
  });

  it("header de card (dentro de article/section/main) fica; o do site sai", () => {
    const itens = Array.from({ length: 40 }, (_, i) => `<div><span>Produto ${i}</span></div>`).join("");
    const out = md(`<header><a href="/">Logo do site</a></header><main><section><article><header><h2>Margem %</h2></header>
      <p>Loja inteira</p></article><div>${itens}</div></section></main>`);
    expect(out).toContain("## Margem %");
    expect(out).not.toContain("Logo do site");
  });

  it("tabela sai sem espaço de alinhamento; tabela de uma coluna (layout) vira o conteúdo", () => {
    const out = md(`<article>${paragrafos(6)}<table><tr><th>Token</th><th>Valor longo de propósito</th></tr>
      <tr><td>a | b</td><td>1</td></tr><tr><td>c</td></tr></table>
      <table><tr><td><p>Só um bloco dentro</p></td></tr></table></article>`);
    expect(out).toContain("| Token | Valor longo de propósito |\n| --- | --- |\n| a \\| b | 1 |\n| c |  |");
    expect(out).not.toMatch(/ {3,}\|/);
    expect(out).toContain("Só um bloco dentro");
  });

  it("sem âncora vazia de título (GitHub) nem imagem data: embutida", () => {
    const out = md(`<article>${paragrafos(6)}<h2>Installation</h2><a href="#installation"></a><img src="data:image/png;base64,AAAA" alt="ícone"></article>`);
    expect(out).toContain("## Installation");
    expect(out).not.toContain("](#installation)");
    expect(out).not.toContain("base64");
  });

  it("painel: Readability descarta a lista em <div>, vale o conteúdo principal sem o menu", () => {
    const itens = Array.from({ length: 40 }, (_, i) => `<div class="linha"><span>Produto ${i}</span><span>R$ ${i},00</span></div>`).join("");
    const p = "todas as 195 famílias: lucro bruto R$ 2.491.814,49, com venda nos últimos dias do mês corrente, margem de 35,6%, bem acima do alvo.";
    // mesma forma que fez o MarkSnip perder a lista da precificação: resumo em <p>, dados em <div>
    const out = md(`<nav><a href="/a">Dashboard</a><a href="/b">Relatórios</a></nav>
      <main><div id="a"><div class="resumo"><p>${p}</p><p>${p}</p></div></div><div id="b"><div id="c">${itens}</div></div></main>
      <footer>Aviso legal do site</footer>`);
    expect(out).toContain("modo conteúdo principal");
    expect(out).toContain("Produto 39");
    expect(out).not.toContain("Relatórios");
    expect(out).not.toContain("Aviso legal");
  });

  it("artigo normal usa o Readability; cabeçalho com endereço e modo", () => {
    const out = md(`<nav><a href="/x">Menu qualquer</a></nav><article><h1>Título</h1>${paragrafos(8)}</article>`);
    expect(out).toContain("> https://x.dev/a · modo artigo (Readability)");
    expect(out).toContain("Parágrafo 8");
    expect(out).not.toContain("Menu qualquer");
  });

  it("corta página gigante e avisa", () => {
    const out = md(`<article>${paragrafos(3000)}</article>`);
    expect(out.length).toBeLessThan(MAX_CHARS + 200);
    expect(out).toMatch(/cortado: .* caracteres\)$/);
  });

  it("sem as bibliotecas carregadas, erro claro", () => {
    expect(() => paginaParaMarkdown({ html: "" }, { DOMParser })).toThrow(/Readability/);
  });
});

describe("coletarDaPagina", () => {
  it("tira o que está oculto e o que não é conteúdo, e deixa link absoluto", () => {
    document.head.innerHTML = "<title>Pág</title><style>.x{color:red}</style>";
    document.body.innerHTML = `<p>visível</p><p style="display:none">escondido</p><script>1</script><a href="/rel">link</a>`;
    const r = coletarDaPagina();
    expect(r.titulo).toBe("Pág");
    expect(r.html).toContain("visível");
    expect(r.html).not.toContain("escondido");
    expect(r.html).not.toContain("<script");
    expect(r.html).toMatch(/href="https?:\/\/[^"]+\/rel"/);
  });
});
