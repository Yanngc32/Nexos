import { describe, it, expect } from "vitest";
import { escapeHtml, mdInline, mdToHtml } from "../markdown.js";

/*
 * Este módulo é a fronteira onde texto do modelo vira HTML no app. O CSP
 * (`default-src 'self'`) barra execução de script inline, mas ele é a segunda
 * linha: a primeira é escapar antes de formatar. Os testes de injeção existem
 * pra que uma refatoração do parser não inverta essa ordem sem ninguém ver.
 */

describe("escapeHtml", () => {
  it("escapa os cinco que quebram HTML, aspas inclusas", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapa o & antes do resto, sem escapar duas vezes", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("aceita não-string sem estourar", () => {
    expect(escapeHtml(undefined)).toBe("undefined");
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("mdInline: injeção", () => {
  it("tag vinda do modelo sai como texto", () => {
    expect(mdInline("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("handler em atributo não sobrevive", () => {
    const out = mdInline(`<img src=x onerror="alert(1)">`);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("&quot;");
  });

  it("link javascript: não vira âncora, fica texto inerte", () => {
    // o esquema continua visível como texto — o que importa é não virar href
    expect(mdInline("[clica](javascript:alert(1))")).toBe("[clica](javascript:alert(1))");
  });

  it("data: e file: também ficam de fora", () => {
    expect(mdInline("[x](data:text/html,<script>1</script>)")).not.toContain("<a ");
    expect(mdInline("[x](file:///etc/passwd)")).not.toContain("<a ");
  });

  it("aspas na url não escapam do atributo href", () => {
    const out = mdInline(`[x](https://a.b"onmouseover="alert(1))`);
    // a aspa já virou &quot; antes de o link ser montado: o atributo continua um só
    expect(out).not.toContain(`"onmouseover="`);
    expect(out.match(/href="/g)).toHaveLength(1);
  });

  it("link http/https normal passa, com marca pra abrir fora", () => {
    expect(mdInline("[nexo](https://exemplo.com/a?b=1)")).toBe(
      '<a href="https://exemplo.com/a?b=1" data-ext="1">nexo</a>',
    );
  });
});

describe("mdInline: formatação", () => {
  it("negrito e itálico", () => {
    expect(mdInline("**forte** e *fraco*")).toBe("<strong>forte</strong> e <em>fraco</em>");
    expect(mdInline("com _sublinhado_ também")).toBe("com <em>sublinhado</em> também");
  });

  it("asterisco dentro de código não vira formatação", () => {
    expect(mdInline("roda `git add *` agora")).toBe("roda <code>git add *</code> agora");
  });

  it("código inline também é escapado", () => {
    expect(mdInline("`<b>`")).toBe("<code>&lt;b&gt;</code>");
  });

  it("asterisco solto no meio de palavra não abre itálico", () => {
    expect(mdInline("2*3 e 4*5")).toBe("2*3 e 4*5");
  });
});

describe("mdToHtml: blocos", () => {
  it("bloco de código é escapado e guarda a linguagem", () => {
    const out = mdToHtml("```js\nconst a = '<b>';\n```");
    expect(out).toBe(`<pre class="lang-js"><code>const a = &#39;&lt;b&gt;&#39;;</code></pre>`);
  });

  it("linguagem estranha não vira classe", () => {
    expect(mdToHtml('```js" onload="x\noi\n```')).toContain("<pre><code>");
  });

  it("título, régua, lista e citação", () => {
    expect(mdToHtml("# Topo")).toBe("<h3>Topo</h3>");
    expect(mdToHtml("---")).toBe("<hr />");
    expect(mdToHtml("- um\n- dois")).toBe("<ul><li>um</li><li>dois</li></ul>");
    expect(mdToHtml("1. um\n2. dois")).toBe("<ol><li>um</li><li>dois</li></ol>");
    expect(mdToHtml("> citado")).toBe("<blockquote>citado</blockquote>");
  });

  it("tabela vira table dentro do wrapper que rola", () => {
    const out = mdToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain('<div class="md-table">');
    expect(out).toContain("<th>a</th><th>b</th>");
    expect(out).toContain("<td>1</td><td>2</td>");
  });

  it("parágrafo junta linhas com <br />", () => {
    expect(mdToHtml("uma\noutra")).toBe("<p>uma<br />outra</p>");
  });

  it("CRLF não deixa \\r no meio do texto", () => {
    expect(mdToHtml("uma\r\noutra")).toBe("<p>uma<br />outra</p>");
  });

  it("entrada vazia ou nula não estoura", () => {
    expect(mdToHtml("")).toBe("");
    expect(mdToHtml(undefined)).toBe("");
  });

  it("bloco de código sem fim fecha sozinho em vez de perder o resto", () => {
    expect(mdToHtml("```\nsem fim")).toBe("<pre><code>sem fim</code></pre>");
  });
});
