import { describe, it, expect } from "vitest";
import { createTrace, fmtDuracao, larguras } from "../agent-trace.js";

/** Relógio controlado: o traço mede tempo de chegada, então o teste manda no tempo. */
function relogio(inicio = 1000) {
  let t = inicio;
  return { agora: () => t, avanca: (ms) => (t += ms) };
}

function montar(inicio) {
  const c = relogio(inicio);
  return { c, tr: createTrace({ agora: c.agora }) };
}

describe("etapas", () => {
  it("turno vazio não tem etapa nem duração", () => {
    const { tr } = montar();
    expect(tr.lista()).toEqual([]);
    expect(tr.resumo().ms).toBe(0);
  });

  it("iniciar com prompt marca o envio na régua", () => {
    const { tr } = montar();
    tr.iniciar("oi");
    const [p] = tr.lista();
    expect(p).toMatchObject({ tipo: "envio", rotulo: "Enviado", ms: 0, desdeInicio: 0 });
  });

  it("texto seguido é uma etapa só, com os caracteres somados", () => {
    const { c, tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "text", text: "oi " });
    c.avanca(300);
    tr.aplicar({ type: "text", text: "mundo" });
    c.avanca(200);
    tr.aplicar({ type: "done" });
    const passos = tr.lista();
    expect(passos).toHaveLength(1);
    expect(passos[0]).toMatchObject({ tipo: "text", chars: 8, ms: 500 });
  });

  it("pensamento seguido também vira uma etapa só", () => {
    const { c, tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "thinking", tokens: 10 });
    c.avanca(100);
    tr.aplicar({ type: "thinking", tokens: 40 });
    c.avanca(50);
    tr.aplicar({ type: "done" });
    const passos = tr.lista();
    expect(passos).toHaveLength(1);
    expect(passos[0]).toMatchObject({ tipo: "thinking", tokens: 40, ms: 150 });
  });

  it("cada ferramenta é uma etapa, mesmo duas iguais seguidas", () => {
    const { c, tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "tool", name: "Read", summary: "a.ts" });
    c.avanca(20);
    tr.aplicar({ type: "tool", name: "Read", summary: "b.ts" });
    c.avanca(30);
    tr.aplicar({ type: "done" });
    const passos = tr.lista();
    expect(passos.map((p) => p.detalhe)).toEqual(["a.ts", "b.ts"]);
    expect(passos.map((p) => p.ms)).toEqual([20, 30]);
  });

  it("a etapa anterior fecha quando a seguinte abre", () => {
    const { c, tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "thinking" });
    c.avanca(100);
    tr.aplicar({ type: "tool", name: "Bash" });
    c.avanca(400);
    tr.aplicar({ type: "text", text: "pronto" });
    c.avanca(60);
    tr.aplicar({ type: "done" });
    expect(tr.lista().map((p) => [p.tipo, p.ms])).toEqual([
      ["thinking", 100],
      ["tool", 400],
      ["text", 60],
    ]);
  });

  it("etapa ainda aberta mostra o tempo corrido até agora", () => {
    const { c, tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "tool", name: "Bash" });
    c.avanca(250);
    const [p] = tr.lista();
    expect(p).toMatchObject({ ms: 250, aberta: true });
    c.avanca(250);
    expect(tr.lista()[0].ms).toBe(500);
  });

  it("desdeInicio posiciona a etapa na régua do turno", () => {
    const { c, tr } = montar();
    tr.iniciar();
    c.avanca(100);
    tr.aplicar({ type: "thinking" });
    c.avanca(200);
    tr.aplicar({ type: "tool", name: "Read" });
    expect(tr.lista().map((p) => p.desdeInicio)).toEqual([100, 300]);
  });

  it("iniciar de novo descarta o turno anterior", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "text", text: "velho" });
    tr.iniciar();
    expect(tr.lista()).toEqual([]);
    expect(tr.resumo().input).toBe(0);
  });
});

describe("tokens e custo", () => {
  it("o total do turno soma todos os usage", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "usage", input: 100, output: 50, cacheRead: 10, cacheCreate: 5, costUsd: 0.01 });
    tr.aplicar({ type: "usage", input: 200, output: 80, cacheRead: 0, cacheCreate: 0, costUsd: 0.02 });
    const r = tr.resumo();
    expect(r).toMatchObject({ input: 300, output: 130, cacheRead: 10, cacheCreate: 5 });
    expect(r.custoUsd).toBeCloseTo(0.03, 6);
  });

  it("o usage cola na etapa aberta, marcada como aproximada", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "tool", name: "Bash" });
    tr.aplicar({ type: "usage", input: 100, output: 20, costUsd: 0.005 });
    const [p] = tr.lista();
    // 120 = input + output; "aproximado" porque o motor reporta por requisição,
    // não por etapa — ver o cabeçalho do módulo
    expect(p).toMatchObject({ tokens: 120, aproximado: true });
    expect(p.custoUsd).toBeCloseTo(0.005, 6);
  });

  it("usage sem etapa aberta cola na última fechada", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "tool", name: "Read" });
    tr.aplicar({ type: "done" });
    tr.aplicar({ type: "usage", input: 10, output: 5 });
    expect(tr.lista().at(-1).tokens).toBe(15);
  });

  it("context e session alimentam o resumo sem virar etapa", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "context", contextTokens: 12345 });
    tr.aplicar({ type: "session", model: "opus", contextWindow: 200000 });
    expect(tr.lista()).toEqual([]);
    expect(tr.resumo()).toMatchObject({ contextTokens: 12345, model: "opus", contextWindow: 200000 });
  });

  it("usage com contextTokens vence o context anterior", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "context", contextTokens: 100 });
    tr.aplicar({ type: "usage", input: 1, output: 1, contextTokens: 999 });
    expect(tr.resumo().contextTokens).toBe(999);
  });
});

