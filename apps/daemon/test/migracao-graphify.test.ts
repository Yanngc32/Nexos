import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Garantia de migração: o graphify saiu por inteiro (Parte 1 da spec,
 * docs/superpowers/specs/2026-09-10-repo-map-design.md). Grep programático em vez de confiar só
 * na remoção manual dos arquivos — pega import esquecido, comentário desatualizado apontando pra
 * função que não existe mais, etc.
 *
 * Vocabulário específico do graphify, não a palavra solta "grafo" (que ainda é usada por conceitos
 * legítimos e não relacionados, tipo o "grafo de conhecimento" citado em outra parte do produto).
 */
const TERMOS_PROIBIDOS = [
  "graphify",
  "ensureGraphifyInstalled",
  "ferramentasDeGraphify",
  "MCP_TOOLS_GRAPHIFY",
  "graphifyDisponivel",
  "nexo_grafo_perguntar",
  "nexo_grafo_explicar",
];

const raizDoRepo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTAS_ALVO = [join(raizDoRepo, "apps", "daemon", "src"), join(raizDoRepo, "apps", "desktop")];

function arquivosDeCodigo(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...arquivosDeCodigo(full));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|cjs|mjs|html)$/i.test(ent.name)) out.push(full);
  }
  return out;
}

describe("migração do graphify", () => {
  it("nenhuma referência viva a graphify sobra em apps/daemon/src ou apps/desktop", () => {
    const achados: string[] = [];
    for (const pasta of PASTAS_ALVO) {
      let arquivos: string[];
      try {
        arquivos = arquivosDeCodigo(pasta);
      } catch {
        continue;
      }
      for (const arquivo of arquivos) {
        if (!statSync(arquivo).isFile()) continue;
        const conteudo = readFileSync(arquivo, "utf8");
        for (const termo of TERMOS_PROIBIDOS) {
          if (conteudo.includes(termo)) achados.push(`${arquivo}: "${termo}"`);
        }
      }
    }
    expect(achados).toEqual([]);
  });
});
