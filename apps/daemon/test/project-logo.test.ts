import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acharLogo, definirLogoManual, limparLogoManual, logoDoProjeto } from "../src/project-logo.ts";
import { tempHome } from "./helpers.ts";

function projeto(arquivos: Record<string, string>): string {
  const p = mkdtempSync(join(tmpdir(), "nexo-logo-"));
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    mkdirSync(join(p, rel, ".."), { recursive: true });
    writeFileSync(join(p, rel), conteudo);
  }
  return p;
}

describe("acharLogo", () => {
  it("ícone quadrado ganha de logo horizontal; svg ganha de png", () => {
    const p = projeto({ "public/logo.png": "x", "public/favicon.png": "x", "public/favicon.svg": "<svg/>", "docs/logo-antigo.svg": "<svg/>" });
    expect(acharLogo(p)).toEqual({ caminho: join(p, "public", "favicon.svg"), mime: "image/svg+xml" });
  });

  it("sem ícone, usa o logo", () => {
    const p = projeto({ "src/assets/logo.svg": "<svg/>", "src/assets/foto.png": "x" });
    expect(acharLogo(p)?.caminho).toBe(join(p, "src", "assets", "logo.svg"));
  });

  it("ignora node_modules, arquivo vazio e extensão que não é imagem", () => {
    const p = projeto({ "node_modules/pkg/logo.svg": "<svg/>", "public/logo.txt": "x", "public/icon.png": "" });
    expect(acharLogo(p)).toBeNull();
  });
});

describe("ícone escolhido à mão", () => {
  it("ganha do automático, troca de formato sem sobrar arquivo velho e volta pro automático ao limpar", () => {
    const home = tempHome();
    const p = projeto({ "public/favicon.svg": "<svg/>" });
    expect(logoDoProjeto(p, home)?.caminho).toBe(join(p, "public", "favicon.svg"));
    definirLogoManual(p, home, "marca.png", Buffer.from("png").toString("base64"));
    const png = logoDoProjeto(p, home)!;
    expect(png).toMatchObject({ mime: "image/png", manual: true });
    expect(readFileSync(png.caminho, "utf8")).toBe("png");
    definirLogoManual(p, home, "marca.svg", Buffer.from("<svg/>").toString("base64"));
    expect(logoDoProjeto(p, home)?.mime).toBe("image/svg+xml");
    expect(existsSync(png.caminho)).toBe(false);
    expect(() => definirLogoManual(p, home, "x.gif", "AA==")).toThrow(/formato/);
    limparLogoManual(p, home);
    expect(logoDoProjeto(p, home)?.manual).toBeUndefined();
  });
});