describe("fim do turno", () => {
  it("done fecha e congela a duração", () => {
    const { c, tr } = montar();
    tr.iniciar();
    c.avanca(500);
    tr.aplicar({ type: "done" });
    expect(tr.resumo()).toMatchObject({ ms: 500, rodando: false, terminou: "done" });
    c.avanca(10_000);
    expect(tr.resumo().ms).toBe(500);
  });

  it("enquanto roda, a duração cresce", () => {
    const { c, tr } = montar();
    tr.iniciar();
    c.avanca(300);
    expect(tr.resumo()).toMatchObject({ ms: 300, rodando: true });
  });

  it("quota, auth e error viram etapa final com o motivo", () => {
    for (const [type, rotulo] of [
      ["quota", "Quota estourou"],
      ["auth", "Precisa de login"],
      ["error", "Erro do motor"],
    ]) {
      const { tr } = montar();
      tr.iniciar();
      tr.aplicar({ type, detail: "motivo aqui" });
      const ultimo = tr.lista().at(-1);
      expect(ultimo).toMatchObject({ tipo: "falha", rotulo, detalhe: "motivo aqui" });
      expect(tr.resumo().terminou).toBe(type);
    }
  });

  it("done não deixa etapa de falha", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "text", text: "a" });
    tr.aplicar({ type: "done" });
    expect(tr.lista().some((p) => p.tipo === "falha")).toBe(false);
  });

  it("error usa message quando não tem detail", () => {
    const { tr } = montar();
    tr.iniciar();
    tr.aplicar({ type: "error", message: "motor morreu" });
    expect(tr.lista().at(-1).detalhe).toBe("motor morreu");
  });
});

describe("resumo", () => {
  it("conta etapas e ferramentas separadamente", () => {
    const { tr } = montar();
    tr.iniciar("oi");
    tr.aplicar({ type: "tool", name: "Read" });
    tr.aplicar({ type: "tool", name: "Bash" });
    tr.aplicar({ type: "text", text: "ok" });
    tr.aplicar({ type: "done" });
    expect(tr.resumo()).toMatchObject({ passos: 4, ferramentas: 2 });
  });
});

describe("evento ignorado", () => {
  it("tipo desconhecido não muda nada e não pede redesenho", () => {
    const { tr } = montar();
    tr.iniciar();
    expect(tr.aplicar({ type: "coisa-nova" })).toBe(false);
    expect(tr.aplicar(null)).toBe(false);
    expect(tr.aplicar({})).toBe(false);
    expect(tr.lista()).toEqual([]);
  });

  it("tipos conhecidos pedem redesenho", () => {
    const { tr } = montar();
    tr.iniciar();
    for (const type of ["text", "thinking", "tool", "context", "usage", "session", "done"]) {
      expect(tr.aplicar({ type, text: "", name: "x" })).toBe(true);
    }
  });
});

describe("fmtDuracao", () => {
  it("as três faixas", () => {
    expect(fmtDuracao(0)).toBe("0ms");
    expect(fmtDuracao(999)).toBe("999ms");
    expect(fmtDuracao(1500)).toBe("1.5s");
    expect(fmtDuracao(59_000)).toBe("59.0s");
    expect(fmtDuracao(65_000)).toBe("1m05");
  });

  it("negativo e lixo não viram texto quebrado", () => {
    expect(fmtDuracao(-5)).toBe("0ms");
    expect(fmtDuracao(undefined)).toBe("0ms");
    expect(fmtDuracao("abc")).toBe("0ms");
  });
});

describe("larguras", () => {
  it("a mais longa é 100% e o resto é proporcional", () => {
    expect(larguras([{ ms: 1000 }, { ms: 500 }, { ms: 250 }])).toEqual([100, 50, 25]);
  });

  it("etapa de duração zero fica sem barra", () => {
    expect(larguras([{ ms: 0 }, { ms: 100 }])).toEqual([0, 100]);
  });

  it("barra minúscula tem piso de 2%: 1% seria invisível e mentiria", () => {
    expect(larguras([{ ms: 10_000 }, { ms: 1 }])).toEqual([100, 2]);
  });

  it("lista vazia e tudo em zero não estouram", () => {
    expect(larguras([])).toEqual([]);
    expect(larguras([{ ms: 0 }, { ms: 0 }])).toEqual([0, 0]);
  });
});
