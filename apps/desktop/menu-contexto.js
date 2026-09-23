/**
 * Menu de botão direito no visual do app, em vez do menu nativo do Chromium (que só
 * oferece recortar/colar e não sabe nada de repositório, conversa ou módulo).
 * Um menu por vez: abrir de novo fecha o anterior. Mesmo padrão de dependência por
 * parâmetro de `dialogo.js`/`file-tree.js` — dá pra testar sem Electron.
 *
 * Item: `{ rotulo, atalho?, ico?, icoSvg?, onSelect, perigo?, desativado? }` — `icoSvg` é markup
 * do próprio app (nunca texto vindo de fora) e ganha do `ico`.
 * Submenu: `{ rotulo, ico?, submenu: [itens] }` — abre ao passar o mouse (ou → no teclado),
 * um nível só. Separador: `{ separador: true }`. Cabeçalho de seção: `{ titulo: "Telas" }`.
 */

/** Quanto o submenu espera antes de fechar quando o mouse vai pra outro item: dá tempo de
 *  cruzar na diagonal por cima dos vizinhos sem o submenu sumir no meio do caminho. */
const ATRASO_FECHAR_SUB = 250;

export function criarMenuContexto({ doc = document } = {}) {
  /** O <div> do menu aberto; `null` quando fechado. */
  let atual = null;
  /** Desfaz os listeners globais do menu aberto. */
  let desligar = null;
  /** Nível raiz: só os itens clicáveis, na ordem em que aparecem, e o índice em foco (-1 = nenhum). */
  let raiz = { navegaveis: [], foco: -1 };
  /** Submenu aberto: `{ el, dono, navegaveis, foco }`; `null` quando não há. */
  let sub = null;
  let timerSub = null;

  const temSub = (it) => Array.isArray(it?.submenu) && it.submenu.some(Boolean);
  const acionavel = (it) =>
    it && !it.separador && !it.titulo && !it.desativado && (!Array.isArray(it.submenu) || temSub(it));
  const win = () => doc.defaultView;

  function cancelarFecharSub() {
    if (timerSub) win()?.clearTimeout(timerSub);
    timerSub = null;
  }

  function fecharSub() {
    cancelarFecharSub();
    if (!sub) return;
    sub.el.remove();
    delete sub.dono.dataset.aberto;
    sub.dono.setAttribute("aria-expanded", "false");
    sub = null;
  }

  function agendarFecharSub() {
    cancelarFecharSub();
    if (!sub) return;
    const w = win();
    if (!w) return fecharSub();
    timerSub = w.setTimeout(fecharSub, ATRASO_FECHAR_SUB);
  }

  function fechar() {
    if (!atual) return;
    fecharSub();
    desligar?.();
    desligar = null;
    atual.remove();
    atual = null;
    raiz = { navegaveis: [], foco: -1 };
  }

  function marcarFoco(nivel) {
    nivel.navegaveis.forEach(({ el }, i) => {
      el.dataset.on = i === nivel.foco ? "1" : "0";
    });
    if (nivel.foco >= 0) nivel.navegaveis[nivel.foco].el.focus();
  }

  /** O teclado mexe no submenu só depois que entrou nele (→ ou mouse); senão, na raiz. */
  const nivelAtivo = () => (sub && sub.foco >= 0 ? sub : raiz);

  function mover(passo) {
    const nivel = nivelAtivo();
    const n = nivel.navegaveis.length;
    if (!n) return;
    // Sem foco ainda: ↓ cai no primeiro, ↑ no último — o contrário dá a volta errada.
    if (nivel.foco < 0) nivel.foco = passo > 0 ? 0 : n - 1;
    else nivel.foco = (nivel.foco + passo + n) % n;
    marcarFoco(nivel);
    // Andar pela raiz com o teclado não arrasta o submenu de outro item junto.
    if (nivel === raiz && sub && raiz.navegaveis[raiz.foco]?.el !== sub.dono) fecharSub();
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
    const w = win()?.innerWidth ?? 1024;
    const h = win()?.innerHeight ?? 768;
    const left = x + larg > w - 8 ? Math.max(8, x - larg) : x;
    const top = y + alt > h - 8 ? Math.max(8, y - alt) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** Submenu ao lado do item dono: à direita, ou à esquerda se não couber; alinhado ao topo do item. */
  function posicionarSub(el, dono) {
    const r = dono.getBoundingClientRect();
    const larg = el.offsetWidth;
    const alt = el.offsetHeight;
    const w = win()?.innerWidth ?? 1024;
    const h = win()?.innerHeight ?? 768;
    const left = r.right + 4 + larg > w - 8 ? Math.max(8, r.left - 4 - larg) : r.right + 4;
    // -7 = padding + borda do menu: o primeiro item do submenu fica na altura do dono
    const top = Math.max(8, Math.min(r.top - 7, h - 8 - alt));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** Desenha `lista` dentro de `el` e devolve os itens navegáveis. */
  function montar(el, lista, nivel) {
    const navegaveis = [];
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
      if (!acionavel(item)) b.disabled = true;
      const ico = doc.createElement("span");
      ico.className = "ctx-ico";
      if (item.icoSvg) ico.innerHTML = item.icoSvg;
      else ico.textContent = item.ico || "";
      const rot = doc.createElement("span");
      rot.className = "ctx-rotulo";
      rot.textContent = item.rotulo || "";
      const key = doc.createElement("span");
      key.className = "ctx-atalho";
      key.textContent = temSub(item) ? "›" : item.atalho || "";
      b.append(ico, rot, key);
      if (temSub(item)) {
        b.dataset.sub = "1";
        b.setAttribute("aria-haspopup", "menu");
        b.setAttribute("aria-expanded", "false");
      }
      if (acionavel(item)) {
        const eu = navegaveis.length;
        b.addEventListener("click", () => (temSub(item) ? abrirSub(b, item, true) : escolher(item)));
        b.addEventListener("mouseenter", () => {
          const alvo = nivel === "raiz" ? raiz : sub;
          if (!alvo) return;
          alvo.foco = eu;
          marcarFoco(alvo);
          if (nivel === "sub") return cancelarFecharSub();
          if (temSub(item)) abrirSub(b, item, false);
          else agendarFecharSub();
        });
        navegaveis.push({ el: b, item });
      }
      el.append(b);
    }
    return navegaveis;
  }

  /** `peloTeclado`: já entra com foco no primeiro item (→/Enter/clique); pelo hover, só mostra. */
  function abrirSub(dono, item, peloTeclado) {
    cancelarFecharSub();
    if (sub?.dono === dono) {
      if (peloTeclado && sub.foco < 0) {
        sub.foco = 0;
        marcarFoco(sub);
      }
      return;
    }
    fecharSub();
    const el = doc.createElement("div");
    el.className = "ctx-menu ctx-sub";
    el.setAttribute("role", "menu");
    sub = { el, dono, navegaveis: [], foco: -1 };
    sub.navegaveis = montar(el, item.submenu.filter(Boolean), "sub");
    el.addEventListener("mouseenter", cancelarFecharSub);
    // Fica dentro do menu raiz: o clique-fora continua valendo pros dois de uma vez.
    atual.append(el);
    dono.dataset.aberto = "1";
    dono.setAttribute("aria-expanded", "true");
    posicionarSub(el, dono);
    if (peloTeclado) {
      sub.foco = 0;
      marcarFoco(sub);
    }
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
    raiz = { navegaveis: [], foco: -1 };
    raiz.navegaveis = montar(el, lista, "raiz");

    doc.body.append(el);
    atual = el;
    posicionar(el, Number(evento?.clientX) || 0, Number(evento?.clientY) || 0);

    const noClique = (e) => {
      if (!el.contains(e.target)) fechar();
    };
    const naTecla = (e) => {
      const nivel = nivelAtivo();
      const focado = nivel.foco >= 0 ? nivel.navegaveis[nivel.foco] : null;
      if (e.key === "Escape" || (e.key === "ArrowLeft" && nivel === sub)) {
        e.preventDefault();
        // Esc/← dentro do submenu volta pro item dono; na raiz, Esc fecha tudo.
        if (nivel === sub) {
          const dono = sub.dono;
          fecharSub();
          raiz.foco = raiz.navegaveis.findIndex((n) => n.el === dono);
          marcarFoco(raiz);
        } else fechar();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        mover(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        mover(-1);
      } else if (e.key === "ArrowRight" && nivel === raiz && focado && temSub(focado.item)) {
        e.preventDefault();
        abrirSub(focado.el, focado.item, true);
      } else if (e.key === "Enter" && focado) {
        e.preventDefault();
        if (nivel === raiz && temSub(focado.item)) abrirSub(focado.el, focado.item, true);
        else escolher(focado.item);
      }
    };
    // Rolar/redimensionar deixaria o menu ancorado no vazio: fecha em vez de reposicionar.
    const noScroll = () => fechar();
    doc.addEventListener("mousedown", noClique, true);
    doc.addEventListener("contextmenu", noClique, true);
    doc.addEventListener("keydown", naTecla, true);
    win()?.addEventListener("resize", noScroll);
    doc.addEventListener("scroll", noScroll, true);
    desligar = () => {
      doc.removeEventListener("mousedown", noClique, true);
      doc.removeEventListener("contextmenu", noClique, true);
      doc.removeEventListener("keydown", naTecla, true);
      win()?.removeEventListener("resize", noScroll);
      doc.removeEventListener("scroll", noScroll, true);
    };
    return el;
  }

  return { abrir, fechar, get aberto() { return Boolean(atual); } };
}
