// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { acionavel, criarFolha, ligarSetasDasAbas, marcarAbas, marcarExpandido } from "../../mobile/acessivel.js";

/** Os testes do app de celular rodam por aqui — ver mobile-pareamento.test.js. */

const tecla = (el, key, extra = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));

describe("acionavel", () => {
  it("vira botão pro leitor, entra no Tab, e Enter/Espaço/clique acionam", () => {
    const li = document.createElement("li");
    const f = vi.fn();
    acionavel(li, f);
    expect(li.getAttribute("role")).toBe("button");
    expect(li.tabIndex).toBe(0);
    li.click();
    tecla(li, "Enter");
    const espaco = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    li.dispatchEvent(espaco);
    expect(espaco.defaultPrevented).toBe(true); // o Espaço não rola a página
    tecla(li, "a");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("marcarExpandido diz aberto/fechado pro leitor", () => {
    const li = document.createElement("li");
    marcarExpandido(li, false);
    expect(li.getAttribute("aria-expanded")).toBe("false");
    marcarExpandido(li, true);
    expect(li.getAttribute("aria-expanded")).toBe("true");
    expect(li.dataset.aberto).toBe("1");
  });
});

describe("abas", () => {
  function montar() {
    document.body.innerHTML = `
      <nav id="tabs" role="tablist">
        <button role="tab" data-aba="agora" class="on">Agora</button>
        <button role="tab" data-aba="conversas">Conversas</button>
      </nav>`;
    return document.getElementById("tabs");
  }

  it("só a acesa fica selecionada e entra no Tab", () => {
    const nav = montar();
    marcarAbas(nav, "conversas");
    const [agora, conversas] = nav.querySelectorAll("[role=tab]");
    expect([agora.getAttribute("aria-selected"), conversas.getAttribute("aria-selected")]).toEqual(["false", "true"]);
    expect([agora.tabIndex, conversas.tabIndex]).toEqual([-1, 0]);
    expect(conversas.classList.contains("on")).toBe(true);
  });

  it("setas andam entre as abas, focam e ativam (com volta no fim)", () => {
    const nav = montar();
    const [agora, conversas] = nav.querySelectorAll("[role=tab]");
    const clicou = [];
    nav.addEventListener("click", (e) => clicou.push(e.target.dataset.aba));
    ligarSetasDasAbas(nav);
    tecla(agora, "ArrowRight");
    expect(document.activeElement).toBe(conversas);
    tecla(conversas, "ArrowRight");
    expect(document.activeElement).toBe(agora);
    tecla(agora, "End");
    expect(clicou).toEqual(["conversas", "agora", "conversas"]);
  });
});

describe("folha como diálogo", () => {
  function montar() {
    document.body.innerHTML = `
      <button id="gatilho">abrir</button>
      <div class="folha hidden" id="f">
        <div class="folha-fundo" data-fechar></div>
        <div class="folha-painel" role="dialog">
          <button id="a">A</button>
          <button id="b">B</button>
        </div>
      </div>`;
    const gatilho = document.getElementById("gatilho");
    gatilho.focus();
    return { el: document.getElementById("f"), gatilho, a: document.getElementById("a"), b: document.getElementById("b") };
  }

  it("abrir leva o foco pra dentro; Esc fecha e devolve o foco pra quem abriu", () => {
    const { el, gatilho } = montar();
    const folha = criarFolha(el);
    folha.abrir();
    expect(el.classList.contains("hidden")).toBe(false);
    expect(el.querySelector(".folha-painel").contains(document.activeElement)).toBe(true);
    tecla(el.querySelector(".folha-painel"), "Escape");
    expect(el.classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(gatilho);
  });

  it("Tab não escapa: do último volta pro primeiro e Shift+Tab do primeiro vai pro último", () => {
    const { el, a, b } = montar();
    criarFolha(el).abrir();
    b.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    b.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(a);
    tecla(a, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(b);
  });

  it("tocar no fundo fecha", () => {
    const { el } = montar();
    const folha = criarFolha(el);
    folha.abrir();
    el.querySelector(".folha-fundo").click();
    expect(folha.aberta()).toBe(false);
  });
});

describe("index.html do celular", () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../mobile/index.html"), "utf8");

  it("abas como tablist e folhas como diálogo com título", () => {
    expect(html).toMatch(/id="tabs" role="tablist"/);
    expect(html.match(/<button[^>]*role="tab"/g)).toHaveLength(2);
    expect(html.match(/role="dialog" aria-modal="true" aria-labelledby="folha-[a-z]+-tit"/g)).toHaveLength(3);
  });
});
