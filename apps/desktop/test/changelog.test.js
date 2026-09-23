import { describe, expect, it } from "vitest";
import { secaoDaVersao } from "../changelog.js";

const MD = `# Changelog

## [Não lançado]

### Adicionado

## [0.3.0] - 2026-09-22

### Adicionado

- **Design System**: board com pan/zoom
  que mostra e edita.
- Outro item.

### Segurança

## [0.2.0] - 2026-09-20

### Corrigido

- Coisa velha.
`;

describe("secaoDaVersao", () => {
  it("pega só a seção da versão, junta continuação e tira subseção vazia", () => {
    expect(secaoDaVersao(MD, "0.3.0")).toBe(
      "### Adicionado\n\n- **Design System**: board com pan/zoom que mostra e edita.\n- Outro item.",
    );
  });

  it("última seção do arquivo vai até o fim", () => {
    expect(secaoDaVersao(MD, "0.2.0")).toBe("### Corrigido\n\n- Coisa velha.");
  });

  it("versão ausente devolve vazio", () => {
    expect(secaoDaVersao(MD, "9.9.9")).toBe("");
    expect(secaoDaVersao("", "0.3.0")).toBe("");
  });

  it("aceita CRLF", () => {
    expect(secaoDaVersao(MD.replace(/\n/g, "\r\n"), "0.2.0")).toBe("### Corrigido\n\n- Coisa velha.");
  });
});
