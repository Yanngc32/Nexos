import { describe, expect, it } from "vitest";
import { aneisDeConta, custoDoRun, emVoo, faixaDoRun, passoAtual, runEmDestaque } from "../widget-view.js";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (ms) => new Date(T0 + ms).toISOString();

function run(over = {}) {
  return { id: "r1", status: "running", goal: "auditar", createdAt: iso(0), steps: [], ...over };
}

describe("runEmDestaque", () => {
  it("prefere o que está rodando ao que já terminou, mesmo sendo mais velho", () => {
    const velho = run({ id: "rodando", createdAt: iso(0) });
    const novo = run({ id: "feito", status: "done", createdAt: iso(9999) });
    expect(runEmDestaque([novo, velho])?.id).toBe("rodando");
  });

  it("entre dois rodando, o mais novo: é o que a pessoa acabou de disparar", () => {
    const a = run({ id: "a", createdAt: iso(0) });
    const b = run({ id: "b", createdAt: iso(500) });
    expect(runEmDestaque([a, b])?.id).toBe("b");
  });

  it("sem nenhum rodando, mostra o último que terminou", () => {
    const a = run({ id: "a", status: "done", createdAt: iso(0) });
    const b = run({ id: "b", status: "error", createdAt: iso(500) });
    expect(runEmDestaque([a, b])?.id).toBe("b");
  });

  it("lista vazia ou inválida não quebra", () => {
    expect(runEmDestaque([])).toBeNull();
    expect(runEmDestaque(null)).toBeNull();
  });
});

describe("passoAtual", () => {
  it("o membro ganha do supervisor: o supervisor fica aberto o run inteiro", () => {
    const r = run({
      steps: [
        { index: 0, agentId: "chefe", status: "running", supervisor: true },
        { index: 1, agentId: "leitor", status: "running" },
      ],
    });
    expect(passoAtual(r)?.agentId).toBe("leitor");
  });

  it("sem membro aberto, o supervisor serve", () => {
    const r = run({ steps: [{ index: 0, agentId: "chefe", status: "running", supervisor: true }] });
    expect(passoAtual(r)?.agentId).toBe("chefe");
  });

  it("nada aberto é nulo", () => {
    expect(passoAtual(run({ steps: [{ index: 0, agentId: "a", status: "done" }] }))).toBeNull();
  });
});

describe("custoDoRun", () => {
  it("soma os passos", () => {
    expect(custoDoRun(run({ steps: [{ costUsd: 0.1 }, { costUsd: 0.25 }] }))).toBeCloseTo(0.35);
  });

  it("inclui o gasto das tentativas anteriores: retomar não devolve dinheiro", () => {
    expect(custoDoRun(run({ gastoAnterior: 1, steps: [{ costUsd: 0.5 }] }))).toBeCloseTo(1.5);
  });
});

describe("faixaDoRun", () => {
  it("conta os passos fechados e mede o passo aberto contra o relógio", () => {
    const r = run({
      steps: [
        { index: 0, agentId: "a1", status: "done" },
        { index: 1, agentId: "a2", status: "running", startedAt: iso(1000) },
      ],
    });
    const f = faixaDoRun([r], T0 + 4000);
    expect(f).toMatchObject({ feitos: 1, total: 2, agente: "a2", rodando: true, ms: 3000 });
  });

  it("run sem passo aberto mede contra a criação, não contra nada", () => {
    const r = run({ steps: [{ index: 0, agentId: "a1", status: "pending" }] });
    expect(faixaDoRun([r], T0 + 2500).ms).toBe(2500);
  });

  it("leva o teto de custo quando existe, e nada quando não existe", () => {
    const comTeto = run({ budget: { maxUsd: 2 }, steps: [{ costUsd: 0.5 }] });
    expect(faixaDoRun([comTeto], T0)).toMatchObject({ custoUsd: 0.5, tetoUsd: 2 });
    expect(faixaDoRun([run()], T0).tetoUsd).toBe(0);
  });

  it("sem run nenhum, não há faixa", () => {
    expect(faixaDoRun([], T0)).toBeNull();
  });
});

describe("aneisDeConta", () => {
  const conta = (id, five, seven, over = {}) => ({
    id,
    engine: "claude",
    status: "ready",
    limits: { status: "allowed", fiveHour: { utilization: five }, sevenDay: { utilization: seven } },
    ...over,
  });

  it("usa a janela mais apertada da conta", () => {
    expect(aneisDeConta([conta("a", 0.2, 0.8)])[0].uso).toBeCloseTo(0.8);
  });

  it("ordena da mais apertada pra menos", () => {
    expect(aneisDeConta([conta("folgada", 0.1, 0.1), conta("cheia", 0.9, 0.2)]).map((a) => a.id)).toEqual([
      "cheia",
      "folgada",
    ]);
  });

  it("conta sem dado fica de fora: anel vazio pareceria quota sobrando", () => {
    expect(aneisDeConta([{ id: "nunca-rodou", engine: "claude", limits: null }])).toEqual([]);
  });

  it("prende o uso em 1: provedor às vezes passa do teto antes de recusar", () => {
    expect(aneisDeConta([conta("a", 1.4, 0.2)])[0].uso).toBe(1);
  });

  it("marca a conta recusada, que o anel cheio não distinguiria", () => {
    const bloqueada = conta("b", 0.3, 0.3, { status: "unauthenticated" });
    expect(aneisDeConta([bloqueada])[0].bloqueada).toBe(true);
  });
});

describe("emVoo", () => {
  const ag = (id, over = {}) => ({ threadId: id, profileId: "p1", busy: true, ...over });

  it("só o que está trabalhando agora", () => {
    expect(emVoo([ag("a"), ag("b", { busy: false })]).map((x) => x.threadId)).toEqual(["a"]);
  });

  it("tira os passos do run em destaque: já aparecem na faixa dele", () => {
    const lista = [ag("passo", { runId: "r1" }), ag("solta")];
    expect(emVoo(lista, "r1").map((x) => x.threadId)).toEqual(["solta"]);
  });

  it("sem run em destaque, os passos contam como conversa em voo", () => {
    expect(emVoo([ag("passo", { runId: "r1" })], "")).toHaveLength(1);
  });
});

describe("relógio do run fechado", () => {
  it("para no fim do run em vez de crescer pra sempre", () => {
    const r = run({
      status: "done",
      endedAt: iso(5000),
      steps: [{ index: 0, agentId: "a1", status: "done", startedAt: iso(1000) }],
    });
    // sem passo aberto o tempo é o do RUN, do começo ao fim — e uma hora depois
    // continua sendo esse, não a hora inteira
    expect(faixaDoRun([r], T0 + 3_600_000).ms).toBe(5000);
  });

  it("run fechado sem endedAt cai no relógio, em vez de zerar", () => {
    const r = run({ status: "error", steps: [{ index: 0, agentId: "a1", status: "error", startedAt: iso(0) }] });
    expect(faixaDoRun([r], T0 + 2000).ms).toBe(2000);
  });

  it("run em andamento continua crescendo", () => {
    const r = run({ steps: [{ index: 0, agentId: "a1", status: "running", startedAt: iso(0) }] });
    expect(faixaDoRun([r], T0 + 7000).ms).toBe(7000);
  });
});
