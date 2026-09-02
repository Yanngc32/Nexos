import { describe, it, expect } from "vitest";
import { pack } from "../src/packer.ts";
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

  it("corta prefixo e reporta trimmed", () => {
    const events: ThreadEvent[] = [];
    for (let i = 0; i < 25; i++) {
      events.push(ev({ ts, type: "user", threadId: tid, text: `u${i} ${"x".repeat(200)}` }));
      events.push(ev({ ts, type: "assistant", threadId: tid, text: `a${i} ${"y".repeat(200)}` }));
    }
    const { text, trimmed } = pack(events, { keepLastMessages: 4, prefixCharBudget: 80 }, 100);
    expect(trimmed).toEqual({ keptMessages: 4, droppedMessages: 46 });
    expect(text).toContain("Contexto anterior (cortado):");
    expect(text).toContain("u24");
  });
});
