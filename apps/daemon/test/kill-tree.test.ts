import { spawn } from "node:child_process";
import { describe, it, expect } from "vitest";
import { killTree } from "../src/kill-tree.ts";

describe("killTree", () => {
  it("encerra processo filho", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const pid = child.pid;
    expect(pid).toBeTruthy();
    killTree(pid!);
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", (c) => resolve(c));
      setTimeout(() => resolve(-1), 4000);
    });
    expect(code).not.toBe(-1);
  });
});
