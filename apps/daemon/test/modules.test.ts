import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempHome } from "./helpers.ts";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { ensureCavemanInstalled, ensureRtkInstalled, syncRtkHook } = await import("../src/modules.ts");

describe("ensureRtkInstalled", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("já instalado: não tenta cargo nem o script", async () => {
    execFileMock.mockImplementation((bin, _args, _opts, cb) => {
      if (bin === "rtk") return cb(null, { stdout: "rtk 0.28\n" });
      return cb(new Error("não devia chamar"), undefined);
    });
    await ensureRtkInstalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("ausente: tenta cargo, e se der certo não tenta o script", async () => {
    execFileMock.mockImplementation((bin, _args, _opts, cb) => {
      if (bin === "rtk") return cb(new Error("não achado"), undefined);
      if (bin === "cargo") return cb(null, { stdout: "" });
      return cb(new Error("não devia chamar"), undefined);
    });
    await ensureRtkInstalled();
    expect(execFileMock.mock.calls.map((c) => c[0])).toEqual(["rtk", "cargo"]);
  });

  it("sem cargo e sem script disponível: nunca lança, só loga instrução manual", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(new Error("não achado"), undefined));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(ensureRtkInstalled()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/não consegui instalar/));
    } finally {
      log.mockRestore();
    }
  });
});

describe("syncRtkHook", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("settings.json sem 'rtk': roda 'rtk init -g' com CLAUDE_CONFIG_DIR apontado pra cá", async () => {
    const dir = tempHome();
    execFileMock.mockImplementation((_bin, _args, opts, cb) => {
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe(dir);
      return cb(null, { stdout: "" });
    });
    await syncRtkHook(dir);
    expect(execFileMock.mock.calls[0]?.[0]).toBe("rtk");
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(["init", "-g"]);
  });

  it("settings.json já tem 'rtk': não roda subprocesso nenhum", async () => {
    const dir = tempHome();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ command: "rtk" }] } }), "utf8");
    await syncRtkHook(dir);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("ensureCavemanInstalled", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("baixa e grava a skill quando ainda não existe", async () => {
    const home = tempHome();
    fetchMock.mockResolvedValue({ ok: true, text: async () => "---\nname: caveman\n---\nconteúdo" });
    await ensureCavemanInstalled(home);
    const dest = join(home, "skills", "caveman", "SKILL.md");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain("name: caveman");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("já instalada: não baixa de novo", async () => {
    const home = tempHome();
    mkdirSync(join(home, "skills", "caveman"), { recursive: true });
    writeFileSync(join(home, "skills", "caveman", "SKILL.md"), "já tinha", "utf8");
    await ensureCavemanInstalled(home);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha de rede: nunca lança", async () => {
    const home = tempHome();
    fetchMock.mockRejectedValue(new Error("sem rede"));
    await expect(ensureCavemanInstalled(home)).resolves.toBeUndefined();
  });

  it("HTTP não-ok: nunca lança", async () => {
    const home = tempHome();
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "" });
    await expect(ensureCavemanInstalled(home)).resolves.toBeUndefined();
  });
});
