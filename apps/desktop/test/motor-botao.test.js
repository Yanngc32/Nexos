import { describe, expect, it } from "vitest";
import { decidirCliqueDoMotor, ROTULO_ESTAVEL_MS } from "../motor-botao.js";

describe("decidirCliqueDoMotor", () => {
  const agora = 100_000;
  const estavel = agora - ROTULO_ESTAVEL_MS - 1;

  it("faz o que o botão mostrava", () => {
    expect(decidirCliqueDoMotor({ acao: "ligar", desde: estavel }, agora)).toBe("ligar");
    expect(decidirCliqueDoMotor({ acao: "desligar", desde: estavel }, agora)).toBe("desligar");
    expect(decidirCliqueDoMotor({ acao: "reiniciar", desde: estavel }, agora)).toBe("reiniciar");
  });

  it("motor voltou de um congelamento e o rótulo acabou de virar 'Desligar': o clique não desliga", () => {
    // a pessoa mirou "Reiniciar"/"Ligar"; o poll trocou o rótulo seis décimos antes do clique
    expect(decidirCliqueDoMotor({ acao: "desligar", desde: agora - 600 }, agora)).toBeNull();
  });

  it("mago só liga: nunca desliga", () => {
    expect(decidirCliqueDoMotor({ acao: "desligar", desde: estavel }, agora, { doMago: true })).toBeNull();
    expect(decidirCliqueDoMotor({ acao: "ligar", desde: estavel }, agora, { doMago: true })).toBe("ligar");
  });

  it("subindo ('Ligando…', sem ação): clique não faz nada", () => {
    expect(decidirCliqueDoMotor({ acao: "", desde: estavel }, agora)).toBeNull();
  });
});
