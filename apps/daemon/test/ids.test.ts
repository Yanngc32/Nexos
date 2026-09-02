import { describe, it, expect } from "vitest";
import { assertSlug, newThreadId } from "../src/ids.ts";

describe("assertSlug", () => {
  it("aceita slug simples", () => {
    expect(assertSlug("claude-trabalho")).toBe("claude-trabalho");
  });
  it("rejeita maiúscula e espaço", () => {
    expect(() => assertSlug("Claude")).toThrow(/slug/);
    expect(() => assertSlug("a b")).toThrow(/slug/);
  });
});

describe("newThreadId", () => {
  it("gera slug válido", () => {
    expect(assertSlug(newThreadId())).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});
