import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { addProfile, markReady } from "../src/profiles.ts";
import { claudeEngine } from "../src/engines/cli.ts";
import { spawnCwd } from "../src/sandbox.ts";
import { tempHome } from "./helpers.ts";
import type { EngineEvent } from "@nexo/shared";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");

function waitDone(events: EngineEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 5000);
    const i = setInterval(() => {
      if (events.some((e) => e.type === "done" || e.type === "quota" || e.type === "error")) {
        clearTimeout(t);
        clearInterval(i);
        resolve();
      }
    }, 20);
  });
}

describe("CliEngine", () => {
  it("passa CLAUDE_CONFIG_DIR e cwd do projeto", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    markReady("c1", home);
    process.env.NEXO_CLAUDE_BIN = fake;
    const engine = claudeEngine(home, "c1");
    const events: EngineEvent[] = [];
    const project = spawnCwd(".");
    await engine.start(
      { threadId: "t-1", projectPath: project, profileId: "c1", contextPack: "pack" },
      (ev) => events.push(ev),
    );
    expect(engine.lastEnv.CLAUDE_CONFIG_DIR).toContain("c1");
    expect(engine.lastCwd).toBe(project);
    await engine.send("oi");
    await waitDone(events);
    const texts = events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""));
    expect(texts.some((t) => t.includes("echo:oi") || t.includes("CLAUDE_CONFIG_DIR"))).toBe(true);
  });
});
