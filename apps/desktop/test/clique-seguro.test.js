import { describe, it, expect, vi } from "vitest";
import { criarCliqueSeguro } from "../clique-seguro.js";

function docFake() {
  const ouvintes = {};
  return {
    addEventListener: (n, f) => ((ouvintes[n] ||= []).push(f)),
    disparar: (n) => (ouvintes[n] || []).forEach((f) => f()),
  };
}

describe("criarCliqueSeguro", () => {
  it("sem botão apertado, desenha na hora", () => {
    const adiar = criarCliqueSeguro(docFake(), (f) => f());
    expect(adiar(() => {})).toBe(false);
  });

  it("com o botão apertado, adia e roda uma vez só depois de soltar", () => {
    const doc = docFake();
    const agendados = [];
    const adiar = criarCliqueSeguro(doc, (f) => agendados.push(f));
    const redesenho = vi.fn();
    doc.disparar("pointerdown");
    expect(adiar(redesenho)).toBe(true);
    expect(adiar(redesenho)).toBe(true);
    expect(redesenho).not.toHaveBeenCalled();
    doc.disparar("pointerup");
    agendados.forEach((f) => f());
    expect(redesenho).toHaveBeenCalledTimes(1);
    expect(adiar(redesenho)).toBe(false);
  });

  it("pointercancel (arrastar) também solta", () => {
    const doc = docFake();
    const adiar = criarCliqueSeguro(doc, (f) => f());
    const redesenho = vi.fn();
    doc.disparar("pointerdown");
    adiar(redesenho);
    doc.disparar("pointercancel");
    expect(redesenho).toHaveBeenCalledTimes(1);
  });
});
