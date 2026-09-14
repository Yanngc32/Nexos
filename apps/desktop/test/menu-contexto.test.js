// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { criarMenuContexto } from "../menu-contexto.js";

function evento(x = 10, y = 20) {
  let barrado = false;
  return {
    clientX: x,
    clientY: y,
    preventDefault: () => {
      barrado = true;
    },
    stopPropagation: () => {},
    get barrado() {
      return barrado;
    },
  };
}

const itens = (el) => [...el.querySelectorAll(".ctx-item")];
const menuNaTela = () => document.querySelector(".ctx-menu");

function tecla(key) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("abrir", () => {
  it("desenha itens, separador e título, e barra o menu nativo", () => {
    const menu = criarMenuContexto({ doc: document });
    const e = evento();
    const el = menu.abrir(e, [
      { titulo: "Repo" },
      { rotulo: "Nova conversa", ico: "+" },
      { separador: true },
      { rotulo: "Tarefas", atalho: "Ctrl+T" },
    ]);
    expect(e.barrado).toBe(true);
    expect(menu.aberto).toBe(true);
    expect(el.querySelector(".ctx-titulo").textContent).toBe("Repo");
    expect(el.querySelectorAll(".ctx-sep")).toHaveLength(1);
    expect(itens(el).map((b) => b.querySelector(".ctx-rotulo").textContent)).toEqual([
      "Nova conversa",
      "Tarefas",
    ]);
    expect(itens(el)[1].querySelector(".ctx-atalho").textContent).toBe("Ctrl+T");
  });

  it("lista vazia não abre nada", () => {
    const menu = criarMenuContexto({ doc: document });
    menu.abrir(evento(), []);
    expect(menuNaTela()).toBe(null);
    expect(menu.aberto).toBe(false);
  });

  it("abrir de novo fecha o anterior: um menu por vez", () => {
    const menu = criarMenuContexto({ doc: document });
    menu.abrir(evento(), [{ rotulo: "A" }]);
    menu.abrir(evento(), [{ rotulo: "B" }]);
    expect(document.querySelectorAll(".ctx-menu")).toHaveLength(1);
    expect(itens(menuNaTela())[0].textContent).toContain("B");
  });
});

describe("escolher", () => {
  it("clique chama onSelect e fecha", () => {
    const menu = criarMenuContexto({ doc: document });
    const visto = [];
    const el = menu.abrir(evento(), [{ rotulo: "Tarefas", onSelect: () => visto.push("tarefas") }]);
    itens(el)[0].click();
    expect(visto).toEqual(["tarefas"]);
    expect(menuNaTela()).toBe(null);
  });

  it("item desativado não é clicável nem entra na navegação por teclado", () => {
    const menu = criarMenuContexto({ doc: document });
    const visto = [];
    const el = menu.abrir(evento(), [
      { rotulo: "Off", desativado: true, onSelect: () => visto.push("off") },
      { rotulo: "On", onSelect: () => visto.push("on") },
    ]);
    expect(itens(el)[0].disabled).toBe(true);
    tecla("ArrowDown");
    tecla("Enter");
    expect(visto).toEqual(["on"]);
  });

  it("item perigoso é marcado pro CSS", () => {
    const menu = criarMenuContexto({ doc: document });
    const el = menu.abrir(evento(), [{ rotulo: "Apagar", perigo: true }]);
    expect(itens(el)[0].dataset.perigo).toBe("1");
  });
});

describe("fechar", () => {
  it("Esc fecha", () => {
    const menu = criarMenuContexto({ doc: document });
    menu.abrir(evento(), [{ rotulo: "A" }]);
    tecla("Escape");
    expect(menuNaTela()).toBe(null);
  });

  it("clique fora fecha, clique dentro não", () => {
    const menu = criarMenuContexto({ doc: document });
    const el = menu.abrir(evento(), [{ rotulo: "A" }]);
    itens(el)[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menuNaTela()).not.toBe(null);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menuNaTela()).toBe(null);
  });

  it("fechado não escuta mais o teclado", () => {
    const menu = criarMenuContexto({ doc: document });
    const visto = [];
    menu.abrir(evento(), [{ rotulo: "A", onSelect: () => visto.push("a") }]);
    menu.fechar();
    tecla("ArrowDown");
    tecla("Enter");
    expect(visto).toEqual([]);
  });
});

describe("teclado", () => {
  it("setas circulam e Enter escolhe o item em foco", () => {
    const menu = criarMenuContexto({ doc: document });
    const visto = [];
    menu.abrir(evento(), [
      { rotulo: "A", onSelect: () => visto.push("a") },
      { titulo: "Telas" },
      { rotulo: "B", onSelect: () => visto.push("b") },
    ]);
    tecla("ArrowUp"); // sem foco ainda: sobe pro último
    tecla("Enter");
    expect(visto).toEqual(["b"]);
  });

  it("Enter sem foco não escolhe nada", () => {
    const menu = criarMenuContexto({ doc: document });
    const visto = [];
    menu.abrir(evento(), [{ rotulo: "A", onSelect: () => visto.push("a") }]);
    tecla("Enter");
    expect(visto).toEqual([]);
    expect(menuNaTela()).not.toBe(null);
  });
});
