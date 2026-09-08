import { describe, it, expect, vi, afterEach } from "vitest";
import { AGENT_TAIL_CHARS, aplicarNoRetrato } from "../agent-events.js";

afterEach(() => {
  vi.useRealTimers();
});

function retrato(over = {}) {
  return { threadId: "t1", profileId: "p1", busy: false, tail: "", startedAt: 0, ...over };
}

describe("texto e pensamento ligam o ocupado", () => {
  it("text acumula no rabo e marca ocupado", () => {
    const a = retrato();
    expect(aplicarNoRetrato(a, { type: "text", text: "oi" })).toBe(true);
    aplicarNoRetrato(a, { type: "text", text: " mundo" });
    expect(a.tail).toBe("oi mundo");
    expect(a.busy).toBe(true);
  });

  it("o rabo é cortado pelo fim, não pelo começo", () => {
    const a = retrato();
    aplicarNoRetrato(a, { type: "text", text: "x".repeat(AGENT_TAIL_CHARS) + "FIM" });
    expect(a.tail).toHaveLength(AGENT_TAIL_CHARS);
    expect(a.tail.endsWith("FIM")).toBe(true);
  });

  it("o cronômetro começa no primeiro evento e não é reiniciado depois", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const a = retrato();
    aplicarNoRetrato(a, { type: "text", text: "a" });
    const inicio = a.startedAt;
    expect(inicio).toBeGreaterThan(0);
    vi.setSystemTime(new Date("2026-01-01T12:05:00Z"));
    aplicarNoRetrato(a, { type: "text", text: "b" });
    aplicarNoRetrato(a, { type: "thinking" });
    expect(a.startedAt).toBe(inicio);
  });

  it("thinking marca ocupado sem mexer no rabo", () => {
    const a = retrato({ tail: "antes" });
    aplicarNoRetrato(a, { type: "thinking", tokens: 12 });
    expect(a.busy).toBe(true);
    expect(a.tail).toBe("antes");
  });
});

describe("metadados", () => {
  it("session grava o modelo, mas só quando vem", () => {
    const a = retrato({ model: "opus" });
    aplicarNoRetrato(a, { type: "session", model: "sonnet" });
    expect(a.model).toBe("sonnet");
    aplicarNoRetrato(a, { type: "session" });
    expect(a.model).toBe("sonnet");
  });

  it("context e usage gravam o tamanho do contexto", () => {
    const a = retrato();
    aplicarNoRetrato(a, { type: "context", contextTokens: 1000 });
    expect(a.contextTokens).toBe(1000);
    aplicarNoRetrato(a, { type: "usage", contextTokens: 2000 });
    expect(a.contextTokens).toBe(2000);
  });

  it("contexto zero não apaga o que já se sabia", () => {
    const a = retrato({ contextTokens: 500 });
    aplicarNoRetrato(a, { type: "usage", contextTokens: 0 });
    expect(a.contextTokens).toBe(500);
  });
});

describe("fins de turno", () => {
  it("done desliga o ocupado e limpa a quota", () => {
    const a = retrato({ busy: true, pendingQuota: true });
    aplicarNoRetrato(a, { type: "done" });
    expect(a).toMatchObject({ busy: false, pendingQuota: false, lastTerminal: "done" });
  });

  it("quota para o turno e fica marcada", () => {
    const a = retrato({ busy: true });
    aplicarNoRetrato(a, { type: "quota" });
    expect(a).toMatchObject({ busy: false, pendingQuota: true, lastTerminal: "quota" });
  });

  it("auth e error param o turno com o motivo certo", () => {
    const a = retrato({ busy: true });
    aplicarNoRetrato(a, { type: "auth" });
    expect(a).toMatchObject({ busy: false, lastTerminal: "auth" });
    aplicarNoRetrato(a, { type: "error", message: "morreu" });
    expect(a.lastTerminal).toBe("error");
  });

  it("erro não limpa a quota: quem estourou continua estourado", () => {
    const a = retrato({ pendingQuota: true });
    aplicarNoRetrato(a, { type: "error" });
    expect(a.pendingQuota).toBe(true);
  });
});

describe("troca de conta", () => {
  it("switched aponta pra conta nova e tira a marca de quota", () => {
    const a = retrato({ pendingQuota: true });
    aplicarNoRetrato(a, { type: "switched", fromProfileId: "p1", toProfileId: "p2" });
    expect(a.profileId).toBe("p2");
    // a conta nova não herda o limite estourado da antiga
    expect(a.pendingQuota).toBe(false);
  });

  it("trocar no meio do turno não desliga o ocupado", () => {
    const a = retrato({ busy: true });
    aplicarNoRetrato(a, { type: "switched", toProfileId: "p2" });
    expect(a.busy).toBe(true);
  });
});

describe("evento desconhecido", () => {
  it("não muda nada e diz que não vale repintar", () => {
    const a = retrato({ busy: true, tail: "x" });
    const antes = { ...a };
    expect(aplicarNoRetrato(a, { type: "coisa-nova" })).toBe(false);
    expect(a).toEqual(antes);
  });

  it("tipos conhecidos sempre pedem repintura", () => {
    for (const type of ["text", "thinking", "session", "context", "usage", "switched", "quota", "auth", "error", "done"]) {
      expect(aplicarNoRetrato(retrato(), { type, text: "", toProfileId: "p2" })).toBe(true);
    }
  });
});
