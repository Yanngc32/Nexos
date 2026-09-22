import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acharLogo } from "../src/project-logo.ts";

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
