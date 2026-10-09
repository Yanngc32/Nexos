import { describe, it, expect } from "vitest";
import { comandoDeInstalacao, ENGINE_NPM_PACKAGE, installEngine } from "../src/install-engine.ts";

describe("installEngine", () => {
  it("mapeia claude e codex pro pacote npm real", () => {
    expect(ENGINE_NPM_PACKAGE.claude).toBe("@anthropic-ai/claude-code");
    expect(ENGINE_NPM_PACKAGE.codex).toBe("@openai/codex");
  });

  it("motor sem pacote conhecido não tenta instalar nada, só diz o motivo", async () => {
    const res = await installEngine("stub");
    expect(res).toEqual({ ok: false, log: "sem instalação automática pro motor stub" });
  });

  it("claude já instalado atualiza pelo próprio `claude update` (cobre a instalação nativa, que o npm não toca)", () => {
    expect(comandoDeInstalacao("claude", true)).toEqual({ bin: "claude", args: ["update"] });
  });

  it("claude ausente e codex instalam/atualizam pelo npm", () => {
    expect(comandoDeInstalacao("claude", false)).toEqual({ bin: "npm", args: ["install", "-g", "@anthropic-ai/claude-code@latest"] });
    expect(comandoDeInstalacao("codex", true)).toEqual({ bin: "npm", args: ["install", "-g", "@openai/codex@latest"] });
    expect(comandoDeInstalacao("stub", true)).toBeNull();
  });
});
