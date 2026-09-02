import { describe, it, expect } from "vitest";
import { addProfile, getProfile, listProfiles, markReady } from "../src/profiles.ts";
import { tempHome } from "./helpers.ts";

describe("profiles", () => {
  it("cria pasta isolada e começa unauthenticated", () => {
    const home = tempHome();
    const p = addProfile({ id: "claude-1", engine: "claude" }, home, { skipBinCheck: true });
    expect(p.status).toBe("unauthenticated");
    expect(getProfile("claude-1", home)?.id).toBe("claude-1");
  });

  it("engine api fica ready se keys.json existe", () => {
    const home = tempHome();
    const p = addProfile(
      {
        id: "api-1",
        engine: "api",
        api: { provider: "anthropic", model: "claude-sonnet-4-0" },
      },
      home,
      { apiKey: "sk-test" },
    );
    expect(p.status).toBe("ready");
    expect(listProfiles(home)).toHaveLength(1);
  });

  it("rejeita id duplicado", () => {
    const home = tempHome();
    addProfile({ id: "x", engine: "stub" }, home);
    expect(() => addProfile({ id: "x", engine: "stub" }, home)).toThrow(/existe/);
  });

  it("markReady muda status", () => {
    const home = tempHome();
    addProfile({ id: "c", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c", home);
    expect(getProfile("c", home)?.status).toBe("ready");
  });
});
