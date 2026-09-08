import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guarda contra uma classe de bug que só aparece no Windows.
 *
 * `new URL(import.meta.url).pathname` devolve `/D:/a/repo/...` no Windows, e
 * `join` com isso produz `D:\D:\a\repo\...` — a letra de unidade duplicada. No
 * Linux o mesmo código funciona, então o teste unitário passa, o desenvolvedor
 * não vê nada, e quebra na máquina de quem usa. Aconteceu: o `skill.ts` foi
 * assim e o CI do Windows caiu em três commits seguidos.
 *
 * O certo é `fileURLToPath`, que o resto do projeto já usava. Este teste varre o
 * repositório em vez de olhar um arquivo, porque o problema é a próxima vez.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fontes(dir: string, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === "node_modules" || nome === ".git" || nome === "dist") continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) fontes(caminho, achados);
    else if (/\.(ts|js|mjs)$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

describe("caminho a partir de import.meta.url", () => {
  it("ninguém usa `.pathname`, que quebra no Windows", () => {
    const culpados = fontes(raiz).filter((f) => {
      const t = readFileSync(f, "utf8");
      // o teste em si menciona o padrão pra explicá-lo; ele não o usa
      if (f.endsWith("caminhos.test.ts")) return false;
      return /new URL\(\s*import\.meta\.url\s*\)\s*\.pathname/.test(t);
    });
    expect(culpados.map((f) => f.slice(raiz.length + 1))).toEqual([]);
  });

  it("e há quem use o jeito certo — teste que não acha nada não vigia nada", () => {
    const certos = fontes(raiz).filter((f) => /fileURLToPath\(\s*import\.meta\.url\s*\)/.test(readFileSync(f, "utf8")));
    expect(certos.length).toBeGreaterThan(3);
  });
});
