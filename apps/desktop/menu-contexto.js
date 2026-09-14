/**
 * Menu de botão direito no visual do app, em vez do menu nativo do Chromium (que só
 * oferece recortar/colar e não sabe nada de repositório, conversa ou módulo).
 * Um menu por vez: abrir de novo fecha o anterior. Mesmo padrão de dependência por
 * parâmetro de `dialogo.js`/`file-tree.js` — dá pra testar sem Electron.
 *
 * Item: `{ rotulo, atalho?, ico?, onSelect, perigo?, desativado? }`.
 * Separador: `{ separador: true }`. Cabeçalho de seção: `{ titulo: "Telas" }`.
 */
export function criarMenuContexto({ doc = document } = {}) {
  /** O <div> do menu aberto; `null` quando fechado. */
  let atual = null;
  /** Desfaz os listeners globais do menu aberto. */
  let desligar = null;
  /** Índice do item navegável em foco pelo teclado; -1 = nenhum. */
  let foco = -1;
  /** Só os itens clicáveis, na ordem em que aparecem. */
  let navegaveis = [];

  const acionavel = (it) => it && !it.separador && !it.titulo && !it.desativado;

  function fechar() {
    if (!atual) return;
    desligar?.();
    desligar = null;
    atual.remove();
    atual = null;
    navegaveis = [];
    foco = -1;
  }

  function marcarFoco() {
    navegaveis.forEach(({ el }, i) => {
      el.dataset.on = i === foco ? "1" : "0";
    });
    if (foco >= 0) navegaveis[foco].el.focus();
  }

  function mover(passo) {
    if (!navegaveis.length) return;
    // Sem foco ainda: ↓ cai no primeiro, ↑ no último — o contrário dá a volta errada.
    if (foco < 0) foco = passo > 0 ? 0 : navegaveis.length - 1;
    else foco = (foco + passo + navegaveis.length) % navegaveis.length;
    marcarFoco();
  }

  function escolher(item) {
    fechar();
    item.onSelect?.();
  }

  /**
   * Encaixa o menu na janela: se estourar à direita/embaixo, espelha pro outro lado
   * do cursor em vez de sair da tela (canto inferior direito é onde mais dói).
   */
  function posicionar(el, x, y) {
    const larg = el.offsetWidth;
    const alt = el.offsetHeight;
    const w = doc.defaultView?.innerWidth ?? 1024;
    const h = doc.defaultView?.innerHeight ?? 768;
    const left = x + larg > w - 8 ? Math.max(8, x - larg) : x;
    const top = y + alt > h - 8 ? Math.max(8, y - alt) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /**
   * @param {{ clientX?: number, clientY?: number, preventDefault?: () => void, stopPropagation?: () => void }} evento
   * @param {Array<object>} itens
   */
  function abrir(evento, itens) {
    evento?.preventDefault?.();
    evento?.stopPropagation?.();
    fechar();
    const lista = (itens || []).filter(Boolean);
    if (!lista.length) return;

    const el = doc.createElement("div");
    el.className = "ctx-menu";
    el.setAttribute("role", "menu");
    navegaveis = [];

    for (const item of lista) {
      if (item.separador) {
        const hr = doc.createElement("div");
        hr.className = "ctx-sep";
        el.append(hr);
        continue;
      }
      if (item.titulo) {
        const t = doc.createElement("div");
        t.className = "ctx-titulo";
        t.textContent = item.titulo;
        el.append(t);
        continue;
      }
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "ctx-item";
      b.setAttribute("role", "menuitem");
      if (item.perigo) b.dataset.perigo = "1";
      if (item.desativado) b.disabled = true;
      const ico = doc.createElement("span");
      ico.className = "ctx-ico";
      ico.textContent = item.ico || "";
      const rot = doc.createElement("span");
      rot.className = "ctx-rotulo";
      rot.textContent = item.rotulo || "";
      const key = doc.createElement("span");
      key.className = "ctx-atalho";
      key.textContent = item.atalho || "";
      b.append(ico, rot, key);
      if (acionavel(item)) {
        b.addEventListener("click", () => escolher(item));
        b.addEventListener("mouseenter", () => {
          foco = navegaveis.findIndex((n) => n.el === b);
          marcarFoco();
        });
        navegaveis.push({ el: b, item });
      }
      el.append(b);
    }

    doc.body.append(el);
    atual = el;
    posicionar(el, Number(evento?.clientX) || 0, Number(evento?.clientY) || 0);

    const noClique = (e) => {
      if (!el.contains(e.target)) fechar();
    };
    const naTecla = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        fechar();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        mover(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        mover(-1);
      } else if (e.key === "Enter" && foco >= 0) {
        e.preventDefault();
        escolher(navegaveis[foco].item);
      }
    };
    // Rolar/redimensionar deixaria o menu ancorado no vazio: fecha em vez de reposicionar.
    const noScroll = () => fechar();
    doc.addEventListener("mousedown", noClique, true);
    doc.addEventListener("contextmenu", noClique, true);
    doc.addEventListener("keydown", naTecla, true);
    doc.defaultView?.addEventListener("resize", noScroll);
    doc.addEventListener("scroll", noScroll, true);
    desligar = () => {
      doc.removeEventListener("mousedown", noClique, true);
      doc.removeEventListener("contextmenu", noClique, true);
      doc.removeEventListener("keydown", naTecla, true);
      doc.defaultView?.removeEventListener("resize", noScroll);
      doc.removeEventListener("scroll", noScroll, true);
    };
    return el;
  }

  return { abrir, fechar, get aberto() { return Boolean(atual); } };
}
