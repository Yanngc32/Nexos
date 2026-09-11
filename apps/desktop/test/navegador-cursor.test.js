// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { criarCursorAgente } from "../navegador-cursor.cjs";

function criarAlvo() {
  const el = document.createElement("button");
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 40, height: 20 });
  return el;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("mostrarClique", () => {
  it("cria um único elemento de cursor no DOM, posicionado no centro do alvo", () => {
    const cursor = criarCursorAgente();
    const alvo = criarAlvo();
    const antes = document.documentElement.querySelectorAll("div").length;
    cursor.mostrarClique(alvo);
    const divs = document.documentElement.querySelectorAll("div");
    expect(divs.length).toBe(antes + 1);
    const el = divs[divs.length - 1];
    expect(el.style.display).toBe("block");
    expect(el.style.left).toBe("120px"); // 100 + 40/2
    expect(el.style.top).toBe("60px"); // 50 + 20/2
  });

  it("reaproveita o MESMO elemento em cliques seguintes, não cria um novo por clique", () => {
    const cursor = criarCursorAgente();
    const a = criarAlvo();
    const b = criarAlvo();
    cursor.mostrarClique(a);
    const depoisDoPrimeiro = document.documentElement.querySelectorAll("div").length;
    cursor.mostrarClique(b);
    expect(document.documentElement.querySelectorAll("div").length).toBe(depoisDoPrimeiro);
  });

  it("some sozinho depois de um tempo (não fica um ponto roxo preso na tela pra sempre)", () => {
    const cursor = criarCursorAgente();
    const alvo = criarAlvo();
    cursor.mostrarClique(alvo);
    const el = document.documentElement.querySelector("div:last-child");
    expect(el.style.display).toBe("block");
    vi.advanceTimersByTime(700);
    expect(el.style.display).toBe("none");
  });
});

describe("mostrarFoco", () => {
  it("posiciona sobre o alvo sem exigir clique nenhum antes", () => {
    const cursor = criarCursorAgente();
    const alvo = criarAlvo();
    cursor.mostrarFoco(alvo);
    const el = document.documentElement.querySelector("div:last-child");
    expect(el.style.display).toBe("block");
    expect(el.style.left).toBe("120px");
  });

  it("também some sozinho depois de um tempo", () => {
    const cursor = criarCursorAgente();
    const alvo = criarAlvo();
    cursor.mostrarFoco(alvo);
    const el = document.documentElement.querySelector("div:last-child");
    vi.advanceTimersByTime(900);
    expect(el.style.display).toBe("none");
  });
});
