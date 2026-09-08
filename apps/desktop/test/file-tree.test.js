// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createFileTree } from "../file-tree.js";

/*
 * Só este arquivo precisa de DOM, então o ambiente vem por docblock em vez de
 * config global: os módulos puros continuam rodando no node, que é mais rápido.
 */

function montar({ listDir, readFile, projectPath = "/proj" } = {}) {
  document.body.innerHTML = '<div id="tree"></div><pre id="preview"></pre>';
  const tree = document.getElementById("tree");
  const preview = document.getElementById("preview");
  const nexo = {};
  if (listDir) nexo.listDir = listDir;
  if (readFile) nexo.readFile = readFile;
  const ft = createFileTree({
    nexo: () => nexo,
    getProjectPath: () => projectPath,
    treeEl: () => tree,
    previewEl: () => preview,
  });
  return { ft, tree, preview };
}

const pasta = (entries) => async () => ({ entries });

describe("árvore: estados sem conteúdo", () => {
  it("sem API de arquivos", async () => {
    const { ft, tree } = montar();
    await ft.load();
    expect(tree.textContent).toBe("API de arquivos indisponível.");
  });

  it("sem projeto aberto", async () => {
    const { ft, tree } = montar({ listDir: pasta([]), projectPath: "" });
    await ft.load();
    expect(tree.textContent).toBe("Abre um projeto na barra esquerda.");
  });

  it("pasta vazia", async () => {
    const { ft, tree } = montar({ listDir: pasta([]) });
    await ft.load();
    expect(tree.textContent).toBe("Pasta vazia.");
  });

  it("erro de listagem mostra o motivo, não some calado", async () => {
    const { ft, tree } = montar({
      listDir: async () => {
        throw new Error("Fora do projeto");
      },
    });
    await ft.load();
    expect(tree.textContent).toBe("Fora do projeto");
  });

  it("erro sem mensagem cai num texto genérico", async () => {
    const { ft, tree } = montar({
      listDir: async () => {
        throw new Error("");
      },
    });
    await ft.load();
    expect(tree.textContent).toBe("Não deu pra listar.");
  });
});

describe("árvore: montagem", () => {
  it("pasta vira details e arquivo vira botão", async () => {
    const { ft, tree } = montar({
      listDir: pasta([
        { name: "src", dir: true, path: "src" },
        { name: "README.md", dir: false, path: "README.md" },
      ]),
    });
    await ft.load();
    expect(tree.querySelectorAll("details")).toHaveLength(1);
    expect(tree.querySelector("summary").textContent).toBe("src");
    const btn = tree.querySelector("button.tree-file");
    expect(btn.textContent).toBe("README.md");
    expect(btn.dataset.path).toBe("README.md");
  });

  it("recarregar troca o conteúdo em vez de acumular", async () => {
    const { ft, tree } = montar({ listDir: pasta([{ name: "a.txt", dir: false, path: "a.txt" }]) });
    await ft.load();
    await ft.load();
    expect(tree.querySelectorAll("button.tree-file")).toHaveLength(1);
  });

  it("nome de arquivo com HTML não vira marcação", async () => {
    const { ft, tree } = montar({
      listDir: pasta([{ name: "<img src=x onerror=1>.txt", dir: false, path: "x.txt" }]),
    });
    await ft.load();
    expect(tree.querySelector("img")).toBeNull();
    expect(tree.querySelector("button.tree-file").textContent).toBe("<img src=x onerror=1>.txt");
  });
});

describe("árvore: subpasta carrega sob demanda", () => {
  it("só lista a subpasta quando abre, e uma vez só", async () => {
    const listDir = vi.fn(async (rel) =>
      rel === "." ? { entries: [{ name: "src", dir: true, path: "src" }] } : { entries: [] },
    );
    const { ft, tree } = montar({ listDir });
    await ft.load();
    expect(listDir).toHaveBeenCalledTimes(1);

    const det = tree.querySelector("details");
    det.open = true;
    det.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(listDir).toHaveBeenCalledTimes(2);
    expect(listDir).toHaveBeenLastCalledWith("src");

    // fechar e abrir de novo não relista
    det.open = false;
    det.dispatchEvent(new Event("toggle"));
    det.open = true;
    det.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(listDir).toHaveBeenCalledTimes(2);
  });
});

describe("prévia do arquivo", () => {
  const arvore = pasta([{ name: "a.txt", dir: false, path: "a.txt" }]);

  it("texto aparece", async () => {
    const { ft, preview } = montar({ listDir: arvore, readFile: async () => ({ text: "oi" }) });
    await ft.open("a.txt");
    expect(preview.textContent).toBe("oi");
  });

  it("arquivo vazio não fica em branco sem explicação", async () => {
    const { ft, preview } = montar({ listDir: arvore, readFile: async () => ({ text: "" }) });
    await ft.open("a.txt");
    expect(preview.textContent).toBe("(vazio)");
  });

  it("binário, grande demais e pasta têm cada um seu recado", async () => {
    const casos = [
      [{ binary: true, size: 10 }, /Binário/],
      [{ tooBig: true, size: 512 * 1024 }, /grande demais.*512 KB/s],
      [{ dir: true }, /abre na árvore/],
    ];
    for (const [data, esperado] of casos) {
      const { ft, preview } = montar({ listDir: arvore, readFile: async () => data });
      await ft.open("a.txt");
      expect(preview.textContent).toMatch(esperado);
    }
  });

  it("falha de leitura vira mensagem, não tela muda", async () => {
    const { ft, preview } = montar({
      listDir: arvore,
      readFile: async () => {
        throw new Error("Fora do projeto");
      },
    });
    await ft.open("a.txt");
    expect(preview.textContent).toBe("Fora do projeto");
  });

  it("conteúdo do arquivo entra como texto, nunca como HTML", async () => {
    const { ft, preview } = montar({
      listDir: arvore,
      readFile: async () => ({ text: "<script>alert(1)</script>" }),
    });
    await ft.open("a.txt");
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.textContent).toBe("<script>alert(1)</script>");
  });
});

describe("seleção", () => {
  it("abrir marca o botão do arquivo e desmarca o anterior", async () => {
    const { ft, tree } = montar({
      listDir: pasta([
        { name: "a.txt", dir: false, path: "a.txt" },
        { name: "b.txt", dir: false, path: "b.txt" },
      ]),
      readFile: async () => ({ text: "x" }),
    });
    await ft.load();
    const [a, b] = tree.querySelectorAll("button.tree-file");

    await ft.open("a.txt");
    expect(a.dataset.on).toBe("1");
    expect(b.dataset.on).toBe("0");

    await ft.open("b.txt");
    expect(a.dataset.on).toBe("0");
    expect(b.dataset.on).toBe("1");
  });

  it("a marca sobrevive a recarregar a árvore", async () => {
    const { ft, tree } = montar({
      listDir: pasta([{ name: "a.txt", dir: false, path: "a.txt" }]),
      readFile: async () => ({ text: "x" }),
    });
    await ft.load();
    await ft.open("a.txt");
    await ft.load();
    expect(tree.querySelector("button.tree-file").dataset.on).toBe("1");
  });

  it("trocar de projeto zera a seleção", async () => {
    const { ft, tree } = montar({
      listDir: pasta([{ name: "a.txt", dir: false, path: "a.txt" }]),
      readFile: async () => ({ text: "x" }),
    });
    await ft.open("a.txt");
    expect(ft.selecionado()).toBe("a.txt");
    ft.limparSelecao();
    await ft.load();
    expect(ft.selecionado()).toBe("");
    expect(tree.querySelector("button.tree-file").dataset.on).toBe("0");
  });
});
