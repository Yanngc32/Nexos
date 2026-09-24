// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { criarAnimador } from "../canvas-anim.js";

function montar(opts = {}) {
  document.body.innerHTML = `<div id="board"><svg id="traco"></svg><div id="cursor"></div><div id="alvo" style="transform: translate(10px, 20px)"></div></div>`;
  const $ = (id) => document.getElementById(id);
  const anim = criarAnimador({ camada: $("traco"), cursor: $("cursor"), escala: () => 2, esperar: async () => {}, reduzir: () => false, ...opts });
  return { anim, $ };
}

describe("criarAnimador", () => {
  it("entrar: esconde na hora, cursor vai até o alvo com contra-escala, desenha contorno e mostra", async () => {
    const { anim, $ } = montar();
    anim.enfileirar({ tipo: "entrar", alvo: $("alvo"), rect: { x: 10, y: 20, w: 100, h: 50 } });
    expect($("alvo").style.opacity).toBe("0");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect($("cursor").style.transform).toBe("translate(34px, 38px) scale(0.5)");
    expect($("traco").querySelector("rect")).not.toBeNull();
    expect($("alvo").style.opacity).toBe("");
    expect($("alvo").style.transform).toBe("translate(10px, 20px)");
  });

  it("desligada não anima nada; reduzir movimento só mostra", async () => {
    const off = montar({ ligada: () => false });
    off.anim.enfileirar({ tipo: "entrar", alvo: off.$("alvo"), rect: { x: 0, y: 0, w: 1, h: 1 } });
    expect(off.$("alvo").style.opacity).toBe("");
    const red = montar({ reduzir: () => true });
    red.anim.enfileirar({ tipo: "pulso", alvo: red.$("alvo"), rect: { x: 0, y: 0, w: 1, h: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(red.$("cursor").classList.contains("on")).toBe(false);
    expect(red.$("alvo").classList.contains("pulso")).toBe(true);
  });
});
