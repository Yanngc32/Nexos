import { describe, it, expect } from "vitest";
import { limparTitulo, pedidoDeTitulo, tituloPorRegra } from "../src/titulo-auto.ts";

describe("tituloPorRegra", () => {
  it("tira saudação e fica com a 1ª frase", () => {
    expect(tituloPorRegra("oi, tudo bem? O motor não para de travar e cair. Olha o log")).toBe("O motor não para de travar e cair");
  });

  it("ignora log colado, bloco de código, link e @menção", () => {
    const pedido = [
      "@revisor",
      "2026-09-28T14:32:46 AVISO [congelamento] motor ficou 3.1 s",
      "```ts",
      "const x = 1;",
      "```",
      "por que o motor congela? https://exemplo.com/x",
    ].join("\n");
    expect(tituloPorRegra(pedido)).toBe("Por que o motor congela");
  });

  it("corta em fim de palavra e sem pontuação pendurada", () => {
    const nome = tituloPorRegra("queria ver a possibilidade de melhorar a nomeação dos chats, planos, ds e de mais um monte de coisas");
    expect(nome.length).toBeLessThanOrEqual(60);
    expect(nome).toMatch(/^Queria ver a possibilidade/);
    expect(nome).not.toMatch(/[,\s]$/);
  });

  it("só colagem ou saudação: devolve vazio", () => {
    expect(tituloPorRegra("oi")).toBe("");
    expect(tituloPorRegra("C:\\Users\\x\\arquivo.ts\n{ \"a\": 1 }")).toBe("");
  });
});

describe("limparTitulo", () => {
  it("tira aspas, prefixo e ponto final", () => {
    expect(limparTitulo('Título: "Motor travando no Drive."\n')).toBe("Motor travando no Drive");
    expect(limparTitulo("**nomeação de chats e planos**")).toBe("Nomeação de chats e planos");
  });

  it("resposta que não parece título vira vazio (aí vale a regra)", () => {
    expect(limparTitulo("")).toBe("");
    expect(limparTitulo("Claro! Aqui vai uma sugestão de título bem completa para a conversa que você mandou agora")).toBe("");
  });
});

describe("pedidoDeTitulo", () => {
  it("leva pedido e começo da resposta, com teto", () => {
    const p = pedidoDeTitulo("a".repeat(5000), "resposta");
    expect(p).toContain("resposta");
    expect(p.length).toBeLessThan(2000);
  });
});
