import { describe, it, expect } from "vitest";
import { suggestFallback, assertSwitch } from "../src/router.ts";
import { addProfile, markReady } from "../src/profiles.ts";
import { saveConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

describe("router", () => {
  it("rejeita switch sem confirmed", () => {
    expect(() => assertSwitch({ confirmed: false })).toThrow(/confirmed/);
    expect(() => assertSwitch({ confirmed: true })).not.toThrow();
  });

  it("sugere próximo ready diferente do atual", () => {
    const home = tempHome();
    addProfile({ id: "a", engine: "stub" }, home);
    addProfile({ id: "b", engine: "stub" }, home);
    markReady("a", home);
    markReady("b", home);
    saveConfig(home, { fallbackOrder: ["a", "b"] });
    expect(suggestFallback("a", home)).toBe("b");
    expect(suggestFallback("b", home)).toBeUndefined();
  });

  it("sem fallbackOrder usa outro perfil ready", () => {
    const home = tempHome();
    addProfile({ id: "a", engine: "stub" }, home);
    addProfile({ id: "b", engine: "stub" }, home);
    saveConfig(home, { fallbackOrder: [] });
    expect(suggestFallback("a", home)).toBe("b");
  });

  it("pula unauthenticated", () => {
    const home = tempHome();
    addProfile({ id: "a", engine: "stub" }, home);
    addProfile({ id: "b", engine: "claude" }, home, { skipBinCheck: true });
    markReady("a", home);
    saveConfig(home, { fallbackOrder: ["a", "b"] });
    expect(suggestFallback("a", home)).toBeUndefined();
  });
});
