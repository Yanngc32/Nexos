// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  elementosInterativos,
  elementosInterativosComInfo,
  papelDe,
  textoDe,
  estaVisivel,
  truncar,
  MAX_ITENS,
} from "../navegador-selector.cjs";

describe("papelDe", () => {
  it("usa role explícito antes de deduzir da tag", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "tab");
    expect(papelDe(el)).toBe("tab");
  });

  it("deduz link/button/heading pela tag", () => {
    expect(papelDe(document.createElement("a"))).toBe("link");
    expect(papelDe(document.createElement("button"))).toBe("button");
    expect(papelDe(document.createElement("h2"))).toBe("heading");
  });

  it("input: type submit/button/reset é 'button', o resto é 'textbox', checkbox/radio próprios", () => {
    const submit = document.createElement("input");
    submit.type = "submit";
    expect(papelDe(submit)).toBe("button");

    const texto = document.createElement("input");
    texto.type = "email";
    expect(papelDe(texto)).toBe("textbox");

    const check = document.createElement("input");
    check.type = "checkbox";
    expect(papelDe(check)).toBe("checkbox");
  });

  it("sem role/tag semântica mas com tabindex (widget custom, ex.: combobox sem ARIA): 'clicável'", () => {
    const div = document.createElement("div");
    div.setAttribute("tabindex", "0");
    expect(papelDe(div)).toBe("clicável (sem role — widget custom)");
  });

  it("tabindex=-1 não conta como clicável (só focável via JS, não é um controle pro usuário)", () => {
    const div = document.createElement("div");
    div.setAttribute("tabindex", "-1");
    expect(papelDe(div)).toBe("texto");
  });

  it("sem role/tag/tabindex nenhum: 'texto' (fallback pra texto solto sem semântica)", () => {
    expect(papelDe(document.createElement("span"))).toBe("texto");
  });
});

