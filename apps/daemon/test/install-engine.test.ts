import { describe, it, expect } from "vitest";
import { ENGINE_NPM_PACKAGE, installEngine } from "../src/install-engine.ts";

describe("installEngine", () => {
  it("mapeia claude e codex pro pacote npm real", () => {
    expect(ENGINE_NPM_PACKAGE.claude).toBe("@anthropic-ai/claude-code");
    expect(ENGINE_NPM_PACKAGE.codex).toBe("@openai/codex");
  });

  it("motor sem pacote conhecido não tenta instalar nada, só diz o motivo", async () => {
    const res = await installEngine("stub");
    expect(res).toEqual({ ok: false, log: "sem instalação automática pro motor stub" });
  });
});
