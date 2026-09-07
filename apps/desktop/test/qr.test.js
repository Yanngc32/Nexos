import { describe, expect, it } from "vitest";
import { qrMatriz, qrSvg } from "../qr.js";
import { REFERENCIA } from "./qr-fixtures.js";

/** Onde o padrão localizador tem que estar, e o que ele tem que ser. */
function localizador(m, oi, oj) {
  const linhas = [];
  for (let i = 0; i < 7; i++) {
    linhas.push(
      m[oi + i]
        .slice(oj, oj + 7)
        .map((v) => (v ? "1" : "0"))
        .join(""),
    );
  }
  return linhas.join("|");
}

const LOCALIZADOR = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"].join("|");

/** Refaz o BCH do formato pra conferir os 15 bits que a matriz carrega. */
function formatoDaMatriz(m) {
  const lado = m.length;
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    const linha = i < 6 ? i : i < 8 ? i + 1 : lado - 15 + i;
    if (m[linha][8]) bits |= 1 << i;
  }
  bits ^= 0x5412;
  let r = bits;
  for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
  return { nivel: (bits >>> 13) & 3, mascara: (bits >>> 10) & 7, resto: r & 0x3ff };
}

describe("qrMatriz", () => {
  it("bate módulo a módulo com uma implementação de referência", () => {
    for (const caso of REFERENCIA) {
      const meu = qrMatriz(caso.texto).map((l) => l.map((v) => (v ? "1" : "0")).join(""));
      expect(meu, `texto ${JSON.stringify(caso.texto.slice(0, 20))}`).toEqual(caso.linhas);
      expect(meu.length).toBe(17 + 4 * caso.versao);
    }
  });

  it("escolhe a menor versão que couber, e o limite bate com a capacidade da norma", () => {
    // v1..v10 no nível M, modo byte: o último tamanho que cabe em cada versão
    const limites = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    for (let v = 1; v <= limites.length; v++) {
      const lado = 17 + 4 * v;
      expect(qrMatriz("x".repeat(limites[v - 1])).length, `v${v} no limite`).toBe(lado);
      if (v > 1) {
        expect(qrMatriz("x".repeat(limites[v - 2] + 1)).length, `v${v} um byte além da anterior`).toBe(lado);
      }
    }
  });

  it("recusa texto que não cabe, em vez de truncar", () => {
    // truncar é o pior desfecho possível: o QR escaneia e leva pro lugar errado
    expect(() => qrMatriz("x".repeat(214))).toThrow(/longo demais/);
  });

  it("conta bytes, não caracteres — acento e emoji ocupam mais de um", () => {
    // 213 caracteres ASCII cabem; 213 caracteres de 2 bytes não
    expect(() => qrMatriz("x".repeat(213))).not.toThrow();
    expect(() => qrMatriz("ç".repeat(213))).toThrow(/longo demais/);
  });

  it("põe os três localizadores no lugar, e nenhum no quarto canto", () => {
    for (const texto of ["a", "x".repeat(100), "x".repeat(213)]) {
      const m = qrMatriz(texto);
      const lado = m.length;
      expect(localizador(m, 0, 0)).toBe(LOCALIZADOR);
      expect(localizador(m, 0, lado - 7)).toBe(LOCALIZADOR);
      expect(localizador(m, lado - 7, 0)).toBe(LOCALIZADOR);
      expect(localizador(m, lado - 7, lado - 7)).not.toBe(LOCALIZADOR);
    }
  });

  it("alterna a linha e a coluna de temporização e acende o módulo escuro fixo", () => {
    for (const texto of ["a", "x".repeat(100), "x".repeat(213)]) {
      const m = qrMatriz(texto);
      for (let i = 8; i < m.length - 8; i++) {
        expect(m[6][i], `linha 6, coluna ${i}`).toBe(i % 2 === 0);
        expect(m[i][6], `coluna 6, linha ${i}`).toBe(i % 2 === 0);
      }
      expect(m[m.length - 8][8]).toBe(true);
    }
  });

  it("grava um formato válido, com o nível M e a máscara que escolheu", () => {
    for (const texto of ["a", "x".repeat(100), "x".repeat(213)]) {
      const { nivel, mascara, resto } = formatoDaMatriz(qrMatriz(texto));
      expect(resto, "resto do BCH tem que ser zero num formato íntegro").toBe(0);
      expect(nivel, "0b00 é o nível M").toBe(0);
      expect(mascara).toBeGreaterThanOrEqual(0);
      expect(mascara).toBeLessThan(8);
    }
  });
});

describe("qrSvg", () => {
  const url = "http://100.101.102.103:7432/app/#c=907952";

  it("deixa 4 módulos de margem clara em volta", () => {
    const lado = qrMatriz(url).length;
    // sem a margem o leitor não acha a borda do símbolo
    expect(qrSvg(url)).toContain(`viewBox="0 0 ${lado + 8} ${lado + 8}"`);
    expect(qrSvg(url, { margem: 0 })).toContain(`viewBox="0 0 ${lado} ${lado}"`);
  });

  it("desenha um módulo escuro por vez, e só os escuros", () => {
    const m = qrMatriz(url);
    const escuros = m.flat().filter(Boolean).length;
    const svg = qrSvg(url);
    expect(svg.match(/M\d+ \d+h1v1h-1z/g)).toHaveLength(escuros);
    expect(svg).toContain('fill="#000"');
    expect(svg).toContain('fill="#fff"'); // fundo claro próprio, não o do painel
  });

  it("não abre porta pra script nem pra carga externa", () => {
    const svg = qrSvg(url);
    expect(svg).not.toMatch(/<script|href|xlink|<image|<foreignObject/i);
    expect(svg).toContain('shape-rendering="crispEdges"'); // QR interpolado não escaneia
  });
});
