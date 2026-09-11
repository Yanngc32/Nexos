/**
 * Overlay visual do "mouse do agente" no modo navegador (`nexo_navegador_clicar`/`digitar`) — um
 * marcador que se move até o elemento e pisca antes do evento sintético de verdade disparar,
 * pra pessoa acompanhar ao vivo onde o agente está agindo, em vez da ação acontecer invisível.
 *
 * Mesmo padrão de fábrica de `inspector-overlay.cjs` (estado próprio por instância, testável com
 * happy-dom sem `document` global compartilhado entre testes) — módulo à parte porque é um
 * conceito diferente (posição de um "cursor", não destaque de retângulo/badge).
 */

function aplicaEstiloCursor(el) {
  Object.assign(el.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    left: "0px",
    top: "0px",
    width: "16px",
    height: "16px",
    marginLeft: "-8px",
    marginTop: "-8px",
    borderRadius: "50%",
    background: "#7c5cbf",
    boxShadow: "0 0 0 0 rgba(124, 92, 191, .55)",
    transition: "left 220ms ease, top 220ms ease, box-shadow 450ms ease",
    display: "none",
  });
}

function centroDe(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function criarCursorAgente() {
  let cursor = null;
  let escondeTimeout = 0;

  function garanteCursor() {
    if (cursor && cursor.isConnected) return cursor;
    cursor = document.createElement("div");
    aplicaEstiloCursor(cursor);
    document.documentElement.appendChild(cursor);
    return cursor;
  }

  function moverPara(el) {
    const c = garanteCursor();
    const { x, y } = centroDe(el);
    clearTimeout(escondeTimeout);
    c.style.display = "block";
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
    return c;
  }

  return {
    /** Move o cursor até `el` e faz um "clique" visual (ripple) — chame ANTES do evento sintético de verdade. */
    mostrarClique(el) {
      const c = moverPara(el);
      // reflow força o navegador a aplicar o box-shadow "fechado" antes de abrir o ripple,
      // senão as duas mudanças colapsam numa transição só e o clique não pisca
      void c.offsetWidth;
      c.style.boxShadow = "0 0 0 10px rgba(124, 92, 191, 0)";
      escondeTimeout = setTimeout(() => {
        c.style.display = "none";
        c.style.boxShadow = "0 0 0 0 rgba(124, 92, 191, .55)";
      }, 700);
    },

    /** Só posiciona o cursor sobre `el`, sem ripple de clique — chame antes de digitar. */
    mostrarFoco(el) {
      moverPara(el);
      escondeTimeout = setTimeout(() => {
        if (cursor) cursor.style.display = "none";
      }, 900);
    },
  };
}

module.exports = { criarCursorAgente };
