import { describe, it, expect } from "vitest";
import { montarMensagem } from "../inspector-mensagem.js";

describe("montarMensagem", () => {
  it("numera os elementos e anexa o pedido livre", () => {
    const msg = montarMensagem(
      [
        { seletor: "button.btn-cta", outerHtml: '<button class="btn-cta">Comprar agora</button>', texto: "Comprar agora" },
        { seletor: "h1.hero-title", outerHtml: '<h1 class="hero-title">Bem-vindo</h1>', texto: "Bem-vindo" },
      ],
      "deixa os dois com a mesma cor",
    );
    expect(msg).toBe(
      "Nestes elementos do preview:\n" +
        '1. button.btn-cta — "Comprar agora"\n' +
        '   <button class="btn-cta">Comprar agora</button>\n' +
        '2. h1.hero-title — "Bem-vindo"\n' +
        '   <h1 class="hero-title">Bem-vindo</h1>\n\n' +
        "Pedido: deixa os dois com a mesma cor",
    );
  });

  it("elemento sem texto visível não ganha aspas vazias no rótulo", () => {
    const msg = montarMensagem([{ seletor: "div.icon", outerHtml: '<div class="icon"></div>', texto: "" }], "troca o ícone");
    expect(msg).toContain("1. div.icon\n");
    expect(msg).not.toContain('""');
  });

  it("lista vazia ainda monta o texto do pedido", () => {
    expect(montarMensagem([], "oi")).toBe("Nestes elementos do preview:\n\n\nPedido: oi");
  });
});
