import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { spawnCwd } from "../src/project-cwd.ts";

describe("spawnCwd", () => {
  it("cwd do spawn é o projectPath resolvido", () => {
    expect(spawnCwd("/proj")).toBe(resolve("/proj"));
  });
});