describe("textoDe", () => {
  it("aria-label vence tudo", () => {
    const el = document.createElement("button");
    el.setAttribute("aria-label", "Fechar modal");
    el.textContent = "x";
    expect(textoDe(el)).toBe("Fechar modal");
  });

  it("input/textarea usa placeholder, depois valor", () => {
    const input = document.createElement("input");
    input.setAttribute("placeholder", "seu e-mail");
    expect(textoDe(input)).toBe("seu e-mail");
  });

  it("outros elementos usam o texto visível, colapsando espaço", () => {
    const el = document.createElement("button");
    el.innerHTML = "Entrar\n   agora";
    expect(textoDe(el)).toBe("Entrar agora");
  });

  it("trunca texto longo em 120 caracteres com reticências", () => {
    const el = document.createElement("button");
    el.textContent = "a".repeat(200);
    const t = textoDe(el);
    expect(t.length).toBe(121);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("estaVisivel", () => {
  it("display:none não é visível", () => {
    document.body.innerHTML = `<button id="b" style="display:none">oi</button>`;
    const el = document.getElementById("b");
    expect(estaVisivel(el, { getComputedStyle: () => ({ display: "none", visibility: "visible" }) })).toBe(false);
  });

  it("visibility:hidden não é visível", () => {
    document.body.innerHTML = `<button id="b">oi</button>`;
    const el = document.getElementById("b");
    expect(estaVisivel(el, { getComputedStyle: () => ({ display: "block", visibility: "hidden" }) })).toBe(false);
  });

  it("tamanho zero (0x0) não é visível mesmo com display/visibility normais", () => {
    document.body.innerHTML = `<button id="b">oi</button>`;
    const el = document.getElementById("b");
    el.getBoundingClientRect = () => ({ width: 0, height: 0 });
    expect(estaVisivel(el, { getComputedStyle: () => ({ display: "block", visibility: "visible" }) })).toBe(false);
  });

  it("visível de verdade: display/visibility normais e tamanho > 0", () => {
    document.body.innerHTML = `<button id="b">oi</button>`;
    const el = document.getElementById("b");
    el.getBoundingClientRect = () => ({ width: 80, height: 20 });
    expect(estaVisivel(el, { getComputedStyle: () => ({ display: "block", visibility: "visible" }) })).toBe(true);
  });
});

describe("elementosInterativos", () => {
  it("pega link/botão/campo/heading primeiro, na ordem do documento — texto solto (ex.: <p>) entra depois, como camada de menor prioridade", () => {
    document.body.innerHTML = `
      <div>
        <p>texto solto, não interessa</p>
        <h1>Título</h1>
        <a href="/login">Entrar</a>
        <button>Confirmar</button>
        <input type="text" placeholder="busca" />
        <span onclick="x()">clicável via onclick</span>
      </div>
    `;
    // janela fake onde tudo é "visível" (getBoundingClientRect real do happy-dom devolve 0x0 —
    // sem layout de verdade — então o teste injeta tamanho > 0 pra não confundir com a checagem de visibilidade)
    for (const el of document.body.querySelectorAll("*")) {
      el.getBoundingClientRect = () => ({ width: 10, height: 10 });
    }
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const els = elementosInterativos(document.body, win);
    const tags = els.map((e) => e.tagName.toLowerCase());
    expect(tags).toEqual(["h1", "a", "button", "input", "span", "p"]);
  });

  it("div/span sem role mas com tabindex (widget custom, ex.: combobox sem ARIA) ganha ref mesmo sem semântica nenhuma", () => {
    document.body.innerHTML = `<div id="combo" tabindex="0">Selecione um item</div>`;
    document.getElementById("combo").getBoundingClientRect = () => ({ width: 10, height: 10 });
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const els = elementosInterativos(document.body, win);
    expect(els.map((e) => e.id)).toEqual(["combo"]);
  });

  it("valor solto sem semântica (ex.: <span> com R$) aparece como texto, mesmo sem role/onclick/tabindex", () => {
    document.body.innerHTML = `<span id="valor">R$ 1.234,56</span>`;
    document.getElementById("valor").getBoundingClientRect = () => ({ width: 10, height: 10 });
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const els = elementosInterativos(document.body, win);
    expect(els.map((e) => e.id)).toEqual(["valor"]);
    expect(papelDe(els[0])).toBe("texto");
  });

  it("container com filho elemento não conta como 'folha de texto' — só o filho aparece, não duplica", () => {
    document.body.innerHTML = `<div id="wrap"><span id="dentro">valor</span></div>`;
    for (const el of document.body.querySelectorAll("*")) el.getBoundingClientRect = () => ({ width: 10, height: 10 });
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const els = elementosInterativos(document.body, win);
    expect(els.map((e) => e.id)).toEqual(["dentro"]);
  });

  it("elemento invisível (display:none) não entra na lista", () => {
    document.body.innerHTML = `<button id="visivel">a</button><button id="escondido" style="display:none">b</button>`;
    for (const el of document.body.querySelectorAll("button")) {
      el.getBoundingClientRect = () => ({ width: 10, height: 10 });
    }
    const win = {
      getComputedStyle: (el) => ({
        display: el.id === "escondido" ? "none" : "block",
        visibility: "visible",
      }),
    };
    const els = elementosInterativos(document.body, win);
    expect(els.map((e) => e.id)).toEqual(["visivel"]);
  });

  it("nunca devolve mais que MAX_ITENS, mesmo com centenas de elementos (ex.: gráfico com role por ponto)", () => {
    document.body.innerHTML = Array.from({ length: MAX_ITENS + 50 }, (_, i) => `<div role="img" id="p${i}"></div>`).join("");
    for (const el of document.body.querySelectorAll("[role]")) {
      el.getBoundingClientRect = () => ({ width: 10, height: 10 });
    }
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const els = elementosInterativos(document.body, win);
    expect(els.length).toBe(MAX_ITENS);
  });
});

describe("elementosInterativosComInfo", () => {
  it("truncado:false quando cabe tudo", () => {
    document.body.innerHTML = `<button id="a">a</button>`;
    document.getElementById("a").getBoundingClientRect = () => ({ width: 10, height: 10 });
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    expect(elementosInterativosComInfo(document.body, win).truncado).toBe(false);
  });

  it("truncado:true quando o total (interativos + focáveis + texto solto) passa de MAX_ITENS", () => {
    document.body.innerHTML = Array.from({ length: MAX_ITENS + 20 }, (_, i) => `<button id="b${i}">b</button>`).join("");
    for (const el of document.body.querySelectorAll("button")) el.getBoundingClientRect = () => ({ width: 10, height: 10 });
    const win = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const { itens, truncado } = elementosInterativosComInfo(document.body, win);
    expect(itens.length).toBe(MAX_ITENS);
    expect(truncado).toBe(true);
  });
});

describe("truncar", () => {
  it("não mexe em texto curto", () => {
    expect(truncar("oi")).toBe("oi");
  });
});
