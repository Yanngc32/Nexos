// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { casasDaColuna, filtrar, fmtFloat, montar, numeroDe, ordenar, textoDaCelula, tipoDaColuna } from "../../daemon/visualizador/visualizador.js";

describe("visualizador (cliente): regras", () => {
  it("dtype como o pandas", () => {
    expect(tipoDaColuna(["1", "2", null])).toBe("int64");
    expect(tipoDaColuna(["1.5", "2"])).toBe("float64");
    expect(tipoDaColuna(["1.234,56", "10"], ",")).toBe("float64");
    expect(tipoDaColuna([1, 2.5])).toBe("float64");
    expect(tipoDaColuna([true, false])).toBe("bool");
    expect(tipoDaColuna(["2024-01-01", "31/12/2023"])).toBe("datetime64");
    expect(tipoDaColuna(["a", "1"])).toBe("object");
    expect(tipoDaColuna([null, ""])).toBe("object");
    expect(numeroDe("1.234,56", ",")).toBe(1234.56);
    expect(numeroDe("12.5", ",")).toBe(12.5);
    expect(numeroDe("abc")).toBeNull();
  });

  it("ordena por número, nulo por último, empate na ordem original", () => {
    const linhas = [["10"], [null], ["2"], ["10"]];
    expect(ordenar([0, 1, 2, 3], linhas, 0, "asc", "int64")).toEqual([2, 0, 3, 1]);
    expect(ordenar([0, 1, 2, 3], linhas, 0, "desc", "int64")).toEqual([0, 3, 2, 1]);
    const datas = [["31/12/2023"], ["2024-01-01"], ["01/06/2023"]];
    expect(ordenar([0, 1, 2], datas, 0, "asc", "datetime64")).toEqual([2, 0, 1]);
  });

  it("float com as casas da coluna, até 6 (display.precision do pandas)", () => {
    expect(casasDaColuna(["1.7", "2.25", null])).toBe(2);
    expect(casasDaColuna(["10.01552464953271", "1.7"])).toBe(6);
    expect(casasDaColuna([3, 4.5])).toBe(1);
    expect(fmtFloat(1.7, 2)).toBe("1.70");
    expect(fmtFloat(10.01552464953271, 6)).toBe("10.015525");
    expect(fmtFloat(1234.5, 2, ",")).toBe("1234,50");
  });

  it("filtro ignora maiúscula e acento; célula como o pandas escreve", () => {
    const linhas = [["São Paulo", 1], ["Rio", null]];
    expect(filtrar(linhas, "sao")).toEqual([0]);
    expect(filtrar(linhas, "  ")).toEqual([0, 1]);
    expect(textoDaCelula(null)).toBe("NaN");
    expect(textoDaCelula(true)).toBe("True");
    expect(textoDaCelula(0.1 + 0.2)).toBe("0.3");
  });
});

describe("visualizador (cliente): tela", () => {
  const planilha = (n) => ({
    nome: "dados",
    colunas: ["cidade", "pop"],
    linhas: Array.from({ length: n }, (_x, i) => [`c${i}`, String(n - i)]),
    total: n,
  });

  it("tabela: índice, dtype, forma, paginação de 50 e ordenar pelo cabeçalho", () => {
    const raiz = document.createElement("main");
    montar(raiz, { tipo: "tabela", planilhas: [planilha(120)] });
    const ths = [...raiz.querySelectorAll("thead th")];
    expect(ths.map((t) => t.querySelector(".vz-col-nome")?.textContent ?? "")).toEqual(["", "cidade", "pop"]);
    expect([...raiz.querySelectorAll(".vz-dtype")].map((d) => d.textContent)).toEqual(["object", "int64"]);
    expect(raiz.querySelectorAll("tbody tr")).toHaveLength(50);
    expect(raiz.querySelector(".vz-forma")?.textContent).toBe("120 linhas × 2 colunas");
    expect(raiz.querySelector(".vz-faixa")?.textContent).toBe("1–50 de 120");

    // ordenar por pop (crescente): a linha de menor pop é a última original (índice 119)
    raiz.querySelectorAll(".vz-col")[1].click();
    expect(raiz.querySelector("tbody tr th")?.textContent).toBe("119");
    expect(raiz.querySelectorAll("thead th")[2].getAttribute("aria-sort")).toBe("ascending");

    raiz.querySelectorAll(".vz-pag")[1].click();
    expect(raiz.querySelector(".vz-faixa")?.textContent).toBe("51–100 de 120");
  });

  it("aviso quando a planilha veio cortada; abas quando há mais de uma", () => {
    const raiz = document.createElement("main");
    const cortada = { ...planilha(3), total: 50_000 };
    montar(raiz, { tipo: "tabela", planilhas: [cortada, { ...planilha(2), nome: "Outra" }] });
    expect(raiz.querySelector(".vz-aviso")?.textContent).toContain("primeiras 3 de 50.000");
    const abas = raiz.querySelectorAll(".vz-aba");
    expect([...abas].map((a) => a.textContent)).toEqual(["dados", "Outra"]);
    abas[1].click();
    expect(raiz.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("markdown: Formatado e Texto; link abre fora", () => {
    const raiz = document.createElement("main");
    montar(raiz, { tipo: "markdown", html: '<h1>Oi</h1><p><a href="https://x.dev">x</a></p>', texto: "# Oi\n[x](https://x.dev)" });
    expect(raiz.querySelector(".vz-md h1")?.textContent).toBe("Oi");
    expect(raiz.querySelector(".vz-md a")?.getAttribute("target")).toBe("_blank");
    raiz.querySelectorAll(".vz-seg-btn")[1].click();
    expect(raiz.querySelector(".vz-calha")?.textContent).toBe("1\n2");
    expect(raiz.querySelector(".vz-texto")?.textContent).toBe("# Oi\n[x](https://x.dev)");
  });

  it("JSON: realce escapa o conteúdo", () => {
    const raiz = document.createElement("main");
    montar(raiz, { tipo: "codigo", texto: '{"a": "<img src=x onerror=alert(1)>", "n": 2}', linguagem: "json" });
    expect(raiz.querySelector("img")).toBeNull();
    expect(raiz.querySelector(".vz-j-chave")?.textContent).toBe('"a"');
    expect(raiz.querySelector(".vz-j-num")?.textContent).toBe("2");
  });
});
