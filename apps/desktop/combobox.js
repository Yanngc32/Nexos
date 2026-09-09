/**
 * Lista customizada pro <select> nativo — só troca o POPUP, não a caixa fechada.
 *
 * A caixa fechada (borda, chevron, hover, foco) já é estilizada em CSS direto no `select` e
 * continua sendo o próprio elemento — nenhuma regra de layout existente (`.bar select`, largura,
 * flex, container query) precisa mudar. O que o Chromium não deixa estilizar é a LISTA aberta
 * (cantos, sombra, cor por opção): interceptamos o clique/tecla que abriria o popup nativo
 * (`preventDefault` no mousedown/keydown) e desenhamos a nossa, com o mesmo valor/opções/eventos
 * — `select.value = x` + `dispatchEvent(new Event("change"))` é exatamente o que o popup nativo
 * faria, então todo `addEventListener("change", ...)` do app continua funcionando sem mudar nada.
 */

let aberto = null; // { ul, select, ativo }

function fechar() {
  aberto?.ul.remove();
  aberto = null;
}

function posicionar(ul, select) {
  const r = select.getBoundingClientRect();
  const ALTURA_ITEM = 30;
  const alturaEstimativa = Math.min(select.options.length, 8) * ALTURA_ITEM + 8;
  ul.style.minWidth = `${r.width}px`;
  ul.style.left = `${Math.max(4, r.left)}px`;
  if (r.bottom + alturaEstimativa > window.innerHeight && r.top > alturaEstimativa) {
    ul.style.top = `${Math.max(4, r.top - alturaEstimativa - 4)}px`;
  } else {
    ul.style.top = `${r.bottom + 4}px`;
  }
}

function marcarAtivo(novo) {
  if (!aberto) return;
  const itens = [...aberto.ul.children];
  itens[aberto.ativo]?.classList.remove("ativa");
  aberto.ativo = Math.max(0, Math.min(itens.length - 1, novo));
  const item = itens[aberto.ativo];
  item?.classList.add("ativa");
  item?.scrollIntoView({ block: "nearest" });
}

function confirmar() {
  if (!aberto) return;
  const opt = aberto.select.options[aberto.ativo];
  if (!opt || opt.disabled) return;
  aberto.select.value = opt.value;
  aberto.select.dispatchEvent(new Event("change", { bubbles: true }));
  fechar();
}

function abrir(select) {
  if (select.disabled || select.options.length === 0) return;
  if (aberto?.select === select) return fechar();
  fechar();
  const ul = document.createElement("ul");
  ul.className = "cb-list";
  ul.setAttribute("role", "listbox");
  [...select.options].forEach((opt, i) => {
    const li = document.createElement("li");
    li.className = "cb-opt";
    li.setAttribute("role", "option");
    li.textContent = opt.textContent;
    if (i === select.selectedIndex) li.setAttribute("aria-selected", "true");
    if (opt.disabled) li.classList.add("desabilitada");
    // mousedown, não click: click viria DEPOIS do focus voltar pro select, tarde pra impedir
    // o popup nativo abrir de novo por cima.
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (opt.disabled) return;
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      fechar();
    });
    li.addEventListener("mouseenter", () => marcarAtivo(i));
    ul.append(li);
  });
  document.body.append(ul);
  posicionar(ul, select);
  aberto = { ul, select, ativo: select.selectedIndex };
  aberto.ul.children[aberto.ativo]?.classList.add("ativa");
}

/** Fase de captura: chega ANTES do handler nativo do `<select>`, a tempo de barrar o popup dele. */
function onMouseDown(e) {
  const select = e.target.closest?.("select");
  if (!select) {
    // clique fora da lista aberta e fora de qualquer select: fecha
    if (aberto && !aberto.ul.contains(e.target)) fechar();
    return;
  }
  e.preventDefault();
  select.focus();
  abrir(select);
}

function onKeyDown(e) {
  if (aberto) {
    if (e.key === "Escape") {
      e.preventDefault();
      fechar();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      marcarAtivo(aberto.ativo + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      marcarAtivo(aberto.ativo - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      confirmar();
    } else if (e.key === "Tab") {
      fechar();
    }
    return;
  }
  const select = e.target.tagName === "SELECT" ? e.target : null;
  if (!select || select.disabled) return;
  if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    abrir(select);
  }
}

/** Chama uma vez, no boot do app — cobre todo `<select>` da página, presente ou futuro. */
export function initCombobox() {
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  // rolar ou redimensionar sob a lista aberta a deixaria flutuando no lugar errado — mais simples
  // fechar do que reposicionar.
  window.addEventListener("resize", fechar);
  window.addEventListener("scroll", fechar, true);
  document.addEventListener("blur", (e) => {
    if (e.target?.tagName === "SELECT" && aberto?.select === e.target) fechar();
  }, true);
}
