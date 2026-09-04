import { describe, it, expect } from "vitest";
import type { LimitsInfo, SessionInfo } from "@nexo/shared";
import { addProfile } from "../src/profiles.ts";
import { appendEvent, createThread, type ThreadUsage } from "../src/threads.ts";
import { contextLines, costLines, fmtReset, fmtTokens, limitsLines, threadReport } from "../src/usage-report.ts";
import { tempHome } from "./helpers.ts";

function totals(over: Partial<ThreadUsage> = {}): ThreadUsage {
  return {
    turns: 2,
    input: 1200,
    output: 340,
    cacheRead: 1_500_000,
    cacheCreate: 45_000,
    thinking: 0,
    costUsd: 0.4213,
    contextTokens: 36_000,
    ...over,
  };
}

describe("fmtTokens", () => {
  it("encurta mil e milhão, mantém unidade crua", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1200)).toBe("1.2k");
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(1_500_000)).toBe("1.5M");
  });
});

describe("fmtReset", () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  it("conta pra frente dentro de 24 h", () => {
    expect(fmtReset((now + 2 * 3600_000 + 780_000) / 1000, now)).toBe("reinicia em 2 h 13 min");
    expect(fmtReset((now + 600_000) / 1000, now)).toBe("reinicia em 10 min");
  });
  it("vazio sem dado, agora quando já passou", () => {
    expect(fmtReset(0, now)).toBe("");
    expect(fmtReset((now - 1000) / 1000, now)).toBe("reinicia agora");
  });
});

describe("costLines", () => {
  it("soma total sem contar raciocínio e formata custo", () => {
    const out = costLines(totals());
    expect(out.some((l) => l.startsWith("turnos"))).toBe(true);
    expect(out.find((l) => l.startsWith("total"))).toContain("1.5M");
    expect(out.find((l) => l.startsWith("custo"))).toContain("US$ 0.4213");
    expect(out.some((l) => l.startsWith("raciocínio"))).toBe(false);
  });

  it("mostra raciocínio quando existe e avisa quando não há custo", () => {
    const out = costLines(totals({ thinking: 8000, costUsd: 0 }));
    expect(out.find((l) => l.startsWith("raciocínio"))).toContain("8.0k");
    expect(out.find((l) => l.startsWith("custo"))).toContain("motor não reporta");
  });

  it("conversa sem turno não inventa número", () => {
    expect(costLines(totals({ turns: 0 }))).toEqual(["sem turno nesta conversa ainda"]);
  });
});

describe("contextLines", () => {
  it("percentual sobre a janela do modelo", () => {
    const session: SessionInfo = { contextWindow: 1_000_000, model: "claude-opus-5[1m]" };
    const out = contextLines(totals({ contextTokens: 250_000 }), session);
    expect(out.find((l) => l.startsWith("modelo"))).toContain("claude-opus-5[1m]");
    expect(out.find((l) => l.startsWith("janela"))).toContain("1M");
    expect(out.find((l) => l.startsWith("em uso"))).toContain("250.0k (25%)");
  });

  it("sem turno mostra a janela e nada de uso", () => {
    const out = contextLines(totals({ contextTokens: 0 }), { contextWindow: 200_000 });
    expect(out.find((l) => l.startsWith("em uso"))).toContain("sem turno ainda");
    expect(out.find((l) => l.startsWith("modelo"))).toContain("(padrão do CLI)");
  });
});

describe("limitsLines", () => {
  it("uma linha por janela", () => {
    const limits: LimitsInfo = {
      fiveHour: { utilization: 0.42, resetsAt: Math.floor((Date.now() + 3600_000) / 1000) },
      sevenDay: { utilization: 0.11, resetsAt: 0 },
    };
    const out = limitsLines(limits);
    expect(out[0]).toContain("42%");
    expect(out[0]).toContain("reinicia em");
    expect(out[1]).toContain("11%");
  });

  it("sem dado explica por quê", () => {
    expect(limitsLines(null)[0]).toContain("sem dado ainda");
    expect(limitsLines({})[0]).toContain("sem dado ainda");
  });
});

describe("threadReport", () => {
  it("junta total do JSONL com perfil ativo e janela do modelo", () => {
    const home = tempHome();
    addProfile({ id: "p1", engine: "stub" }, home, { skipBinCheck: true });
    const t = createThread({ projectPath: "/tmp/proj", profileId: "p1" }, home);
    appendEvent(
      {
        ts: new Date().toISOString(),
        type: "usage",
        threadId: t.id,
        model: "claude-opus-5[1m]",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheCreate: 5,
        contextTokens: 115,
      },
      home,
    );
    const r = threadReport(t.id, home);
    expect(r.profileId).toBe("p1");
    expect(r.totals.turns).toBe(1);
    expect(r.totals.contextTokens).toBe(115);
    expect(r.session.contextWindow).toBe(1_000_000);
    expect(r.limits).toBeNull();
  });

  it("thread inexistente estoura", () => {
    expect(() => threadReport("nao-existe", tempHome())).toThrow(/não existe/);
  });
});
