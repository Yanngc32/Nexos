import { describe, it, expect } from "vitest";
import { chaveDePasta, nomeDaPasta, opcoesDeProjeto, SUBAGENTES_MAX, textoDaVaga, textoDoUso } from "../subagente-ui.js";

describe("subagente-ui", () => {
  it("pasta: mesma chave com barra/caixa diferentes, nome é o último trecho", () => {
    expect(chaveDePasta("C:\\Repos\\Site\\")).toBe(chaveDePasta("c:/repos/site"));
    expect(nomeDaPasta("C:\\Repos\\Site\\")).toBe("Site");
  });

  it("projetos: conhecidos + marcados de outra máquina, sem repetir", () => {
    const op = opcoesDeProjeto(["C:\\a", "C:\\b"], ["c:/b", "D:\\longe"]);
    expect(op.map((o) => [o.nome, o.marcado])).toEqual([
      ["a", false],
      ["b", true],
      ["longe", true],
    ]);
  });

  it("vaga conta o formulário e avisa quando está cheio", () => {
    const defs = Array.from({ length: SUBAGENTES_MAX }, (_, i) => ({ id: `a${i}`, subagente: true }));
    expect(textoDaVaga(defs, "novo", false)).toEqual({ texto: `${SUBAGENTES_MAX} de ${SUBAGENTES_MAX} ligados`, cheio: true });
    // editando um que já está ligado não conta duas vezes
    expect(textoDaVaga(defs, "a0", true)).toEqual({ texto: `${SUBAGENTES_MAX} de ${SUBAGENTES_MAX} ligados`, cheio: false });
    // marcou o 7º: o texto não passa do teto e o `cheio` avisa antes de salvar
    expect(textoDaVaga(defs, "novo", true)).toEqual({ texto: `${SUBAGENTES_MAX} de ${SUBAGENTES_MAX} ligados`, cheio: true });
    expect(textoDaVaga([], "x", true).texto).toBe(`1 de ${SUBAGENTES_MAX} ligados`);
  });

  it("uso: conta quando chamado; ligado e nunca chamado sugere rever a descrição", () => {
    expect(textoDoUso({ usos: 3, ultimoUso: "2026-10-09T12:00:00.000Z" }, true)).toMatch(/^Chamado 3× pelas conversas · último em \d\d\/\d\d\.$/);
    expect(textoDoUso(undefined, true)).toMatch(/descrição/);
    expect(textoDoUso(undefined, false)).toBe("");
  });
});
