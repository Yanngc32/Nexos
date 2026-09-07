import { describe, expect, it } from "vitest";
import { celAviso } from "../celular.js";

describe("celAviso", () => {
  it("endereço que não existe mais ganha de tudo", () => {
    // é a única situação em que a pessoa está olhando um endereço que parece
    // valer e não vale; qualquer outro aviso no lugar deste esconderia isso
    const a = celAviso("127.0.0.1", "100.101.102.103", "100.101.102.103");
    expect(a).toContain("100.101.102.103");
    expect(a).toContain("127.0.0.1");
    expect(a).toMatch(/ninguém alcança/);
  });

  it("mudou o campo e não reiniciou: diz que está esperando", () => {
    const a = celAviso("127.0.0.1", "100.101.102.103");
    expect(a).toMatch(/próxima subida/);
    expect(a).toContain("100.101.102.103");
    // e não pode parecer que já está valendo
    expect(a).toContain("127.0.0.1");
  });

  it("loopback avisa que o celular não alcança", () => {
    for (const h of ["127.0.0.1", "localhost", "::1"]) {
      expect(celAviso(h, h), h).toMatch(/só esta máquina/);
    }
  });

  it("escutar em tudo avisa mais alto que o loopback", () => {
    for (const h of ["0.0.0.0", "::"]) {
      expect(celAviso(h, h), h).toMatch(/rede inteira/);
    }
  });

  it("endereço de túnel valendo não inventa aviso", () => {
    expect(celAviso("100.101.102.103", "100.101.102.103")).toBe("");
  });
});
