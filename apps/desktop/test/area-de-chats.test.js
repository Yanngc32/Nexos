import { describe, expect, it } from "vitest";
import {
  LARGURA_MIN_CHAT,
  alvoDoSoltar,
  arrastarDivisor,
  distribuir,
  pillDoChat,
  quemSaiPraAbrir,
  reordenar,
  rotuloDoChip,
  tempoCurto,
  retratoDaArea,
  lerRetratoDaArea,
  retratoDoPlano,
  lerRetratoDoPlano,
} from "../area-de-chats.js";

const c = (id, o = {}) => ({ id, ...o });

describe("alvoDoSoltar", () => {
  it("com menos de 3: borda (25%) divide, meio substitui", () => {
    expect(alvoDoSoltar({ total: 1, x: 10, largura: 400 })).toBe("esquerda");
    expect(alvoDoSoltar({ total: 2, x: 390, largura: 400 })).toBe("direita");
    expect(alvoDoSoltar({ total: 2, x: 200, largura: 400 })).toBe("substituir");
    expect(alvoDoSoltar({ total: 1, x: 100, largura: 400 })).toBe("substituir");
  });
  it("com 3 abertos sempre substitui", () => {
    expect(alvoDoSoltar({ total: 3, x: 1, largura: 400 })).toBe("substituir");
  });
});

describe("quemSaiPraAbrir", () => {
  it("sai o que está há mais tempo sem foco, nunca o em foco", () => {
    const a = c("a", { focadoEm: 1 });
    const b = c("b", { focadoEm: 5 });
    const d = c("d", { focadoEm: 3 });
    expect(quemSaiPraAbrir([a, b, d], b)).toBe(a);
    expect(quemSaiPraAbrir([a, b, d], a)).toBe(d);
    expect(quemSaiPraAbrir([a], a)).toBe(null);
  });
});

describe("distribuir", () => {
  it("minimizado vira chip; o resto abre", () => {
    const a = c("a");
    const b = c("b", { minimizado: true });
    const d = c("d");
    expect(distribuir({ chats: [a, b, d], foco: a, largura: 1200 })).toEqual({ abertos: [a, d], chips: [b] });
  });
  it("o que não cabe vira chip a partir do fim, o foco fica", () => {
    const a = c("a");
    const b = c("b");
    const d = c("d");
    const r = distribuir({ chats: [a, b, d], foco: d, largura: 800 });
    expect(r.abertos).toEqual([a, d]);
    expect(r.chips).toEqual([b]);
  });
  it("abaixo de 760px só um chat aberto (o em foco)", () => {
    const a = c("a");
    const b = c("b");
    expect(distribuir({ chats: [a, b], foco: b, largura: 700 })).toEqual({ abertos: [b], chips: [a] });
  });
  it("tudo minimizado: nenhum aberto", () => {
    const a = c("a", { minimizado: true });
    expect(distribuir({ chats: [a], foco: a, largura: 1200 })).toEqual({ abertos: [], chips: [a] });
  });
  it("maximizado: só ele aberto, os outros viram chip", () => {
    const a = c("a");
    const b = c("b");
    expect(distribuir({ chats: [a, b], foco: a, largura: 1200, maximizado: b })).toEqual({ abertos: [b], chips: [a] });
  });
  it("largura desconhecida (0) não esconde ninguém", () => {
    const a = c("a");
    const b = c("b");
    expect(distribuir({ chats: [a, b], foco: a, largura: 0 }).abertos).toEqual([a, b]);
  });
});

describe("pillDoChat", () => {
  it("prioridade: pergunta > erro > rodando > terminou", () => {
    expect(pillDoChat({ perguntas: 1, erro: "Sem cota", rodando: true })).toEqual({ tipo: "pergunta", texto: "Pergunta esperando", contador: 1 });
    expect(pillDoChat({ erro: "Sem cota", rodando: true }).tipo).toBe("erro");
    expect(pillDoChat({ rodando: true, terminou: true }).tipo).toBe("rodando");
    expect(pillDoChat({ terminou: true })).toEqual({ tipo: "terminou", texto: "Terminou" });
    expect(pillDoChat({})).toBe(null);
  });
  it("rodando mostra há quanto tempo", () => {
    expect(pillDoChat({ rodando: true, desde: 1000, agora: 121_000 }).texto).toBe("Rodando · 2 min");
    expect(pillDoChat({ rodando: true }).texto).toBe("Rodando");
  });
  it("rótulo do chip leva o estado", () => {
    expect(rotuloDoChip("Revisar", pillDoChat({ perguntas: 1 }))).toBe("Revisar, pergunta esperando");
    expect(rotuloDoChip("Revisar", null)).toBe("Revisar");
  });
});

