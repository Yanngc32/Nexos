import { describe, it, expect } from "vitest";
import { isNodeScript } from "../src/spawn-bin.ts";
import { resolveTsxCli, daemonRoot } from "../scripts/resolve-tsx.mjs";
import { existsSync } from "node:fs";

describe("isNodeScript", () => {
  it("reconhece .mjs no Windows", () => {
    expect(isNodeScript("C:\\foo\\bar\\fake-claude.mjs")).toBe(true);
    expect(isNodeScript("C:\\foo\\bar\\fake-claude.MJS")).toBe(true);
    expect(isNodeScript("claude")).toBe(false);
    expect(isNodeScript("claude.cmd")).toBe(false);
  });
});

describe("resolveTsxCli", () => {
  it("acha tsx em apps/daemon/node_modules/tsx", () => {
    const cli = resolveTsxCli(daemonRoot());
    expect(cli.replaceAll("\\", "/")).toMatch(/node_modules\/tsx\/dist\/cli\.mjs$/);
    expect(existsSync(cli)).toBe(true);
  });
});
