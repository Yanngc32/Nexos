import { describe, it, expect } from "vitest";
import {
  aplicarEventoDeRun,
  duracaoDoPasso,
  larguraDosPassos,
  passoEmVoo,
  resumoDoRun,
  rotuloDoPasso,
  runFechado,
} from "../run-view.js";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const iso = (ms) => new Date(T0 + ms).toISOString();

function run(over = {}) {
  return {
    id: "r-1",
    status: "running",
    createdAt: iso(0),
    steps: [
      { index: 0, agentId: "a1", status: "pending" },
      { index: 1, agentId: "a2", status: "pending" },
    ],
    ...over,
  };
}

describe("aplicarEventoDeRun", () => {
  it("step_start abre o passo e guarda a conversa", () => {
    const r = run();
    expect(aplicarEventoDeRun(r, { type: "step_start", runId: "r-1", index: 0, threadId: "t-9" })).toBe(true);
    expect(r.steps[0]).toMatchObject({ status: "running", threadId: "t-9" });
    expect(r.steps[0].startedAt).toBeTruthy();
  });

  it("step_done troca o passo inteiro pelo que o daemon mandou", () => {
    const r = run();
    const passo = { index: 0, agentId: "a1", status: "done", tokens: 120, costUsd: 0.01 };
    aplicarEventoDeRun(r, { type: "step_done", runId: "r-1", index: 0, step: passo });
    expect(r.steps[0]).toEqual(passo);
  });

  it("run_end grava status, erro e fim", () => {
    const r = run();
    aplicarEventoDeRun(r, { type: "run_end", runId: "r-1", status: "error", error: "quota" });
    expect(r).toMatchObject({ status: "error", error: "quota" });
    expect(r.endedAt).toBeTruthy();
  });

  it("evento de outro run é ignorado", () => {
    const r = run();
    expect(aplicarEventoDeRun(r, { type: "run_end", runId: "r-outro", status: "done" })).toBe(false);
    expect(r.status).toBe("running");
  });

  it("índice fora da lista não estoura", () => {
    const r = run();
    expect(aplicarEventoDeRun(r, { type: "step_start", runId: "r-1", index: 99, threadId: "x" })).toBe(false);
    expect(aplicarEventoDeRun(r, { type: "step_done", runId: "r-1", index: 99, step: {} })).toBe(false);
  });

  it("entrada inválida não pede redesenho", () => {
    expect(aplicarEventoDeRun(null, { type: "run_end" })).toBe(false);
    expect(aplicarEventoDeRun(run(), null)).toBe(false);
    expect(aplicarEventoDeRun(run(), { type: "coisa-nova" })).toBe(false);
  });

  it("step_start não reescreve o início se já havia um", () => {
    const r = run({ steps: [{ index: 0, status: "pending", startedAt: iso(500) }] });
    aplicarEventoDeRun(r, { type: "step_start", runId: "r-1", index: 0, threadId: "t" });
    expect(r.steps[0].startedAt).toBe(iso(500));
  });
});

describe("duracaoDoPasso", () => {
  it("passo fechado usa o que o daemon mediu, não o relógio local", () => {
    const s = { startedAt: iso(0), endedAt: iso(3000), status: "done" };
    expect(duracaoDoPasso(s, T0 + 999_999)).toBe(3000);
  });

  it("passo aberto cresce contra o relógio", () => {
    const s = { startedAt: iso(0), status: "running" };
    expect(duracaoDoPasso(s, T0 + 1500)).toBe(1500);
    expect(duracaoDoPasso(s, T0 + 4000)).toBe(4000);
  });

  it("passo que não começou tem duração zero, não 'agora'", () => {
    expect(duracaoDoPasso({ status: "pending" }, T0 + 999_999)).toBe(0);
    expect(duracaoDoPasso(undefined, T0)).toBe(0);
  });

  it("data inválida não vira número negativo nem NaN", () => {
    expect(duracaoDoPasso({ startedAt: "não é data" }, T0)).toBe(0);
    expect(duracaoDoPasso({ startedAt: iso(5000), endedAt: iso(1000) }, T0)).toBe(0);
  });
});

