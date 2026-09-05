/**
 * Árvore de arquivos e prévia do painel "Arquivo".
 *
 * Fala só com o IPC do main (`window.nexo.listDir` / `readFile`), que é quem
 * prende os caminhos à pasta do projeto — aqui não há confinamento nenhum, e
 * não deve haver: qualquer caminho que chegue já veio validado pelo `boundPath`
 * do lado do Electron.
 *
 * `nexo` e os elementos entram por parâmetro pelo mesmo motivo do api.js: dá pra
 * exercitar os estados de vazio, erro e seleção sem subir o app.
 */
export function createFileTree({ nexo, getProjectPath, treeEl, previewEl }) {
  /** Caminho relativo do arquivo aberto; a marca de selecionado sai daqui. */
  let selecionado = "";

  function aviso(container, texto) {
    const p = container.ownerDocument.createElement("p");
    p.className = "tree-empty";
    p.textContent = texto;
    container.append(p);
  }

  async function fill(container, rel) {
    container.replaceChildren();
    if (!nexo()?.listDir) {
      aviso(container, "API de arquivos indisponível.");
      return;
    }
    if (!getProjectPath()) {
      aviso(container, "Abre um projeto na barra esquerda.");
      return;
    }
    let data;
    try {
      data = await nexo().listDir(rel);
    } catch (e) {
      aviso(container, e.message || "Não deu pra listar.");
      return;
    }
    if (!data.entries.length) {
      aviso(container, "Pasta vazia.");
      return;
    }
    const doc = container.ownerDocument;
    for (const ent of data.entries) {
      if (ent.dir) {
        const det = doc.createElement("details");
        const sum = doc.createElement("summary");
        sum.textContent = ent.name;
        const kids = doc.createElement("div");
        det.append(sum, kids);
        // Só lista a subpasta quando ela abre, e uma vez só: a árvore de um
        // repositório grande não cabe num carregamento só.
        det.addEventListener("toggle", () => {
          if (det.open && !det.dataset.loaded) {
            det.dataset.loaded = "1";
            void fill(kids, ent.path);
          }
        });
        container.append(det);
      } else {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "tree-file";
        btn.textContent = ent.name;
        btn.dataset.path = ent.path;
        btn.dataset.on = ent.path === selecionado ? "1" : "0";
        btn.addEventListener("click", () => void open(ent.path));
        container.append(btn);
      }
    }
  }

  async function open(rel) {
    selecionado = rel;
    for (const btn of treeEl().querySelectorAll("button.tree-file")) {
      btn.dataset.on = btn.dataset.path === rel ? "1" : "0";
    }
    const preview = previewEl();
    preview.textContent = "Lendo…";
    try {
      const data = await nexo().readFile(rel);
      if (data.dir) {
        preview.textContent = "Pasta — abre na árvore.";
        return;
      }
      if (data.tooBig) {
        preview.textContent = `${rel}\n\nArquivo grande demais para prévia (${Math.round(data.size / 1024)} KB).`;
        return;
      }
      if (data.binary) {
        preview.textContent = `${rel}\n\nBinário — sem prévia.`;
        return;
      }
      preview.textContent = data.text || "(vazio)";
    } catch (e) {
      preview.textContent = e.message || "Falha ao ler.";
    }
  }

  async function load() {
    await fill(treeEl(), ".");
  }

  /** Troca de projeto: a seleção antiga não vale mais. */
  function limparSelecao() {
    selecionado = "";
  }

  return { load, open, limparSelecao, selecionado: () => selecionado };
}
