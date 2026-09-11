/**
 * Lógica pura de "ler a página como accessibility tree simplificada" pro modo navegador
 * (`nexo_navegador_ler`) — separada do preload pra ser testável sem Electron/`<webview>` de
 * verdade, mesmo motivo de `inspector-selector.cjs`.
 *
 * CJS, não `.js`/ESM: quem consome isto é `browser-inspector-preload.cjs`, um preload —
 * só enxerga `require`.
 */

/** Interativo o bastante pra valer um `ref`: link, controle de formulário, algo com role/onclick, título. */
const SELETOR_INTERATIVOS = "a[href], button, input, textarea, select, [role], [onclick], h1, h2, h3, h4, h5, h6";

/**
 * Segunda camada, menor prioridade — widget custom SEM role/tag nativa nenhuma (ex.: combobox
 * client-side sem nenhum atributo ARIA, caso relatado: Combobox.tsx do Arquiteto). `tabindex="-1"`
 * é focável só via JS (não é o usuário/leitor de tela que chega nele por Tab), então não conta.
 */
const SELETOR_FOCAVEL = "[tabindex]";

/**
 * Terceira camada, a de menor prioridade — texto solto sem semântica nenhuma (ex.: valor em R$
 * dentro de um `<span>` puro). "Folha de texto" = sem filho ELEMENTO: se tivesse, o texto já
 * pertenceria a um descendente mais específico, e essa entrada duplicaria a leitura.
 */
const SELETOR_TEXTO_SOLTO = "span, div, p, td, li, dd, dt, label";

const MAX_TEXTO = 120;

/**
 * Teto de itens: biblioteca de gráfico (Highcharts, amCharts, etc.) costuma marcar CADA
 * ponto/barra com `role`/`aria-label` pra acessibilidade — isso casa com `[role]` e pode gerar
 * centenas de refs de um gráfico só. Sem teto, a lista vira um texto enorme que estoura limite
 * de tamanho de resposta do cliente MCP bem no meio do gráfico (parece "truncar" ali).
 */
const MAX_ITENS = 300;

function truncar(s, max = MAX_TEXTO) {
  const t = String(s ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Tipos de `<input>` que viram "button" pro papel — o resto (text/email/search/...) é "textbox". */
const INPUT_BOTAO = new Set(["submit", "button", "reset"]);

/** Papel legível — `role` explícito manda; senão deduz da tag/type, como uma accessibility tree real faria. */
function papelDe(el) {
  const roleAttr = el.getAttribute && el.getAttribute("role");
  if (roleAttr) return roleAttr;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const tipo = (el.getAttribute("type") || "text").toLowerCase();
    if (INPUT_BOTAO.has(tipo)) return "button";
    if (tipo === "checkbox") return "checkbox";
    if (tipo === "radio") return "radio";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (el.hasAttribute && el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") {
    return "clicável (sem role — widget custom)";
  }
  return "texto";
}

/** Texto que representa o elemento pro modelo — label explícito > placeholder/valor > texto visível. */
function textoDe(el) {
  const aria = el.getAttribute && el.getAttribute("aria-label");
  if (aria) return truncar(aria);
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    return truncar(el.getAttribute("placeholder") || el.value || "");
  }
  return truncar(el.textContent);
}

/**
 * `display:none`/`visibility:hidden`/tamanho zero não merece `ref` — ninguém consegue clicar
 * nele mesmo, e um ref inútil só confunde o modelo. `win` é injetável pra teste (happy-dom expõe
 * `getComputedStyle` na window do documento).
 */
function estaVisivel(el, win) {
  const janela = win || (el.ownerDocument && el.ownerDocument.defaultView);
  if (!janela || !janela.getComputedStyle) return true;
  const estilo = janela.getComputedStyle(el);
  if (estilo.display === "none" || estilo.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
  return rect.width > 0 && rect.height > 0;
}

function ehFolhaDeTexto(el) {
  return el.children.length === 0 && !!(el.textContent && el.textContent.trim());
}

function tabindexValido(el) {
  return el.getAttribute("tabindex") !== "-1";
}

/**
 * Três camadas, em ordem de prioridade, sem duplicar elemento entre elas — a primeira (semântica
 * nativa/role/onclick/heading) é a que já existia; as duas novas só entram se sobrar espaço no
 * teto (`MAX_ITENS`), pra não afogar elemento realmente interativo com texto solto de baixo valor
 * numa página densa. `truncado` avisa quem chama que a lista não é o total real da página, pra
 * poder dar um aviso legível ao invés de simplesmente cortar em silêncio.
 */
function elementosInterativosComInfo(root, win) {
  const vistos = new Set();

  const principais = Array.from(root.querySelectorAll(SELETOR_INTERATIVOS)).filter((el) => estaVisivel(el, win));
  for (const el of principais) vistos.add(el);

  const focaveisCandidatos = Array.from(root.querySelectorAll(SELETOR_FOCAVEL)).filter(
    (el) => tabindexValido(el) && !vistos.has(el) && estaVisivel(el, win)
  );
  for (const el of focaveisCandidatos) vistos.add(el);

  const textoCandidato = Array.from(root.querySelectorAll(SELETOR_TEXTO_SOLTO)).filter(
    (el) => !vistos.has(el) && ehFolhaDeTexto(el) && estaVisivel(el, win)
  );

  const todos = [...principais, ...focaveisCandidatos, ...textoCandidato];
  return { itens: todos.slice(0, MAX_ITENS), truncado: todos.length > MAX_ITENS };
}

function elementosInterativos(root, win) {
  return elementosInterativosComInfo(root, win).itens;
}

module.exports = {
  SELETOR_INTERATIVOS,
  SELETOR_FOCAVEL,
  SELETOR_TEXTO_SOLTO,
  MAX_ITENS,
  elementosInterativos,
  elementosInterativosComInfo,
  papelDe,
  textoDe,
  estaVisivel,
  truncar,
};
