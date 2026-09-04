import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { addProfile, engineEnv, getProfile } from "../src/profiles.ts";
import { loginProfile } from "../src/login.ts";
import { tempHome } from "./helpers.ts";

function isolateClaudeGlobal(home: string): () => void {
  const prev = process.env.NEXO_CLAUDE_GLOBAL;
  const prevJson = process.env.NEXO_CLAUDE_GLOBAL_JSON;
  process.env.NEXO_CLAUDE_GLOBAL = join(home, "empty-claude-global");
  process.env.NEXO_CLAUDE_GLOBAL_JSON = join(home, "empty-claude.json");
  return () => {
    if (prev === undefined) delete process.env.NEXO_CLAUDE_GLOBAL;
    else process.env.NEXO_CLAUDE_GLOBAL = prev;
    if (prevJson === undefined) delete process.env.NEXO_CLAUDE_GLOBAL_JSON;
    else process.env.NEXO_CLAUDE_GLOBAL_JSON = prevJson;
  };
}

const dir = dirname(fileURLToPath(import.meta.url));
const fake = join(dir, "fixtures", "fake-login.mjs");
const fakeFail = join(dir, "fixtures", "fake-login-fail.mjs");
const fakeEmpty = join(dir, "fixtures", "fake-login-empty.mjs");

describe("loginProfile", () => {
  it("stub e api só markReady", async () => {
    const home = tempHome();
    addProfile({ id: "s1", engine: "stub" }, home);
    const api = addProfile(
      { id: "a1", engine: "api", api: { provider: "anthropic", model: "x" } },
      home,
      { apiKey: "sk-x" },
    );
    expect(api.status).toBe("ready");
    await loginProfile("s1", home);
    expect(getProfile("s1", home)?.status).toBe("ready");
  });

  it("claude spawna login no CLAUDE_CONFIG_DIR isolado", async () => {
    const home = tempHome();
    addProfile({ id: "c1", engine: "claude" }, home, { skipBinCheck: true });
    await loginProfile("c1", home, { bin: fake });
    const p = getProfile("c1", home);
    expect(p?.status).toBe("ready");
    const configDir = engineEnv(p!, home).CLAUDE_CONFIG_DIR;
    expect(configDir).toBeTruthy();
    expect(existsSync(join(configDir!, "logged-in"))).toBe(true);
    expect(readFileSync(join(configDir!, "logged-in"), "utf8")).toContain("auth login --claudeai");
  });

  it("codex spawna login no CODEX_HOME isolado", async () => {
    const home = tempHome();
    addProfile({ id: "x1", engine: "codex" }, home, { skipBinCheck: true });
    await loginProfile("x1", home, { bin: fake });
    const p = getProfile("x1", home);
    expect(p?.status).toBe("ready");
    const configDir = engineEnv(p!, home).CODEX_HOME;
    expect(existsSync(join(configDir!, "logged-in"))).toBe(true);
    expect(readFileSync(join(configDir!, "logged-in"), "utf8")).toContain("login");
  });

  it("exit != 0 deixa unauthenticated", async () => {
    const home = tempHome();
    addProfile({ id: "c2", engine: "claude" }, home, { skipBinCheck: true });
    await expect(loginProfile("c2", home, { bin: fakeFail })).rejects.toThrow(/login falhou/);
    expect(getProfile("c2", home)?.status).toBe("unauthenticated");
  });

  it("exit 0 sem credencial não marca ready", async () => {
    const home = tempHome();
    const restore = isolateClaudeGlobal(home);
    try {
      addProfile({ id: "c3", engine: "claude" }, home, { skipBinCheck: true });
      await expect(loginProfile("c3", home, { bin: fakeEmpty })).rejects.toThrow(/credencial/);
      expect(getProfile("c3", home)?.status).toBe("unauthenticated");
    } finally {
      restore();
    }
  });

  it("exit 0 pega credencial global do Claude", async () => {
    const home = tempHome();
    const global = join(home, "claude-global");
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, ".credentials.json"), "{}", "utf8");
    const restore = isolateClaudeGlobal(home);
    process.env.NEXO_CLAUDE_GLOBAL = global;
    try {
      addProfile({ id: "c4", engine: "claude" }, home, { skipBinCheck: true });
      await loginProfile("c4", home, { bin: fakeEmpty });
      expect(getProfile("c4", home)?.status).toBe("ready");
    } finally {
      restore();
    }
  });
});
