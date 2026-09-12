import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { memoriaPath, memoriaRoot, projectHash, projectMemoriaDir, readMemoria } from "../src/memoria.ts";
import { tempHome } from "./helpers.ts";

describe("memoriaRoot (layout legado)", () => {
  it("default é <home>/memoria", () => {
    const home = tempHome();
    expect(memoriaRoot(home)).toBe(join(home, "memoria"));
  });

  it("config.memoriaDir sobrescreve o default — é assim que atravessa PC diferente", () => {
    const home = tempHome();
    saveConfig(home, { memoriaDir: "G:/Meu Drive/nexo-memoria" });
    expect(memoriaRoot(home)).toBe("G:/Meu Drive/nexo-memoria");
  });
});

describe("projectHash", () => {
  it("é estável pro mesmo projeto e diferente entre projetos", () => {
    const a1 = projectHash("/proj/a");
    const a2 = projectHash("/proj/a");
    const b = projectHash("/proj/b");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("caminho com capitalização/barra diferente no Windows dá o mesmo hash", () => {
    expect(projectHash("C:\\Proj\\App")).toBe(projectHash("c:/proj/app/"));
  });
});

describe("projectMemoriaDir — layout novo (default, sem memoriaDir configurado)", () => {
  it("cria <projectDir>/memoria, com meta.json na pasta do projeto (um nível acima)", () => {
    const home = tempHome();
    const dir = projectMemoriaDir("/proj/a", home);
    expect(existsSync(dir)).toBe(true);
    expect(dir.endsWith(join("a", "memoria"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dirname(dir), "meta.json"), "utf8"));
    expect(meta.projectPath).toBe("/proj/a");
  });

  it("é idempotente: chamar de novo devolve a mesma pasta, sem apagar conteúdo", () => {
    const home = tempHome();
    const dir = projectMemoriaDir("/proj/a", home);
    writeFileSync(join(dir, "MEMORIA.md"), "conteúdo", "utf8");
    const dir2 = projectMemoriaDir("/proj/a", home);
    expect(dir2).toBe(dir);
    expect(readFileSync(join(dir, "MEMORIA.md"), "utf8")).toBe("conteúdo");
  });
});

describe("projectMemoriaDir — layout legado (memoriaDir configurado)", () => {
  it("cria a pasta com meta.json guardando o projectPath real", () => {
    const home = tempHome();
    saveConfig(home, { memoriaDir: join(home, "memoria-custom") });
    const dir = projectMemoriaDir("/proj/a", home);
    expect(existsSync(dir)).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.projectPath).toBe("/proj/a");
  });

  it("é idempotente: chamar de novo não sobrescreve o meta.json", () => {
    const home = tempHome();
    saveConfig(home, { memoriaDir: join(home, "memoria-custom") });
    const dir = projectMemoriaDir("/proj/a", home);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ projectPath: "/proj/a", extra: "x" }), "utf8");
    projectMemoriaDir("/proj/a", home);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.extra).toBe("x");
  });
});

describe("readMemoria", () => {
  it("devolve vazio quando o projeto nunca teve memória escrita, sem criar nada", () => {
    const home = tempHome();
    expect(readMemoria("/proj/nunca-visto", home)).toBe("");
    expect(existsSync(join(home, "projetos"))).toBe(false);
    expect(existsSync(memoriaRoot(home))).toBe(false);
  });

  it("lê o MEMORIA.md depois de escrito", () => {
    const home = tempHome();
    const path = memoriaPath("/proj/a", home);
    writeFileSync(path, "# fatos\n- usa RTK", "utf8");
    expect(readMemoria("/proj/a", home)).toBe("# fatos\n- usa RTK");
  });
});
