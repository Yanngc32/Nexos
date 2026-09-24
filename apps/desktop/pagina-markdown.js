/**
 * Página aberta no painel Browser → markdown, pro `nexo_navegador_markdown`. Mesma base do
 * MarkSnip/MarkDownload (Readability + Turndown), com três ajustes que o teste comparativo pediu:
 *
 * 1. bloco de código sempre cercado e com a linguagem (GitHub não põe `<code>` dentro do `<pre>`,
 *    e o Readability apaga as classes de onde a linguagem sai — ela é anotada antes);
 * 2. tabela sem espaço de alinhamento (o preenchimento das colunas é token jogado fora);
 * 3. quando o Readability descarta a maior parte do texto (painel, SPA, lista em `<div>`), vale o
 *    conteúdo principal inteiro, sem menu/cabeçalho/rodapé.
 *
 * `coletarDaPagina` roda DENTRO da página (via `webview.executeJavaScript`) e só serializa o DOM já
 * renderizado. A conversão roda no renderer, com `Readability`/`TurndownService` globais
 * (`<script>` no index.html) — assim a página não recebe biblioteca injetada.
 */

/* eslint-disable no-undef -- roda no documento da página, não no renderer */
export function coletarDaPagina() {
  const copia = document.documentElement.cloneNode(true);
  // os dois a partir do <html>: `document.querySelectorAll` incluiria o próprio <html> e desalinharia
  const vivos = [...document.documentElement.querySelectorAll("*")];
  const copias = [...copia.querySelectorAll("*")];
  // cloneNode preserva a ordem: o i-ésimo da cópia é o i-ésimo da página viva
  for (let i = 0; i < vivos.length && i < copias.length; i++) {
    const v = vivos[i];
    const c = copias[i];
    if (v.nodeName !== c.nodeName) break;
    const cs = getComputedStyle(v);
    if (cs.display === "none" || cs.visibility === "hidden") c.setAttribute("data-nexo-oculto", "");
    // endereço absoluto: a conversão roda fora da página, sem a base dela
    if (v.nodeName === "A" && v.href) c.setAttribute("href", v.href);
    if (v.nodeName === "IMG" && (v.currentSrc || v.src)) c.setAttribute("src", v.currentSrc || v.src);
  }
  for (const el of copia.querySelectorAll("[data-nexo-oculto], script, style, noscript, template, iframe, canvas, svg")) el.remove();
  return { html: copia.outerHTML, url: location.href, titulo: document.title };
}
/* eslint-enable no-undef */

export const MAX_CHARS = 80_000;

/** Abaixo disto (texto do Readability ÷ texto do conteúdo principal), o Readability jogou fora demais. */
const PROPORCAO_MINIMA = 0.4;

