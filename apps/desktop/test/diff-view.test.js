// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  colapsarContexto,
  diffDeFerramenta,
  diffLinhas,
  foiCortado,
  renderDiff,
  resumoDoDiff,
} from "../diff-view.js";

/** Atalho legível: "  a", "- b", "+ c" viram a forma comparável. */
const forma = (linhas) => linhas.map((l) => `${l.tipo}${l.texto}`);

describe("diffLinhas", () => {
  it("acha a linha trocada no meio, mantendo as iguais", () => {
    const d = diffLinhas("a\nb\nc", "a\nB\nc");
    expect(forma(d)).toEqual([" a", "-b", "+B", " c"]);
  });

  it("só adição", () => {
    expect(forma(diffLinhas("", "nova"))).toEqual(["+nova"]);
  });

  it("só remoção", () => {
    expect(forma(diffLinhas("velha", ""))).toEqual(["-velha"]);
  });

  it("texto igual não gera mudança nenhuma", () => {
    const d = diffLinhas("a\nb", "a\nb");
    expect(d.every((l) => l.tipo === " ")).toBe(true);
  });

  it("insere no meio sem marcar o resto como trocado", () => {
    // o ponto do LCS: sem ele, inserir uma linha "desalinha" tudo abaixo e o
    // diff vira uma parede de -/+ onde mudou uma linha só
    const d = diffLinhas("a\nb\nc", "a\nnova\nb\nc");
    expect(forma(d)).toEqual([" a", "+nova", " b", " c"]);
  });

  it("CRLF não vira mudança fantasma", () => {
    const d = diffLinhas("a\r\nb", "a\nb");
    expect(d.every((l) => l.tipo === " ")).toBe(true);
  });

  it("edição gigante não trava a tela: cai no bloco inteiro", () => {
    const grande = Array.from({ length: 700 }, (_, i) => `linha ${i}`).join("\n");
    const d = diffLinhas(grande, `${grande}\nmais uma`);
    // sem LCS: tudo removido e tudo adicionado, mas responde
    expect(d.filter((l) => l.tipo === "-").length).toBe(700);
    expect(d.filter((l) => l.tipo === "+").length).toBe(701);
  });
});

describe("colapsarContexto", () => {
  it("esconde o trecho longo sem mudança e diz quantas linhas sumiram", () => {
    const linhas = [
      ...Array.from({ length: 20 }, (_, i) => ({ tipo: " ", texto: `l${i}` })),
      { tipo: "+", texto: "nova" },
    ];
    const r = colapsarContexto(linhas);
    expect(r.find((l) => l.tipo === "…").texto).toBe("17 linhas sem mudança");
    // as 3 de contexto antes da mudança ficam
    expect(r.filter((l) => l.tipo === " ")).toHaveLength(3);
  });

  it("diff sem mudança nenhuma passa inteiro, sem virar só '…'", () => {
    const linhas = [
      { tipo: " ", texto: "a" },
      { tipo: " ", texto: "b" },
    ];
    expect(colapsarContexto(linhas)).toEqual(linhas);
  });

  it("singular quando é uma linha só", () => {
    // 4 iguais + 1 mudança: o contexto de 3 guarda as três últimas, sobra 1 pulada
    const linhas = [
      ...Array.from({ length: 4 }, (_, i) => ({ tipo: " ", texto: `l${i}` })),
      { tipo: "-", texto: "foi" },
    ];
    expect(colapsarContexto(linhas).find((l) => l.tipo === "…").texto).toBe("1 linha sem mudança");
  });
});

describe("foiCortado", () => {
  it("reconhece o corte que o daemon faz em 2000 chars + reticência", () => {
    /*
     * Importa porque diff de texto cortado INVENTA uma remoção no fim: parece
     * que o agente apagou código que ele nunca tocou.
     */
    expect(foiCortado(`${"x".repeat(2000)}…`)).toBe(true);
    expect(foiCortado("x".repeat(2001))).toBe(false);
    expect(foiCortado("curto…")).toBe(false);
    expect(foiCortado(undefined)).toBe(false);
  });
});

