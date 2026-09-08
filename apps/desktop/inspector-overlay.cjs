/**
 * Overlay visual do inspector de elemento do painel Browser: caixa de destaque no hover e
 * badges numerados nos elementos marcados. Fábrica (`criarOverlay`), não singleton — cada
 * instância tem seu próprio estado (overlay de hover, lista de badges, contador), pra dar
 * pra testar com happy-dom sem um `document` global compartilhado entre testes.
 *
 * Quem decide QUANDO chamar cada método (liga/desliga do modo seleção, listeners de
 * mouse/scroll/resize) é `browser-inspector-preload.cjs` — este módulo só sabe desenhar.
 */

function aplicaEstilo(el, extra) {
  Object.assign(el.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    boxSizing: "border-box",
    margin: "0",
    padding: "0",
    display: "none",
    ...extra,
  });
}

function posicionaSobre(el, caixa) {
  const r = el.getBoundingClientRect();
  Object.assign(caixa.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: "block" });
}

function criarEtiqueta() {
  const etiqueta = document.createElement("span");
  Object.assign(etiqueta.style, {
    position: "absolute",
    top: "-20px",
    left: "-2px",
    background: "#4f9dff",
    color: "#fff",
    borderRadius: "4px",
    padding: "2px 6px",
    fontSize: "11px",
    lineHeight: "16px",
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    whiteSpace: "nowrap",
    maxWidth: "70vw",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  return etiqueta;
}

function criarOverlay() {
  let overlayHover = null;
  let etiquetaHover = null;
  let badges = [];

  function garanteOverlayHover() {
    if (overlayHover && overlayHover.isConnected) return overlayHover;
    overlayHover = document.createElement("div");
    aplicaEstilo(overlayHover, { border: "2px solid #4f9dff", background: "rgba(79,157,255,.12)" });
    etiquetaHover = criarEtiqueta();
    overlayHover.appendChild(etiquetaHover);
    document.documentElement.appendChild(overlayHover);
    return overlayHover;
  }

  function renumeraBadges() {
    badges.forEach((b, i) => {
      b.numeroEl.textContent = String(i + 1);
    });
  }

  function novoBadge(el) {
    const badge = document.createElement("div");
    aplicaEstilo(badge, { border: "2px solid #ff7a4f", background: "rgba(255,122,79,.10)" });
    const numeroEl = document.createElement("span");
    Object.assign(numeroEl.style, {
      position: "absolute",
      top: "-10px",
      left: "-10px",
      background: "#ff7a4f",
      color: "#fff",
      borderRadius: "999px",
      minWidth: "18px",
      height: "18px",
      fontSize: "11px",
      lineHeight: "18px",
      textAlign: "center",
      fontFamily: "system-ui, sans-serif",
    });
    badge.appendChild(numeroEl);
    document.documentElement.appendChild(badge);
    posicionaSobre(el, badge);
    return { el, badge, numeroEl };
  }

  return {
    /** Destaca `el` sob o mouse. `opts.etiqueta` é o texto colado no canto do contorno — o
     * seletor que vai ser capturado se a pessoa clicar agora. */
    mostrarHover(el, opts) {
      if (!el) return;
      posicionaSobre(el, garanteOverlayHover());
      if (etiquetaHover) etiquetaHover.textContent = opts?.etiqueta ?? "";
    },

    esconderHover() {
      if (overlayHover) overlayHover.style.display = "none";
    },

    /** true se `el` já tem badge — usado pra não duplicar marcação nem destacar no hover o que já está selecionado. */
    estaMarcado(el) {
      return badges.some((b) => b.el === el);
    },

    /** Cria badge numerado sobre `el` e retorna o índice (1-based). Não duplica: se `el` já está marcado, retorna `null`. */
    marcar(el) {
      if (this.estaMarcado(el)) return null;
      const item = novoBadge(el);
      badges.push(item);
      item.numeroEl.textContent = String(badges.length);
      return badges.length;
    },

    /** Remove o badge no índice (1-based) e renumera os restantes. */
    desmarcar(indice) {
      const i = indice - 1;
      if (i < 0 || i >= badges.length) return;
      badges[i].badge.remove();
      badges.splice(i, 1);
      renumeraBadges();
    },

    /** Pisca o badge do índice dado: engrossa a borda por 400ms e volta ao normal. */
    realcar(indice) {
      const item = badges[indice - 1];
      if (!item) return;
      item.badge.style.borderWidth = "4px";
      setTimeout(() => {
        item.badge.style.borderWidth = "2px";
      }, 400);
    },

    /** Reposiciona os badges sobre seus elementos (chamado em scroll/resize da página inspecionada). */
    reposicionarBadges() {
      for (const b of badges) posicionaSobre(b.el, b.badge);
    },

    /** Remove todos os badges e zera a numeração. */
    limpar() {
      for (const b of badges) b.badge.remove();
      badges = [];
    },
  };
}

module.exports = { criarOverlay };
