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
 *
 * `<optgroup data-recolhivel>` vira um item "título ›" que abre/fecha as opções dele dentro da
 * própria lista (ex.: "Modelos antigos"). Começa fechado, a não ser que a opção escolhida esteja lá.
 */

/** `{ ul, select, itens: [{ li, opt?, grupo? }], ativo }` — `ativo` indexa `itens`. */
let aberto = null;

function fechar() {
  aberto?.ul.remove();
  aberto = null;
}

function posicionar(ul, select) {
  const r = select.getBoundingClientRect();
  const altura = ul.offsetHeight;
  ul.style.minWidth = `${r.width}px`;
  ul.style.left = `${Math.max(4, r.left)}px`;
  if (r.bottom + altura + 4 > window.innerHeight && r.top > altura + 4) {
    ul.style.top = `${Math.max(4, r.top - altura - 4)}px`;
  } else {
    ul.style.top = `${r.bottom + 4}px`;
  }
}

const visivel = (item) => !item.li.hidden;

function marcarAtivo(novo, passo = 1) {
  if (!aberto) return;
  const { itens } = aberto;
  let i = Math.max(0, Math.min(itens.length - 1, novo));
  // pula o que está dentro de grupo fechado, na direção em que a seta andou
  while (itens[i] && !visivel(itens[i])) i += passo;
  if (!itens[i]) return;
  itens[aberto.ativo]?.li.classList.remove("ativa");
  aberto.ativo = i;
  itens[i].li.classList.add("ativa");
  itens[i].li.scrollIntoView({ block: "nearest" });
}

function alternarGrupo(grupo) {
  if (!aberto) return;
  const aberta = grupo.li.getAttribute("aria-expanded") !== "true";
  grupo.li.setAttribute("aria-expanded", String(aberta));
  for (const li of grupo.filhos) li.hidden = !aberta;
  posicionar(aberto.ul, aberto.select);
  if (aberta) grupo.filhos.at(-1)?.scrollIntoView({ block: "nearest" });
}

function escolher(opt) {
  if (!aberto || !opt || opt.disabled) return;
  aberto.select.value = opt.value;
  aberto.select.dispatchEvent(new Event("change", { bubbles: true }));
  fechar();
}

function confirmar() {
  const item = aberto?.itens[aberto.ativo];
  if (!item) return;
  if (item.grupo) alternarGrupo(item.grupo);
  else escolher(item.opt);
}

function criarOpcao(opt, indice) {
  const li = document.createElement("li");
  li.className = "cb-opt";
  li.setAttribute("role", "option");
  li.textContent = opt.textContent;
  if (opt.title) li.title = opt.title;
  if (opt.selected) li.setAttribute("aria-selected", "true");
  if (opt.disabled) li.classList.add("desabilitada");
  // mousedown, não click: click viria DEPOIS do focus voltar pro select, tarde pra impedir
  // o popup nativo abrir de novo por cima.
  li.addEventListener("mousedown", (e) => {
    e.preventDefault();
    escolher(opt);
  });
  li.addEventListener("mouseenter", () => marcarAtivo(indice()));
  return li;
}

function criarGrupo(optgroup, indice) {
  const li = document.createElement("li");
  li.className = "cb-grupo";
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", "false");
  const rotulo = document.createElement("span");
  rotulo.textContent = optgroup.label;
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("class", "cb-grupo-chevron");
  chevron.setAttribute("viewBox", "0 0 10 6");
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML =
    '<path d="M1 1.5 5 5l4-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';
  li.append(rotulo, chevron);
  li.addEventListener("mouseenter", () => marcarAtivo(indice()));
  return li;
}

function abrir(select) {
  if (select.disabled || select.options.length === 0) return;
  if (aberto?.select === select) return fechar();
  fechar();
  const ul = document.createElement("ul");
  ul.className = "cb-list";
  ul.setAttribute("role", "listbox");
  const itens = [];
  let ativo = 0;
  for (const filho of select.children) {
    if (filho.tagName === "OPTGROUP" && "recolhivel" in filho.dataset) {
      const grupo = { li: null, filhos: [] };
      const pos = itens.length;
      grupo.li = criarGrupo(filho, () => pos);
      grupo.li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        marcarAtivo(pos);
        alternarGrupo(grupo);
      });
      itens.push({ li: grupo.li, grupo });
      ul.append(grupo.li);
      const temEscolhida = [...filho.children].some((o) => o.selected);
      grupo.li.setAttribute("aria-expanded", String(temEscolhida));
      for (const opt of filho.children) {
        const i = itens.length;
        const li = criarOpcao(opt, () => i);
        li.classList.add("cb-opt-sub");
        li.hidden = !temEscolhida;
        if (opt.selected) ativo = i;
        grupo.filhos.push(li);
        itens.push({ li, opt });
        ul.append(li);
      }
      continue;
    }
    // optgroup comum: só achata as opções (comportamento de antes, que ignorava o grupo)
    for (const opt of filho.tagName === "OPTGROUP" ? filho.children : [filho]) {
      const i = itens.length;
      const li = criarOpcao(opt, () => i);
      if (opt.selected) ativo = i;
      itens.push({ li, opt });
      ul.append(li);
    }
  }
  document.body.append(ul);
  aberto = { ul, select, itens, ativo };
  itens[ativo]?.li.classList.add("ativa");
  posicionar(ul, select);
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
      marcarAtivo(aberto.ativo + 1, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      marcarAtivo(aberto.ativo - 1, -1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // → abre e ← fecha o grupo em foco, como numa árvore
      const grupo = aberto.itens[aberto.ativo]?.grupo;
      const expandido = grupo?.li.getAttribute("aria-expanded") === "true";
      if (grupo && expandido === (e.key === "ArrowLeft")) {
        e.preventDefault();
        alternarGrupo(grupo);
      }
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
  // (rolar DENTRO da própria lista — roda do mouse, seta, grupo abrindo — não conta)
  window.addEventListener("scroll", (e) => {
    if (!aberto?.ul.contains(e.target)) fechar();
  }, true);
  document.addEventListener("blur", (e) => {
    if (e.target?.tagName === "SELECT" && aberto?.select === e.target) fechar();
  }, true);
}
