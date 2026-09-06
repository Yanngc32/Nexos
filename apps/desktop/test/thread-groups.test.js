import { describe, expect, it } from "vitest";
import { agruparConversas } from "../thread-groups.js";

/** A lista chega do daemon já ordenada da mais recente pra mais antiga. */
function conversa(id, over = {}) {
  return { id, preview: id, updatedAt: "2026-01-01T12:00:00.000Z", ...over };
}

function passo(id, runId, runStep, over = {}) {
  return conversa(id, { runId, runStep, runTitle: "Chefia · auditar", ...over });
}

describe("agruparConversas", () => {
  it("conversa sem run continua solta", () => {
    const out = agruparConversas([conversa("a"), conversa("b")]);
    expect(out.map((e) => e.tipo)).toEqual(["conversa", "conversa"]);
    expect(out.map((e) => e.thread.id)).toEqual(["a", "b"]);
  });

  it("passos do mesmo run viram uma pasta só", () => {
    const out = agruparConversas([passo("p2", "r1", 1), passo("p1", "r1", 0), conversa("solta")]);
    expect(out.map((e) => e.tipo)).toEqual(["run", "conversa"]);
    expect(out[0].runId).toBe("r1");
    expect(out[0].titulo).toBe("Chefia · auditar");
    expect(out[0].threads).toHaveLength(2);
  });

  it("dentro da pasta a ordem é a do RUN, não a de atualização", () => {
    // chegam ao contrário: o passo 2 é mais recente e vem primeiro na lista
    const out = agruparConversas([passo("p2", "r1", 1), passo("p1", "r1", 0)]);
    expect(out[0].threads.map((t) => t.id)).toEqual(["p1", "p2"]);
  });

  it("a pasta ocupa a posição da conversa mais recente dela", () => {
    const out = agruparConversas([conversa("nova"), passo("p2", "r1", 1), conversa("velha"), passo("p1", "r1", 0)]);
    expect(out.map((e) => (e.tipo === "run" ? "run" : e.thread.id))).toEqual(["nova", "run", "velha"]);
  });

  it("dois runs viram duas pastas", () => {
    const out = agruparConversas([
      passo("a1", "r1", 0),
      passo("a2", "r1", 1),
      passo("b1", "r2", 0),
      passo("b2", "r2", 1),
    ]);
    expect(out.map((e) => e.runId)).toEqual(["r1", "r2"]);
  });

  it("run de um passo só não vira pasta: a pasta a mais só esconderia", () => {
    const out = agruparConversas([passo("unico", "r1", 0), conversa("x")]);
    expect(out.map((e) => e.tipo)).toEqual(["conversa", "conversa"]);
  });

  it("run sem rótulo carimbado ainda agrupa, com nome genérico", () => {
    const out = agruparConversas([
      passo("a", "r1", 0, { runTitle: undefined }),
      passo("b", "r1", 1, { runTitle: undefined }),
    ]);
    expect(out[0].titulo).toBe("Execução de time");
  });

  it("lista vazia ou inválida não quebra", () => {
    expect(agruparConversas([])).toEqual([]);
    expect(agruparConversas(null)).toEqual([]);
    expect(agruparConversas(undefined)).toEqual([]);
  });
});
