import { describe, it, expect } from "vitest";
import { montarMensagem } from "../inspector-mensagem.js";

describe("montarMensagem", () => {
  it("pedido vira o texto; cada elemento vai à parte com rótulo curto (tag + posição)", () => {
    const msg = montarMensagem(
      [
        { tag: "button", seletor: "button.btn-cta", outerHtml: '<button class="btn-cta">Comprar agora</button>', texto: "Comprar agora" },
        { tag: "h1", seletor: "h1.hero-title", outerHtml: '<h1 class="hero-title">Bem-vindo</h1>', texto: "" },
      ],
      "  deixa os dois com a mesma cor ",
    );
    expect(msg).toEqual({
      texto: "deixa os dois com a mesma cor",
      elementos: [
        { rotulo: "button1", seletor: "button.btn-cta", texto: "Comprar agora", html: '<button class="btn-cta">Comprar agora</button>' },
        { rotulo: "h1-2", seletor: "h1.hero-title", html: '<h1 class="hero-title">Bem-vindo</h1>' },
      ],
    });
  });

  it("sem elementos, só o pedido", () => {
    expect(montarMensagem([], "oi")).toEqual({ texto: "oi", elementos: [] });
  });
});
