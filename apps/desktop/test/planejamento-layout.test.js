import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
  COL_GAP,
  FIRST_CARD_Y,
  ROW_GAP,
  SEM_ETAPA,
  calcularLayout,
  caminhoDaAresta,
  diffPlano,
  extrairRefs,
  proximoStatus,
  resolverRef,
} from "../planejamento-layout.js";

const etapas = [
  { id: "a", titulo: "A", status: "concluida" },
  { id: "b", titulo: "B", status: "em_andamento" },
];
const card = (id, extra = {}) => ({ id, tipo: "nota", titulo: id.toUpperCase(), links: [], rev: 1, corpo: "", ...extra });

describe("calcularLayout", () => {
  it("uma coluna por etapa, na ordem; cards empilhados sem sobrepor", () => {
    const l = calcularLayout({ roteiro: { etapas }, cards: [card("x", { etapa: "a" }), card("y", { etapa: "a" }), card("z", { etapa: "b" })] });
    expect(l.colunas.map((c) => [c.id, c.x])).toEqual([
      ["a", 0],
      ["b", CARD_W + COL_GAP],
    ]);
    expect(l.posicoes.x).toEqual({ x: 0, y: FIRST_CARD_Y });
    expect(l.posicoes.y).toEqual({ x: 0, y: FIRST_CARD_Y + CARD_H + ROW_GAP });
    expect(l.posicoes.z).toEqual({ x: CARD_W + COL_GAP, y: FIRST_CARD_Y });
  });

  it("card sem etapa (ou com etapa que saiu do roteiro) vai pra coluna 'Sem etapa' no fim", () => {
    const l = calcularLayout({ roteiro: { etapas }, cards: [card("s"), card("v", { etapa: "sumiu" })] });
    expect(l.colunas.at(-1)).toMatchObject({ id: SEM_ETAPA, titulo: "Sem etapa", cardIds: ["s", "v"] });
  });

  it("plano vazio ainda tem a coluna 'Sem etapa' (onde o + Card cai)", () => {
    expect(calcularLayout({ roteiro: { etapas: [] }, cards: [] }).colunas.map((c) => c.id)).toEqual([SEM_ETAPA]);
  });

  it("posição salva ganha, e card novo entra abaixo do que já ocupa a faixa da coluna", () => {
    const l = calcularLayout({
      roteiro: { etapas },
      cards: [card("salvo", { etapa: "b" }), card("novo", { etapa: "a" })],
      layout: { posicoes: { salvo: { x: 10, y: 400 } } },
    });
    expect(l.posicoes.salvo).toEqual({ x: 10, y: 400 });
    expect(l.posicoes.novo.y).toBe(400 + CARD_H + ROW_GAP);
  });

  it("arestas: sequência entre etapas, ligação explícita e [[referência]] sem repetir", () => {
    const l = calcularLayout({
      roteiro: { etapas },
      cards: [
        card("x", { etapa: "a", links: ["y", "fantasma"], corpo: "ver [[Y]] e [[z]] e [[nada]]" }),
        card("y", { etapa: "b" }),
        card("z", { etapa: "b", titulo: "Zê" }),
      ],
    });
    expect(l.arestas.map((a) => a.id)).toEqual(["seq:a>b", "link:x>y", "ref:x>z"]);
    expect(l.arestas.map((a) => a.tipo)).toEqual(["sequencia", "ligacao", "referencia"]);
  });
});

describe("refs e utilitários", () => {
  it("[[ref]] casa por id ou título sem caixa/acento; ambíguo não casa", () => {
    const cards = [card("banco", { titulo: "Decisão do Banco" }), card("a", { titulo: "Dup" }), card("b", { titulo: "dup" })];
    expect(extrairRefs("[[decisao do banco]] [[banco]] [[decisao do banco]]")).toEqual(["decisao do banco", "banco"]);
    expect(resolverRef("DECISÃO do banco", cards)).toBe("banco");
    expect(resolverRef("dup", cards)).toBeNull();
  });

  it("caminho: destino à direita sai pela borda direita; mesma coluna sai por baixo", () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    expect(caminhoDaAresta(a, { x: 300, y: 0, w: 100, h: 50 })).toMatch(/^M 100 25 C/);
    expect(caminhoDaAresta(a, { x: 0, y: 200, w: 100, h: 50 })).toMatch(/^M 50 50 C .* 50 200$/);
  });

  it("status roda pendente → em andamento → concluída → pendente", () => {
    expect(["pendente", "em_andamento", "concluida"].map(proximoStatus)).toEqual(["em_andamento", "concluida", "pendente"]);
  });
});

describe("diffPlano", () => {
  const antes = {
    roteiro: { rev: 1, etapas: [{ id: "a", titulo: "A", status: "pendente" }] },
    cards: [card("x", { etapa: "a" }), card("y", { etapa: "a" })],
  };
  it("etapa nova, status mudado, card novo, card alterado e ligação nova", () => {
    const depois = {
      roteiro: { rev: 2, etapas: [{ id: "a", titulo: "A", status: "concluida" }, { id: "b", titulo: "B", status: "pendente" }] },
      cards: [card("x", { etapa: "a", rev: 2, links: ["y"] }), card("y", { etapa: "a" }), card("z", { etapa: "b" })],
    };
    expect(diffPlano(antes, depois)).toEqual({
      etapasNovas: ["b"],
      statusMudou: ["a"],
      cardsNovos: ["z"],
      cardsAlterados: ["x"],
      arestasNovas: ["seq:a>b", "link:x>y"],
    });
  });
  it("eco da própria escrita não anima", () => {
    const depois = { roteiro: { rev: 2, etapas: [{ id: "a", titulo: "A", status: "concluida" }] }, cards: [card("x", { etapa: "a", rev: 2, links: ["y"] }), card("y", { etapa: "a" })] };
    expect(diffPlano(antes, depois, new Set(["roteiro:2", "card:x:2"]))).toEqual({ etapasNovas: [], statusMudou: [], cardsNovos: [], cardsAlterados: [], arestasNovas: [] });
  });
  it("sem leitura anterior, nada", () => {
    expect(diffPlano(null, antes).cardsNovos).toEqual([]);
  });
});
