// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { criarOverlay } from "../inspector-overlay.cjs";

function criarAlvo() {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

describe("marcar", () => {
  it("cria um elemento no DOM posicionado sobre o alvo e retorna índice 1, depois 2", () => {
    const overlay = criarOverlay();
    const alvo1 = criarAlvo();
    const alvo2 = criarAlvo();

    const antes = document.documentElement.querySelectorAll("div").length;
    const indice1 = overlay.marcar(alvo1);
    expect(indice1).toBe(1);
    expect(document.documentElement.querySelectorAll("div").length).toBe(antes + 1);

    const indice2 = overlay.marcar(alvo2);
    expect(indice2).toBe(2);
    expect(document.documentElement.querySelectorAll("div").length).toBe(antes + 2);
  });

  it("não duplica badge nem incrementa índice pro mesmo elemento", () => {
    const overlay = criarOverlay();
    const alvo = criarAlvo();
    expect(overlay.marcar(alvo)).toBe(1);
    expect(overlay.marcar(alvo)).toBeNull();
    expect(overlay.estaMarcado(alvo)).toBe(true);
  });
});

describe("desmarcar", () => {
  it("remove o badge 1 e o badge que era 2 vira 1 (renumeração)", () => {
    const overlay = criarOverlay();
    const alvo1 = criarAlvo();
    const alvo2 = criarAlvo();
    overlay.marcar(alvo1);
    overlay.marcar(alvo2);

    overlay.desmarcar(1);

    expect(overlay.estaMarcado(alvo1)).toBe(false);
    expect(overlay.estaMarcado(alvo2)).toBe(true);
    const badgeRestante = document.documentElement.querySelector("span");
    expect(badgeRestante.textContent).toBe("1");
  });
});

describe("limpar", () => {
  it("remove todos os badges do DOM e zera o contador", () => {
    const overlay = criarOverlay();
    const antes = document.documentElement.querySelectorAll("div").length;
    overlay.marcar(criarAlvo());
    overlay.marcar(criarAlvo());

    overlay.limpar();

    expect(document.documentElement.querySelectorAll("div").length).toBe(antes);
    expect(overlay.marcar(criarAlvo())).toBe(1);
  });
});

describe("mostrarHover", () => {
  it("não lança erro e não quebra com opts undefined", () => {
    const overlay = criarOverlay();
    const alvo = criarAlvo();
    expect(() => overlay.mostrarHover(alvo)).not.toThrow();
    expect(() => overlay.mostrarHover(alvo, undefined)).not.toThrow();
    expect(() => overlay.mostrarHover(alvo, { etiqueta: "texto" })).not.toThrow();
  });

  it("mostra a etiqueta com o seletor e atualiza ao trocar de alvo", () => {
    const overlay = criarOverlay();
    const ultimaEtiqueta = () => {
      const spans = document.documentElement.querySelectorAll("span");
      return spans[spans.length - 1];
    };
    overlay.mostrarHover(criarAlvo(), { etiqueta: "button.cta" });
    expect(ultimaEtiqueta().textContent).toBe("button.cta");

    overlay.mostrarHover(criarAlvo(), { etiqueta: "#hero" });
    expect(ultimaEtiqueta().textContent).toBe("#hero");
  });
});
