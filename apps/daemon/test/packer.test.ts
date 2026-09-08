import { describe, it, expect } from "vitest";
import { pack, tetoDeToken, TOKEN_CAP_PISO } from "../src/packer.ts";
import type { ThreadEvent } from "@nexo/shared";
import { DEFAULT_CONFIG } from "@nexo/shared";

const ts = "2026-01-01T00:00:00.000Z";
const tid = "t-1";

function ev(partial: ThreadEvent): ThreadEvent {
  return partial;
}

describe("pack", () => {
  it("ordena user/assistant e converte tool", () => {
    const events: ThreadEvent[] = [
      ev({ ts, type: "thread_meta", threadId: tid, projectPath: "/p", profileId: "a" }),
      ev({ ts, type: "user", threadId: tid, text: "leia x" }),
      ev({ ts, type: "tool", threadId: tid, name: "Read", summary: "x.ts 10 linhas" }),
      ev({ ts, type: "assistant", threadId: tid, text: "ok" }),
    ];
    const { text, trimmed } = pack(events, DEFAULT_CONFIG.pack, 8000);
    expect(text).toContain("User: leia x");
    expect(text).toContain("Agente executou Read: x.ts 10 linhas");
    expect(text).toContain("Assistant: ok");
    expect(trimmed).toBeUndefined();
  });

  it("inclui switched e error como sistema", () => {
    const events: ThreadEvent[] = [
      ev({ ts, type: "switched", threadId: tid, fromProfileId: "a", toProfileId: "b", reason: "quota" }),
      ev({ ts, type: "error", threadId: tid, message: "boom", profileId: "b" }),
    ];
    const { text } = pack(events, DEFAULT_CONFIG.pack, 8000);
    expect(text).toContain("System: switched a -> b (quota)");
    expect(text).toContain("System: error boom");
  });

  it("ignora tudo antes do último /clear", () => {
    const events: ThreadEvent[] = [
      ev({ ts, type: "user", threadId: tid, text: "mensagem antiga" }),
      ev({ ts, type: "assistant", threadId: tid, text: "resposta antiga" }),
      ev({ ts, type: "cleared", threadId: tid }),
      ev({ ts, type: "user", threadId: tid, text: "mensagem nova" }),
    ];
    const { text } = pack(events, DEFAULT_CONFIG.pack, 8000);
    expect(text).not.toContain("antiga");
    expect(text).toContain("User: mensagem nova");
  });

  it("sem /clear, nada muda", () => {
    const events: ThreadEvent[] = [ev({ ts, type: "user", threadId: tid, text: "oi" })];
    expect(pack(events, DEFAULT_CONFIG.pack, 8000).text).toBe("User: oi");
  });

  it("corta prefixo e reporta trimmed", () => {
    const events: ThreadEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(ev({ ts, type: "user", threadId: tid, text: `u${i} ${"x".repeat(200)}` }));
      events.push(ev({ ts, type: "assistant", threadId: tid, text: `a${i} ${"y".repeat(200)}` }));
    }
    const { text, trimmed } = pack(events, { keepLastMessages: 4, prefixCharBudget: 80, compactar: true }, 100);
    expect(trimmed).toEqual({ keptMessages: 4, droppedMessages: 46 });
    expect(text).toContain("Contexto anterior (cortado):");
    expect(text).toContain("u24");
  });
});

describe("tetoDeToken", () => {
  it("janela desconhecida cai no piso: é o comportamento que já existia", () => {
    expect(tetoDeToken(0)).toBe(TOKEN_CAP_PISO);
    expect(tetoDeToken(-1)).toBe(TOKEN_CAP_PISO);
    expect(tetoDeToken(Number.NaN)).toBe(TOKEN_CAP_PISO);
  });

  it("metade da janela: a outra metade paga prompt, ferramenta e resposta", () => {
    expect(tetoDeToken(200_000)).toBe(100_000);
    expect(tetoDeToken(64_000)).toBe(32_000);
  });

  it("janela pequena não desce abaixo do piso", () => {
    // 8k de janela daria 4k, menos do que já se mandava antes
    expect(tetoDeToken(8000)).toBe(TOKEN_CAP_PISO);
  });

  it("janela de 1M é limitada: o pack vai inteiro em TODO turno", () => {
    // sem teto seriam 500 mil tokens por mensagem
    expect(tetoDeToken(1_000_000)).toBe(128_000);
  });

  it("nunca fica acima da metade nem abaixo do piso, pra qualquer janela", () => {
    for (const janela of [1, 1000, 16_000, 128_000, 200_000, 500_000, 1_000_000, 2_000_000]) {
      const teto = tetoDeToken(janela);
      expect(teto).toBeGreaterThanOrEqual(TOKEN_CAP_PISO);
      expect(teto).toBeLessThanOrEqual(128_000);
      if (teto > TOKEN_CAP_PISO && teto < 128_000) expect(teto).toBe(Math.floor(janela / 2));
    }
  });
});
