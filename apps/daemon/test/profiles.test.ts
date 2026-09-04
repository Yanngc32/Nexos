import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  addProfile,
  credentialVerdict,
  engineEnv,
  getProfile,
  importGlobalCredentials,
  listProfiles,
  markAuthFailed,
  markReady,
  removeProfile,
  updateProfile,
} from "../src/profiles.ts";
import { loadConfig } from "../src/config.ts";
import { deadCred, liveCred, tempHome } from "./helpers.ts";

describe("profiles", () => {
  it("cria pasta isolada e começa unauthenticated", () => {
    const home = tempHome();
    const p = addProfile({ id: "claude-1", engine: "claude" }, home, { skipBinCheck: true });
    expect(p.status).toBe("unauthenticated");
    expect(getProfile("claude-1", home)?.id).toBe("claude-1");
    expect(loadConfig(home).fallbackOrder).toContain("claude-1");
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

  it("updateProfile grava modo de permissão, e recusa lixo", () => {
    const home = tempHome();
    addProfile({ id: "pm1", engine: "claude" }, home, { skipBinCheck: true });
    const p = updateProfile("pm1", home, { permissionMode: "plan" });
    expect(p).toMatchObject({ permissionMode: "plan" });
    expect(getProfile("pm1", home)).toMatchObject({ permissionMode: "plan" });
    expect(() => updateProfile("pm1", home, { permissionMode: "yolo" })).toThrow(/inválido/);
    expect(getProfile("pm1", home)).toMatchObject({ permissionMode: "plan" });
    expect(updateProfile("pm1", home, { permissionMode: "" }).permissionMode).toBeUndefined();
  });

  it("updateProfile grava modelo e esforço, e recusa lixo", () => {
    const home = tempHome();
    addProfile({ id: "m1", engine: "claude" }, home, { skipBinCheck: true });
    const p = updateProfile("m1", home, { model: "opus", effort: "xhigh" });
    expect(p).toMatchObject({ model: "opus", effort: "xhigh" });
    expect(getProfile("m1", home)).toMatchObject({ model: "opus", effort: "xhigh" });
    // argv vai pro cmd.exe no Windows: metacaractere não passa
    expect(() => updateProfile("m1", home, { model: "opus & calc" })).toThrow(/inválido/);
    expect(() => updateProfile("m1", home, { model: "opus; rm -rf /" })).toThrow(/inválido/);
    expect(() => updateProfile("m1", home, { effort: "turbo" })).toThrow(/inválido/);
    expect(getProfile("m1", home)).toMatchObject({ model: "opus", effort: "xhigh" });
    const cleared = updateProfile("m1", home, { model: "", effort: "" });
    expect(cleared.model).toBeUndefined();
    expect(cleared.effort).toBeUndefined();
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

  it("removeProfile apaga a pasta", () => {
    const home = tempHome();
    addProfile({ id: "gone", engine: "stub" }, home);
    removeProfile("gone", home);
    expect(getProfile("gone", home)).toBeUndefined();
    expect(listProfiles(home)).toHaveLength(0);
    expect(loadConfig(home).fallbackOrder).not.toContain("gone");
  });

  it("listProfiles reconhece credencial isolada aninhada", () => {
    const home = tempHome();
    addProfile({ id: "nest", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("nest", home)!, home).CLAUDE_CONFIG_DIR;
    mkdirSync(join(dir!, "deep"), { recursive: true });
    writeFileSync(join(dir!, "deep", ".credentials.json"), "{}", "utf8");
    expect(listProfiles(home)[0]?.status).toBe("ready");
  });

  it("token vazio (refresh falhou) volta pra unauthenticated", () => {
    const home = tempHome();
    addProfile({ id: "dead", engine: "claude" }, home, { skipBinCheck: true });
    markReady("dead", home);
    const dir = engineEnv(getProfile("dead", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(join(dir, ".credentials.json"), deadCred(), "utf8");
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "x@y.z" } }), "utf8");
    expect(listProfiles(home)[0]?.status).toBe("unauthenticated");
    expect(credentialVerdict(getProfile("dead", home)!, home)).toBe("dead");
  });

  it("recusa do servidor gruda até credencial nova", async () => {
    const home = tempHome();
    addProfile({ id: "revoked", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("revoked", home)!, home).CLAUDE_CONFIG_DIR!;
    const cred = join(dir, ".credentials.json");
    writeFileSync(cred, liveCred(), "utf8");
    expect(listProfiles(home)[0]?.status).toBe("ready");
    markAuthFailed("revoked", home);
    // arquivo continua "vivo", mas o servidor já recusou
    expect(listProfiles(home)[0]?.status).toBe("unauthenticated");
    expect(getProfile("revoked", home)?.authFailedAt).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(cred, liveCred(), "utf8");
    expect(listProfiles(home)[0]?.status).toBe("ready");
    expect(getProfile("revoked", home)?.authFailedAt).toBeUndefined();
  });

  it("token vivo fica ready", () => {
    const home = tempHome();
    addProfile({ id: "live", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("live", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(join(dir, ".credentials.json"), liveCred(), "utf8");
    expect(listProfiles(home)[0]?.status).toBe("ready");
  });

  it("access vencido com refresh válido ainda conta como ready", () => {
    const home = tempHome();
    addProfile({ id: "refresh", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("refresh", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() - 1000,
        refreshTokenExpiresAt: Date.now() + 3_600_000,
      }),
      "utf8",
    );
    expect(listProfiles(home)[0]?.status).toBe("ready");
  });

  it("refresh token vencido não conta", () => {
    const home = tempHome();
    addProfile({ id: "old", engine: "claude" }, home, { skipBinCheck: true });
    const dir = engineEnv(getProfile("old", home)!, home).CLAUDE_CONFIG_DIR!;
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() - 2000,
        refreshTokenExpiresAt: Date.now() - 1000,
      }),
      "utf8",
    );
    expect(listProfiles(home)[0]?.status).toBe("unauthenticated");
  });

  it("importGlobalCredentials recusa credencial vencida", () => {
    const home = tempHome();
    const global = join(home, "claude-global");
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, ".credentials.json"), deadCred(), "utf8");
    const prev = process.env.NEXO_CLAUDE_GLOBAL;
    const prevJson = process.env.NEXO_CLAUDE_GLOBAL_JSON;
    process.env.NEXO_CLAUDE_GLOBAL = global;
    process.env.NEXO_CLAUDE_GLOBAL_JSON = join(home, "missing.json");
    try {
      addProfile({ id: "gdead", engine: "claude" }, home, { skipBinCheck: true });
      expect(() => importGlobalCredentials("gdead", home)).toThrow(/vencida|vazia/);
      expect(getProfile("gdead", home)?.status).toBe("unauthenticated");
    } finally {
      process.env.NEXO_CLAUDE_GLOBAL = prev;
      process.env.NEXO_CLAUDE_GLOBAL_JSON = prevJson;
    }
  });

  it("importGlobalCredentials copia credencial fake", () => {
    const home = tempHome();
    const global = join(home, "claude-global");
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, ".credentials.json"), "{}", "utf8");
    const prev = process.env.NEXO_CLAUDE_GLOBAL;
    const prevJson = process.env.NEXO_CLAUDE_GLOBAL_JSON;
    process.env.NEXO_CLAUDE_GLOBAL = global;
    process.env.NEXO_CLAUDE_GLOBAL_JSON = join(home, "missing.json");
    try {
      addProfile({ id: "g1", engine: "claude" }, home, { skipBinCheck: true });
      const p = importGlobalCredentials("g1", home);
      expect(p.status).toBe("ready");
    } finally {
      if (prev === undefined) delete process.env.NEXO_CLAUDE_GLOBAL;
      else process.env.NEXO_CLAUDE_GLOBAL = prev;
      if (prevJson === undefined) delete process.env.NEXO_CLAUDE_GLOBAL_JSON;
      else process.env.NEXO_CLAUDE_GLOBAL_JSON = prevJson;
    }
  });

  it("importGlobalCredentials copia credencial aninhada", () => {
    const home = tempHome();
    const global = join(home, "claude-global");
    mkdirSync(join(global, "deep"), { recursive: true });
    writeFileSync(join(global, "deep", ".credentials.json"), "{}", "utf8");
    const prev = process.env.NEXO_CLAUDE_GLOBAL;
    const prevJson = process.env.NEXO_CLAUDE_GLOBAL_JSON;
    process.env.NEXO_CLAUDE_GLOBAL = global;
    process.env.NEXO_CLAUDE_GLOBAL_JSON = join(home, "missing.json");
    try {
      addProfile({ id: "g2", engine: "claude" }, home, { skipBinCheck: true });
      const p = importGlobalCredentials("g2", home);
      expect(p.status).toBe("ready");
    } finally {
      if (prev === undefined) delete process.env.NEXO_CLAUDE_GLOBAL;
      else process.env.NEXO_CLAUDE_GLOBAL = prev;
      if (prevJson === undefined) delete process.env.NEXO_CLAUDE_GLOBAL_JSON;
      else process.env.NEXO_CLAUDE_GLOBAL_JSON = prevJson;
    }
  });
});

describe("allowedTools", () => {
  it("guarda padrão válido, tira repetido e limpa com lista vazia", () => {
    const home = tempHome();
    addProfile({ id: "a1", engine: "claude" }, home, { skipBinCheck: true });
    const p = updateProfile("a1", home, { allowedTools: ["Bash(git *)", "Bash(gh *)", "Bash(git *)"] });
    expect(p.allowedTools).toEqual(["Bash(git *)", "Bash(gh *)"]);
    expect(updateProfile("a1", home, { allowedTools: [] }).allowedTools).toBeUndefined();
  });

  it("recusa padrão com metacaractere de shell", () => {
    const home = tempHome();
    addProfile({ id: "a2", engine: "claude" }, home, { skipBinCheck: true });
    for (const ruim of ["Bash(rm -rf /) && curl evil", "Bash(git *); whoami", "Bash(`id`)", "Bash($(id))"]) {
      expect(() => updateProfile("a2", home, { allowedTools: [ruim] })).toThrow(/ferramenta inválida/);
    }
    expect(getProfile("a2", home)?.allowedTools).toBeUndefined();
  });
});