describe("resumoDoRun", () => {
  it("soma tokens e custo dos passos", () => {
    const r = run({
      steps: [
        { status: "done", tokens: 100, costUsd: 0.01 },
        { status: "done", tokens: 250, costUsd: 0.02 },
      ],
    });
    const s = resumoDoRun(r, T0);
    expect(s.tokens).toBe(350);
    expect(s.custoUsd).toBeCloseTo(0.03, 6);
    expect(s).toMatchObject({ concluidos: 2, total: 2 });
  });

  it("rodando: o tempo cresce; fechado: congela no endedAt", () => {
    const vivo = run();
    expect(resumoDoRun(vivo, T0 + 5000).ms).toBe(5000);
    const morto = run({ status: "done", endedAt: iso(2000) });
    expect(resumoDoRun(morto, T0 + 999_999).ms).toBe(2000);
    expect(resumoDoRun(morto, T0).rodando).toBe(false);
  });

  it("o tempo dos passos é menor que o do run: a montagem também conta", () => {
    const r = run({
      status: "done",
      endedAt: iso(5000),
      steps: [{ startedAt: iso(1000), endedAt: iso(2000), status: "done" }],
    });
    const s = resumoDoRun(r, T0);
    expect(s.msDosPassos).toBe(1000);
    expect(s.ms).toBe(5000);
  });

  it("run vazio ou nulo não estoura", () => {
    expect(resumoDoRun(null, T0)).toMatchObject({ ms: 0, tokens: 0, total: 0 });
    expect(resumoDoRun({ steps: [] }, T0).total).toBe(0);
  });
});

describe("passoEmVoo e runFechado", () => {
  it("acha o passo rodando; sem nenhum, undefined", () => {
    const r = run({ steps: [{ status: "done" }, { status: "running", agentId: "a2" }] });
    expect(passoEmVoo(r)?.agentId).toBe("a2");
    expect(passoEmVoo(run())).toBeUndefined();
  });

  it("fechado é qualquer coisa que não seja running", () => {
    expect(runFechado(run())).toBe(false);
    for (const status of ["done", "error", "aborted"]) {
      expect(runFechado(run({ status }))).toBe(true);
    }
    expect(runFechado(null)).toBe(false);
  });
});

describe("larguraDosPassos", () => {
  it("proporcional ao passo mais longo", () => {
    const steps = [
      { startedAt: iso(0), endedAt: iso(1000) },
      { startedAt: iso(0), endedAt: iso(500) },
    ];
    expect(larguraDosPassos(steps, T0)).toEqual([100, 50]);
  });

  it("passo que não rodou fica sem barra", () => {
    const steps = [{ status: "pending" }, { startedAt: iso(0), endedAt: iso(100) }];
    expect(larguraDosPassos(steps, T0)).toEqual([0, 100]);
  });

  it("lista vazia não estoura", () => {
    expect(larguraDosPassos([], T0)).toEqual([]);
    expect(larguraDosPassos(undefined, T0)).toEqual([]);
  });
});

describe("rotuloDoPasso", () => {
  it("todo status tem rótulo em português", () => {
    expect(rotuloDoPasso({ status: "done" })).toBe("concluído");
    expect(rotuloDoPasso({ status: "running" })).toBe("rodando");
    expect(rotuloDoPasso({ status: "error" })).toBe("falhou");
    expect(rotuloDoPasso({ status: "skipped" })).toBe("não rodou");
    expect(rotuloDoPasso({ status: "pending" })).toBe("na fila");
    expect(rotuloDoPasso(undefined)).toBe("na fila");
  });
});

describe("passo que nasce no meio do run (supervisor)", () => {
  function supervisor() {
    return {
      id: "r-1",
      status: "running",
      createdAt: iso(0),
      steps: [{ index: 0, agentId: "chefe", status: "running", supervisor: true }],
    };
  }

  it("step_add anexa o passo que o daemon acabou de criar", () => {
    const r = supervisor();
    const novo = { index: 1, agentId: "a2", status: "pending" };
    expect(aplicarEventoDeRun(r, { type: "step_add", runId: "r-1", step: novo })).toBe(true);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1]).toEqual(novo);
  });

  it("step_add repetido não duplica nem sobrescreve o que já andou", () => {
    const r = supervisor();
    aplicarEventoDeRun(r, { type: "step_add", runId: "r-1", step: { index: 1, agentId: "a2", status: "pending" } });
    aplicarEventoDeRun(r, { type: "step_start", runId: "r-1", index: 1, threadId: "t-2" });
    expect(aplicarEventoDeRun(r, { type: "step_add", runId: "r-1", step: { index: 1, agentId: "a2", status: "pending" } })).toBe(
      false,
    );
    expect(r.steps[1].status).toBe("running");
  });

  it("step_add de outro run é ignorado", () => {
    const r = supervisor();
    expect(aplicarEventoDeRun(r, { type: "step_add", runId: "r-9", step: { index: 1, agentId: "x", status: "pending" } })).toBe(
      false,
    );
    expect(r.steps).toHaveLength(1);
  });

  it("o supervisor conta no resumo como qualquer passo", () => {
    const r = supervisor();
    aplicarEventoDeRun(r, { type: "step_add", runId: "r-1", step: { index: 1, agentId: "a2", status: "done", tokens: 10 } });
    expect(resumoDoRun(r, T0 + 1000)).toMatchObject({ total: 2, concluidos: 1, tokens: 10 });
  });
});
