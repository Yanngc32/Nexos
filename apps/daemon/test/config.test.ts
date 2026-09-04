import { describe, it, expect } from "vitest";
import { loadConfig, saveConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

describe("config accent", () => {
  it("grava hex válido e ignora lixo", () => {
    const home = tempHome();
    expect(loadConfig(home).accent).toBe("#4d9cd6");
    saveConfig(home, { accent: "#e06c75" });
    expect(loadConfig(home).accent).toBe("#e06c75");
    saveConfig(home, { accent: "red" });
    expect(loadConfig(home).accent).toBe("#e06c75");
  });
});

describe("config switchMode", () => {
  it("padrão manual, grava válido e ignora lixo", () => {
    const home = tempHome();
    expect(loadConfig(home).switchMode).toBe("manual");
    saveConfig(home, { switchMode: "auto" });
    expect(loadConfig(home).switchMode).toBe("auto");
    saveConfig(home, { switchMode: "sim" as never });
    expect(loadConfig(home).switchMode).toBe("auto");
    saveConfig(home, { switchMode: "denied" });
    expect(loadConfig(home).switchMode).toBe("denied");
  });
});

describe("config repos", () => {
  it("guarda pastas, tira repetido e vazio", () => {
    const home = tempHome();
    const salvo = saveConfig(home, {
      repos: ["C:/proj/a", "C:/proj/a/", "  ", "C:/proj/b", "C:/PROJ/A"],
      lastProject: "C:/proj/b",
      lastThread: "t-1",
    });
    expect(salvo.repos).toEqual(["C:/proj/a", "C:/proj/b"]);
    expect(loadConfig(home).repos).toEqual(["C:/proj/a", "C:/proj/b"]);
    expect(loadConfig(home).lastProject).toBe("C:/proj/b");
    expect(loadConfig(home).lastThread).toBe("t-1");
  });

  it("patch sem repos nao apaga a lista", () => {
    const home = tempHome();
    saveConfig(home, { repos: ["C:/proj/a"] });
    saveConfig(home, { accent: "#123456" });
    expect(loadConfig(home).repos).toEqual(["C:/proj/a"]);
  });

  it("config antigo sem repos carrega com lista vazia", () => {
    const home = tempHome();
    saveConfig(home, { accent: "#abcdef" });
    const cfg = loadConfig(home);
    expect(cfg.repos).toEqual([]);
    expect(cfg.lastProject).toBe("");
  });
});
