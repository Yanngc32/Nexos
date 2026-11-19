import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blocoDeDocs, TETO_INDICE_DOCS } from "../src/docs-indice.ts";

const criados: string[] = [];
afterEach(() => {
  for (const d of criados.splice(0)) rmSync(d, { recursive: true, force: true });
});

function projeto(arquivos: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nexo-docs-"));
  criados.push(dir);
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), conteudo);
  }
  return dir;
}

describe("blocoDeDocs", () => {
  it("sem docs não gera bloco", () => {
    expect(blocoDeDocs(projeto({ "src/a.ts": "x" }))).toBe("");
  });

  it("lista *.md da raiz e docs/** com o primeiro título, em ordem", () => {
    const dir = projeto({
      "README.md": "intro solta\n# Nexos\n## sub",
      "AGENTS.md": "sem título nenhum",
      "docs/arquitetura.md": "# Arquitetura do daemon\n",
      "docs/guias/deploy.md": "---\nx: 1\n---\n#   Como publicar  \n",
      "src/notas.md": "# fora do índice",
    });
    const bloco = blocoDeDocs(dir);
    expect(bloco.split("\n").slice(0, 1)).toEqual(["# Docs do projeto"]);
    expect(bloco).toContain(
      ["- AGENTS.md", "- docs/arquitetura.md — Arquitetura do daemon", "- docs/guias/deploy.md — Como publicar", "- README.md — Nexos"].join("\n"),
    );
    expect(bloco).not.toContain("src/notas.md");
  });

  it("pula node_modules, pasta com ponto e build/dist dentro de docs", () => {
    const dir = projeto({
      "docs/ok.md": "# Ok",
      "docs/node_modules/x.md": "# não",
      "docs/.rascunho/y.md": "# não",
      "docs/build/z.md": "# não",
      "docs/dist/w.md": "# não",
    });
    const bloco = blocoDeDocs(dir);
    expect(bloco).toContain("- docs/ok.md — Ok");
    expect(bloco).not.toContain("# não");
  });

  it("respeita o teto e avisa quantos ficaram de fora", () => {
    const arquivos: Record<string, string> = {};
    for (let i = 0; i < 200; i++) arquivos[`docs/doc-${String(i).padStart(3, "0")}.md`] = `# Título bem descritivo do documento ${i}`;
    const bloco = blocoDeDocs(projeto(arquivos));
    expect(bloco.length).toBeLessThanOrEqual(TETO_INDICE_DOCS);
    expect(bloco).toMatch(/- … e mais \d+ doc\(s\) fora do índice$/);
  });
});