const LINGUAGEM_RE = /(?:^|\s)(?:language|lang|highlight-source|brush:?)[-\s]*([a-z0-9+#-]+)/i;
// `sp-javascript` (Sandpack, react.dev) divide o prefixo com `sp-cm`, `sp-pristine`…: só nome conhecido
const SANDPACK_RE = /(?:^|\s)sp-(javascript|typescript|jsx|tsx|js|ts|css|html|json|bash|shell|python|markdown)(?:\s|$)/i;

const FORA_DO_CONTEUDO =
  'nav, aside, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]';
/** Só o `<header>`/`<footer>` da página é cabeçalho/rodapé do site; dentro de seção é o título dela. */
const DE_SECAO = "main, article, section";

function textoDe(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim().length;
}

/**
 * Linguagem DECLARADA do bloco: atributo, classe do `<pre>`, do `<code>` de dentro ou de até 2 pais.
 * Sem declaração, fica sem: o MarkSnip adivinha com highlight.js e rotula HTML do Tailwind de `php`.
 */
function linguagemDo(pre) {
  const candidatos = [pre, pre.querySelector("code"), pre.parentElement, pre.parentElement?.parentElement];
  for (const el of candidatos) {
    if (!el) continue;
    const attr = el.getAttribute("data-language") || el.getAttribute("data-lang");
    if (attr) return attr.toLowerCase();
    const classe = el.getAttribute("class") || "";
    const m = classe.match(LINGUAGEM_RE) || classe.match(SANDPACK_RE);
    if (m) return m[1].toLowerCase();
  }
  return "";
}

/**
 * `<div><h2>Título</h2><a class="anchor"></a></div>` (README do GitHub) vira só o `<h2>`: embrulhado,
 * o Readability descarta o div por ter pouco texto, e o título some junto.
 */
function desembrulharTitulos(doc) {
  for (const div of doc.querySelectorAll("div")) {
    const filhos = [...div.children].filter((c) => !(c.nodeName === "A" && !(c.textContent || "").trim()));
    if (filhos.length === 1 && /^H[1-6]$/.test(filhos[0].nodeName) && (div.textContent || "").trim() === (filhos[0].textContent || "").trim()) {
      div.replaceWith(filhos[0]);
    }
  }
}

function celula(td) {
  const t = (td.textContent || "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  return t.length > 300 ? `${t.slice(0, 297)}…` : t;
}

function criarTurndown(TurndownService) {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  td.remove(["script", "style", "noscript", "template", "iframe", "canvas", "svg"]);
  td.addRule("codigo", {
    filter: "pre",
    replacement(_conteudo, node) {
      const codigo = (node.textContent || "").replace(/\n+$/, "");
      const cerca = codigo.includes("```") ? "````" : "```";
      return `\n\n${cerca}${node.getAttribute("data-nexo-lang") || ""}\n${codigo}\n${cerca}\n\n`;
    },
  });
  td.addRule("tabela", {
    filter: "table",
    replacement(conteudo, node) {
      const linhas = [...node.rows].map((tr) => [...tr.cells].map(celula)).filter((l) => l.some(Boolean));
      const colunas = Math.max(0, ...linhas.map((l) => l.length));
      // tabela de layout (uma coluna): o conteúdo vale como está, com a estrutura de dentro
      if (colunas <= 1) return `\n\n${conteudo}\n\n`;
      const fmt = (l) => `| ${[...l, ...Array(colunas - l.length).fill("")].join(" | ")} |`;
      const [cabeca, ...resto] = linhas;
      return `\n\n${[fmt(cabeca), `|${" --- |".repeat(colunas)}`, ...resto.map(fmt)].join("\n")}\n\n`;
    },
  });
  // âncora de título do GitHub e afins: link sem texto nem imagem é só ruído
  td.addRule("linkVazio", {
    filter: (node) => node.nodeName === "A" && !(node.textContent || "").trim() && !node.querySelector("img"),
    replacement: () => "",
  });
  td.addRule("imagemEmbutida", {
    filter: (node) => node.nodeName === "IMG" && /^data:/i.test(node.getAttribute("src") || ""),
    replacement: (_c, node) => node.getAttribute("alt") || "",
  });
  return td;
}

/**
 * `pagina` = saída de `coletarDaPagina`. `libs` existe pro teste; no app vêm do `window`.
 * Devolve o markdown já com título, endereço e o modo usado (artigo ou conteúdo principal).
 */
export function paginaParaMarkdown(pagina, libs = globalThis) {
  const { Readability, TurndownService, DOMParser } = libs;
  if (!Readability || !TurndownService) throw new Error("Readability/Turndown não carregados");
  // dois parses em vez de clonar o Document: o Readability altera o que recebe
  const parse = () => {
    const doc = new DOMParser().parseFromString(pagina.html || "", "text/html");
    for (const pre of doc.querySelectorAll("pre")) {
      const lang = linguagemDo(pre);
      if (lang) pre.setAttribute("data-nexo-lang", lang);
    }
    desembrulharTitulos(doc);
    return doc;
  };

  const principal = parse();
  for (const el of principal.querySelectorAll(FORA_DO_CONTEUDO)) el.remove();
  for (const el of principal.querySelectorAll("header, footer")) if (!el.parentElement?.closest(DE_SECAO)) el.remove();
  const raiz = principal.querySelector('main, [role="main"]') || principal.body;

  let artigo = null;
  try {
    artigo = new Readability(parse()).parse();
  } catch {
    /* página que o Readability não entende: vai o conteúdo principal */
  }
  const tamArtigo = artigo?.textContent ? artigo.textContent.replace(/\s+/g, " ").trim().length : 0;
  const usarArtigo = tamArtigo > 0 && tamArtigo >= PROPORCAO_MINIMA * textoDe(raiz);

  const td = criarTurndown(TurndownService);
  const corpo = usarArtigo ? td.turndown(artigo.content) : td.turndown(raiz);
  const titulo = (artigo?.title || pagina.titulo || "").trim();
  let md = [
    titulo ? `# ${titulo}` : "",
    `> ${pagina.url || ""} · ${usarArtigo ? "modo artigo (Readability)" : "modo conteúdo principal (sem menu/rodapé)"}`,
    corpo,
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (md.length > MAX_CHARS) md = `${md.slice(0, MAX_CHARS)}\n\n… (cortado: ${MAX_CHARS.toLocaleString("pt-BR")} de ${md.length.toLocaleString("pt-BR")} caracteres)`;
  return md;
}
