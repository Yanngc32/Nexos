/**
 * Acessibilidade do app de celular: o que faz elemento não-nativo se comportar como controle.
 *
 * Celular também recebe teclado (bluetooth, varredura, acessibilidade do sistema) e leitor de
 * tela (TalkBack, VoiceOver). Linha de lista com `click` abria no dedo e em mais nada: o teclado
 * não chegava nela e o leitor anunciava "item de lista" sem dizer que abre. Módulo separado de
 * `mobile.js` (que roda na importação) pra ser testável — os testes moram no desktop, igual aos
 * de `pareamento.js`.
 */

/**
 * `li` (ou qualquer elemento) acionável de verdade: `role=button`, entra no Tab, Enter e Espaço
 * acionam. O Espaço rolaria a página por padrão; aqui ele aciona.
 */
export function acionavel(el, aoAcionar) {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.addEventListener("click", aoAcionar);
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    aoAcionar(e);
  });
  return el;
}

/** Cabeçalho que abre e fecha um grupo: o leitor anuncia "recolhido"/"expandido". */
export function marcarExpandido(el, aberto) {
  el.setAttribute("aria-expanded", aberto ? "true" : "false");
  el.dataset.aberto = aberto ? "1" : "0";
}

/**
 * Abas da barra de baixo: só a acesa tem `aria-selected=true` e entra no Tab (as outras ficam em
 * `tabindex=-1` e as setas andam entre elas — o padrão de `tablist`).
 */
export function marcarAbas(lista, acesa) {
  for (const b of lista.querySelectorAll("[role=tab]")) {
    const ligada = b.dataset.aba === acesa;
    b.classList.toggle("on", ligada);
    b.setAttribute("aria-selected", ligada ? "true" : "false");
    b.tabIndex = ligada ? 0 : -1;
  }
}

/** Setas esquerda/direita (e Home/End) entre as abas, com foco e ativação juntos. */
export function ligarSetasDasAbas(lista) {
  lista.addEventListener("keydown", (e) => {
    const abas = [...lista.querySelectorAll("[role=tab]")];
    const i = abas.indexOf(e.target.closest?.("[role=tab]"));
    if (i < 0) return;
    let j = null;
    if (e.key === "ArrowRight") j = (i + 1) % abas.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + abas.length) % abas.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = abas.length - 1;
    if (j === null) return;
    e.preventDefault();
    abas[j].focus();
    abas[j].click();
  });
}

const FOCAVEIS = 'button:not([disabled]):not([hidden]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Folha (bottom sheet) como diálogo: ao abrir guarda quem tinha o foco e leva o foco pra dentro;
 * Esc fecha; Tab não escapa pra página de trás; ao fechar o foco volta pra onde estava. Sem isso
 * o foco ficava na página coberta e o leitor seguia lendo o que não aparece.
 */
export function criarFolha(el, { doc = globalThis.document } = {}) {
  let devolver = null;
  const painel = el.querySelector(".folha-painel") || el;

  function focaveis() {
    return [...painel.querySelectorAll(FOCAVEIS)].filter((n) => !n.closest(".hidden"));
  }

  function abrir() {
    devolver = doc.activeElement;
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
    // o conteúdo da folha costuma chegar depois (lista carregada): foca o painel, que sempre existe
    if (!painel.hasAttribute("tabindex")) painel.tabIndex = -1;
    painel.focus?.();
  }

  function fechar() {
    if (el.classList.contains("hidden")) return;
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    const volta = devolver;
    devolver = null;
    if (volta?.isConnected !== false) volta?.focus?.();
  }

  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      fechar();
      return;
    }
    if (e.key !== "Tab") return;
    const lista = focaveis();
    if (!lista.length) {
      e.preventDefault();
      return;
    }
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    const ativo = doc.activeElement;
    if (e.shiftKey && (ativo === primeiro || ativo === painel)) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && ativo === ultimo) {
      e.preventDefault();
      primeiro.focus();
    }
  });

  for (const f of el.querySelectorAll("[data-fechar]")) f.addEventListener("click", fechar);
  return { abrir, fechar, aberta: () => !el.classList.contains("hidden") };
}
