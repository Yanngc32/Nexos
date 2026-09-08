import { describe, expect, it } from "vitest";
import { alcancaveis, celAlcance, celAviso } from "../celular.js";

const e = (hosts, falhas = [], port = 7432) => ({ hosts, falhas, port, melhor: hosts[0] });

describe("alcancaveis", () => {
  it("loopback não conta — nenhum celular chega nele", () => {
    expect(alcancaveis(["127.0.0.1", "localhost", "::1"])).toEqual([]);
    expect(alcancaveis(["127.0.0.1", "100.101.102.103"])).toEqual(["100.101.102.103"]);
  });

  it("sem lista não estoura", () => {
    expect(alcancaveis()).toEqual([]);
  });
});

describe("celAlcance", () => {
  it("com túnel, diz onde e diz quem chega", () => {
    const t = celAlcance(e(["127.0.0.1", "100.101.102.103"]));
    expect(t).toContain("100.101.102.103:7432");
    expect(t).toMatch(/túnel/);
  });

  it("lista os dois quando há dois túneis", () => {
    const t = celAlcance(e(["127.0.0.1", "100.64.0.1", "10.8.0.2"]));
    expect(t).toContain("100.64.0.1:7432");
    expect(t).toContain("10.8.0.2:7432");
  });

  it("IPv6 vai entre colchetes — senão parece porta 115c", () => {
    const t = celAlcance(e(["127.0.0.1", "fd7a:115c:a1e0::1"]));
    expect(t).toContain("[fd7a:115c:a1e0::1]:7432");
    expect(t).not.toContain("fd7a:115c:a1e0::1:7432");
  });

  it("só loopback: diz o que fazer, e que não precisa reiniciar", () => {
    // o "vale a partir da próxima subida" morreu; prometer reinício aqui seria
    // mandar a pessoa fazer trabalho que o daemon já faz
    const t = celAlcance(e(["127.0.0.1"]));
    expect(t).toMatch(/túnel/);
    expect(t).toMatch(/sem reiniciar/);
  });

  it("rede inteira é dito com o nome que tem", () => {
    expect(celAlcance(e(["0.0.0.0"]))).toMatch(/rede inteira/);
  });

  it("nada escutando manda ligar o motor, em vez de mentir", () => {
    expect(celAlcance(e([]))).toMatch(/não está escutando/);
    expect(celAlcance(null)).toMatch(/não está escutando/);
  });

  it("usa a porta efetiva, não a padrão", () => {
    expect(celAlcance(e(["127.0.0.1", "100.64.0.1"], [], 7499))).toContain("100.64.0.1:7499");
  });
});

describe("celAviso", () => {
  it("endereço que falhou ganha de tudo, e explica que volta sozinho", () => {
    const t = celAviso(e(["127.0.0.1"], [{ host: "100.101.102.103", motivo: "EADDRNOTAVAIL" }]));
    expect(t).toContain("100.101.102.103");
    expect(t).toContain("EADDRNOTAVAIL");
    expect(t).toMatch(/entra sozinho/);
  });

  it("rede inteira avisa", () => {
    expect(celAviso(e(["0.0.0.0"]))).toMatch(/única barreira/);
  });

  it("o caso bom não gasta linha", () => {
    // aviso permanente vira ruído e a pessoa para de ler o que importa
    expect(celAviso(e(["127.0.0.1"]))).toBe("");
    expect(celAviso(e(["127.0.0.1", "100.64.0.1"]))).toBe("");
    expect(celAviso(null)).toBe("");
  });
});