describe("diffDeFerramenta", () => {
  it("Edit vira diff com o arquivo e a contagem", () => {
    const d = diffDeFerramenta("Edit", {
      file_path: "/repo/a.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    expect(d.arquivo).toBe("/repo/a.ts");
    expect(d.adicionadas).toBe(1);
    expect(d.removidas).toBe(1);
    expect(d.arquivoNovo).toBe(false);
  });

  it("MultiEdit vira um bloco por edição", () => {
    const d = diffDeFerramenta("MultiEdit", {
      file_path: "/repo/a.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    });
    expect(d.blocos).toHaveLength(2);
    expect(d.adicionadas).toBe(2);
    expect(d.removidas).toBe(2);
  });

  it("Write sai como adição inteira e marcado como tal", () => {
    // não existe "antes": a ferramenta não manda e o daemon não guarda
    const d = diffDeFerramenta("Write", { file_path: "/repo/novo.ts", content: "linha 1\nlinha 2" });
    expect(d.arquivoNovo).toBe(true);
    expect(d.adicionadas).toBe(2);
    expect(d.removidas).toBe(0);
  });

  it("marca quando veio cortado do histórico", () => {
    const d = diffDeFerramenta("Edit", {
      file_path: "/repo/a.ts",
      old_string: `${"x".repeat(2000)}…`,
      new_string: "y",
    });
    expect(d.cortado).toBe(true);
  });

  it("ferramenta que não edita arquivo não vira diff", () => {
    expect(diffDeFerramenta("Bash", { command: "ls" })).toBeNull();
    expect(diffDeFerramenta("Read", { file_path: "/a" })).toBeNull();
    expect(diffDeFerramenta("Edit", null)).toBeNull();
    expect(diffDeFerramenta("MultiEdit", { edits: [] })).toBeNull();
  });
});

describe("resumoDoDiff", () => {
  it("mostra os dois lados, e omite o lado zerado", () => {
    expect(resumoDoDiff({ adicionadas: 12, removidas: 3 })).toBe("+12 −3");
    expect(resumoDoDiff({ adicionadas: 5, removidas: 0 })).toBe("+5");
    expect(resumoDoDiff(null)).toBe("");
  });
});

describe("renderDiff", () => {
  it("pinta adicionada e removida com classes distintas", () => {
    const el = document.createElement("div");
    renderDiff(el, diffDeFerramenta("Edit", { file_path: "/a", old_string: "velha", new_string: "nova" }));
    expect(el.querySelectorAll(".diff-del")).toHaveLength(1);
    expect(el.querySelectorAll(".diff-add")).toHaveLength(1);
    expect(el.querySelector(".diff-del .diff-texto").textContent).toBe("velha");
  });

  it("NÃO interpreta o código como HTML", () => {
    /*
     * O conteúdo é código de arquivo vindo de um modelo — exatamente o texto
     * que carrega tag sem querer. Por isso a renderização é por textContent, e
     * este teste é o que impede alguém de "simplificar" pra innerHTML depois.
     */
    const el = document.createElement("div");
    renderDiff(
      el,
      diffDeFerramenta("Edit", {
        file_path: "/a",
        old_string: "",
        new_string: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      }),
    );
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("script")).toBeNull();
    expect(el.textContent).toContain("<img src=x");
  });

  it("avisa quando o diff está incompleto por corte do histórico", () => {
    const el = document.createElement("div");
    renderDiff(
      el,
      diffDeFerramenta("Edit", { file_path: "/a", old_string: `${"x".repeat(2000)}…`, new_string: "y" }),
    );
    expect(el.querySelector(".diff-nota-aviso").textContent).toMatch(/incompleto/);
  });

  it("avisa que Write não tem o conteúdo anterior", () => {
    const el = document.createElement("div");
    renderDiff(el, diffDeFerramenta("Write", { file_path: "/a", content: "x" }));
    expect(el.querySelector(".diff-nota").textContent).toMatch(/conteúdo anterior/);
  });

  it("separa as edições de um MultiEdit", () => {
    const el = document.createElement("div");
    renderDiff(
      el,
      diffDeFerramenta("MultiEdit", {
        file_path: "/a",
        edits: [
          { old_string: "a", new_string: "A" },
          { old_string: "b", new_string: "B" },
        ],
      }),
    );
    expect(el.querySelectorAll(".diff")).toHaveLength(2);
    expect(el.querySelector(".diff-sep").textContent).toBe("edição 2");
  });

  it("diff nulo não quebra e não deixa lixo", () => {
    const el = document.createElement("div");
    el.innerHTML = "<span>antes</span>";
    renderDiff(el, null);
    expect(el.children).toHaveLength(0);
  });
});