describe("tempoCurto", () => {
  it("segundos, minutos, horas", () => {
    expect(tempoCurto(40_000)).toBe("40 s");
    expect(tempoCurto(125_000)).toBe("2 min");
    expect(tempoCurto(3_900_000)).toBe("1 h 5 min");
    expect(tempoCurto(7_200_000)).toBe("2 h");
  });
});

describe("reordenar", () => {
  it("move pra antes/depois do alvo", () => {
    const [a, b, d] = [c("a"), c("b"), c("d")];
    expect(reordenar([a, b, d], d, a, "esquerda")).toEqual([d, a, b]);
    expect(reordenar([a, b, d], a, d, "direita")).toEqual([b, d, a]);
    expect(reordenar([a, b], a, a, "direita")).toEqual([a, b]);
  });
});

describe("arrastarDivisor", () => {
  it("mantém a soma dos pesos e respeita a largura mínima", () => {
    const r = arrastarDivisor({ pesoA: 1, pesoB: 1, larguraA: 500, larguraB: 500, dx: 100 });
    expect(r.pesoA + r.pesoB).toBeCloseTo(2);
    expect(r.pesoA).toBeCloseTo(1.2);
    const limite = arrastarDivisor({ pesoA: 1, pesoB: 1, larguraA: 500, larguraB: 500, dx: 400 });
    expect(limite.pesoB).toBeCloseTo((2 * LARGURA_MIN_CHAT) / 1000);
  });
});

describe("layout lembrado", () => {
  it("retrato da área: só chats com conversa, foco pelo índice, peso saneado", () => {
    const a = c("a", { threadId: "A", projeto: "/p", peso: 1.23456 });
    const vazio = c("v", { threadId: "" });
    const b = c("b", { threadId: "B", minimizado: true, peso: NaN });
    expect(retratoDaArea([a, vazio, b], b)).toEqual({
      chats: [
        { threadId: "A", projeto: "/p", minimizado: false, peso: 1.235 },
        { threadId: "B", projeto: null, minimizado: true, peso: 1 },
      ],
      foco: 1,
    });
  });
  it("ler retrato: ida e volta, poda duplicado, corta em 3 e rejeita lixo", () => {
    const r = { chats: [{ threadId: "A" }, { threadId: "A" }, { threadId: "B", minimizado: true }, { threadId: "C" }, { threadId: "D" }], foco: 9 };
    const lido = lerRetratoDaArea(JSON.stringify(r));
    expect(lido.chats.map((x) => x.threadId)).toEqual(["A", "B", "C"]);
    expect(lido.chats[1].minimizado).toBe(true);
    expect(lido.foco).toBe(0);
    expect(lerRetratoDaArea("{quebrado")).toBe(null);
    expect(lerRetratoDaArea(JSON.stringify({ chats: [] }))).toBe(null);
    expect(lerRetratoDaArea(null)).toBe(null);
  });
  it("retrato do plano: ida e volta e padrão com lixo", () => {
    const r = retratoDoPlano({ faixa: 300.4, manager: { minimizado: true, peso: 1.5 }, impl: { peso: 0.5 }, lateral: true });
    expect(lerRetratoDoPlano(JSON.stringify(r))).toEqual({ faixa: 300, minimizados: [true, false], pesos: [1.5, 0.5], lateral: true });
    expect(lerRetratoDoPlano('{"faixa":-1,"pesos":[1]}')).toEqual({ faixa: null, minimizados: [false, false], pesos: [1, 1], lateral: false });
    expect(lerRetratoDoPlano("x")).toBe(null);
  });
});
