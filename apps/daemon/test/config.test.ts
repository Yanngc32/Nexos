import { writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { loadConfig, saveConfig } from "../src/config.ts";
import { configPath } from "../src/home.ts";
import { tempHome } from "./helpers.ts";

describe("config corrompido", () => {
  it("config.json truncado (0 bytes) não derruba o daemon — volta pro padrão", () => {
    const home = tempHome();
    loadConfig(home); // cria o arquivo
    writeFileSync(configPath(home), "", "utf8"); // simula crash no meio de uma escrita
    expect(() => loadConfig(home)).not.toThrow();
    expect(loadConfig(home)).toMatchObject({ port: 7432, accent: "#4d9cd6" });
  });

  it("config.json com lixo (JSON inválido) também recupera pro padrão", () => {
    const home = tempHome();
    loadConfig(home);
    writeFileSync(configPath(home), "{not json", "utf8");
    expect(() => loadConfig(home)).not.toThrow();
    expect(loadConfig(home).port).toBe(7432);
  });
});

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

describe("config projetosDir/slugOverrides", () => {
  it("projetosDir vazio por padrão, grava e recupera", () => {
    const home = tempHome();
    expect(loadConfig(home).projetosDir).toBe("");
    saveConfig(home, { projetosDir: "G:/Meu Drive/nexo-projetos" });
    expect(loadConfig(home).projetosDir).toBe("G:/Meu Drive/nexo-projetos");
  });

  it("slugOverrides guarda mapa string->string, ignora valor não-string e mapa inválido", () => {
    const home = tempHome();
    expect(loadConfig(home).slugOverrides).toEqual({});
    saveConfig(home, { slugOverrides: { "c:/proj/a": "meu-projeto", "c:/proj/b": 123 as never } });
    expect(loadConfig(home).slugOverrides).toEqual({ "c:/proj/a": "meu-projeto" });
    saveConfig(home, { slugOverrides: "lixo" as never });
    expect(loadConfig(home).slugOverrides).toEqual({});
  });

  it("patch sem slugOverrides não apaga o mapa existente", () => {
    const home = tempHome();
    saveConfig(home, { slugOverrides: { "c:/proj/a": "meu-projeto" } });
    saveConfig(home, { accent: "#123456" });
    expect(loadConfig(home).slugOverrides).toEqual({ "c:/proj/a": "meu-projeto" });
  });
});
