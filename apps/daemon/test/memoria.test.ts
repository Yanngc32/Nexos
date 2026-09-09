import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveConfig } from "../src/config.ts";
import { memoriaPath, memoriaRoot, projectHash, projectMemoriaDir, readMemoria } from "../src/memoria.ts";
import { tempHome } from "./helpers.ts";

describe("memoriaRoot", () => {
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

describe("projectMemoriaDir", () => {
  it("cria a pasta com meta.json guardando o projectPath real", () => {
    const home = tempHome();
    const dir = projectMemoriaDir("/proj/a", home);
    expect(existsSync(dir)).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.projectPath).toBe("/proj/a");
  });

  it("é idempotente: chamar de novo não sobrescreve o meta.json", () => {
    const home = tempHome();
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
    expect(existsSync(memoriaRoot(home))).toBe(false);
  });

  it("lê o MEMORIA.md depois de escrito", () => {
    const home = tempHome();
    const path = memoriaPath("/proj/a", home);
    writeFileSync(path, "# fatos\n- usa RTK", "utf8");
    expect(readMemoria("/proj/a", home)).toBe("# fatos\n- usa RTK");
  });
});
