/**
 * Coleta de referência visual pela página ABERTA no painel Browser — pro "Gerar com IA" do
 * design system. Mesma ideia de extensões tipo "DESIGN.md inspector": em vez de baixar o HTML em
 * texto (que não enxerga site montado por JS nem classe utilitária do Tailwind), lê o estilo
 * COMPUTADO de uma amostra de elementos visíveis da página já renderizada.
 *
 * Aqui só sai dado bruto (contagens); quem interpreta papel de cor, escala e tom é o agente Diretor
 * — heurística fixa de "luminância > .85 = fundo" erra fácil, o modelo vendo o screenshot não.
 *
 * `extrairDaPagina` roda DENTRO da página (via `webview.executeJavaScript`), então não pode usar
 * nada de fora dela: tudo que precisa está no corpo da função.
 */
import { jpegParaBase64 } from "./navegador-host.js";

/* eslint-disable no-undef -- roda no documento da página, não no renderer */
export function extrairDaPagina() {
  const MAX = 300;
  const COTAS = [
    ["h1, h2, h3, h4, h5, h6", 30],
    ["p, li, td, th, blockquote, label", 45],
    ['button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], a[class*="button"]', 30],
    ["input, textarea, select", 20],
    ['nav, header, [role="navigation"], nav a', 25],
    ["a[href]", 25],
    ['[class*="card"], [class*="Card"], article, section, aside', 30],
    ['[class*="badge"], [class*="Badge"], [class*="tag"], [class*="chip"], [class*="pill"]', 15],
    ["table, thead, tr", 10],
    ["pre, code", 10],
    ['footer, [role="contentinfo"]', 10],
  ];
  // aba em segundo plano pode reportar viewport 0: sem piso, nada passaria no filtro
  const alturaTela = innerHeight || document.documentElement.clientHeight || 900;
  const visivel = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    // até 3 telas abaixo: o que está muito longe raramente é o que define a marca
    return r.bottom > -alturaTela && r.top < alturaTela * 3;
  };
  const todos = [...document.body.querySelectorAll("*")].filter(visivel);
  const amostra = new Set();
  for (const [sel, n] of COTAS) {
    let usados = 0;
    for (const el of todos) {
      if (amostra.size >= MAX || usados >= n) break;
      if (!amostra.has(el) && el.matches(sel)) {
        amostra.add(el);
        usados++;
      }
    }
  }
  // completa com o resto em ordem do documento (não aleatório: duas coletas da mesma página dão o mesmo)
  const passo = Math.max(1, Math.floor(todos.length / Math.max(1, MAX - amostra.size)));
  for (let i = 0; i < todos.length && amostra.size < MAX; i += passo) amostra.add(todos[i]);

  // Chromium devolve a cor no espaço em que foi declarada (oklch/lab/color() no Tailwind v4, por
  // ex.), não sempre rgb(). Pintar num canvas 1×1 converte qualquer uma pra sRGB.
  const tela = document.createElement("canvas");
  tela.width = tela.height = 1;
  const ctx = tela.getContext("2d", { willReadFrequently: true });
  const cacheCor = new Map();
  const hex = (c) => {
    if (!c || c === "transparent" || c === "rgba(0, 0, 0, 0)") return null;
    if (cacheCor.has(c)) return cacheCor.get(c);
    let r, g, b, a;
    const m = c.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
    if (m) {
      [r, g, b] = [m[1], m[2], m[3]].map(Number);
      a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    } else if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const px = ctx.getImageData(0, 0, 1, 1).data;
      [r, g, b, a] = [px[0], px[1], px[2], px[3] / 255];
    } else return null;
    const out =
      a < 0.1 ? null : `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}${a < 0.99 ? `@${Math.round(a * 100)}%` : ""}`;
    cacheCor.set(c, out);
    return out;
  };
  const conta = (mapa, chave, peso = 1) => {
    if (chave === null || chave === undefined || chave === "") return;
    mapa.set(chave, (mapa.get(chave) || 0) + peso);
  };
  const cores = { fundo: new Map(), texto: new Map(), borda: new Map() };
  const fontes = new Map();
  const tamanhos = new Map();
  const pesos = new Map();
  const alturas = new Map();
  const raios = new Map();
  const sombras = new Map();
  const espacos = new Map();
  const transicoes = new Map();
  const botoes = [];
  for (const el of amostra) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // área pesa na cor de fundo: o fundo da página importa mais que o de um ícone
    conta(cores.fundo, hex(cs.backgroundColor), Math.max(1, Math.round((r.width * r.height) / 20000)));
    if ((el.textContent || "").trim()) conta(cores.texto, hex(cs.color));
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none") conta(cores.borda, hex(cs.borderTopColor));
    conta(fontes, cs.fontFamily.split(",")[0].trim().replace(/["']/g, ""));
    conta(tamanhos, cs.fontSize);
    conta(pesos, cs.fontWeight);
    if (cs.lineHeight !== "normal") conta(alturas, cs.lineHeight);
    // raio "pílula" (9999px, calc(infinity) → 3.35544e+07px) vira um valor só
    if (cs.borderRadius && cs.borderRadius !== "0px") conta(raios, parseFloat(cs.borderRadius) >= 999 ? "pílula (999px+)" : cs.borderRadius);
    if (cs.boxShadow && cs.boxShadow !== "none") conta(sombras, cs.boxShadow);
    for (const v of [cs.paddingTop, cs.paddingLeft, cs.gap, cs.rowGap]) {
      if (v && v !== "normal" && v !== "0px") conta(espacos, v);
    }
    if (cs.transitionDuration && cs.transitionDuration !== "0s") conta(transicoes, `${cs.transitionDuration} ${cs.transitionTimingFunction}`);
    if (botoes.length < 8 && el.matches('button, [role="button"], a[class*="btn"], a[class*="button"]')) {
      botoes.push({
        texto: (el.textContent || "").trim().slice(0, 40),
        fundo: hex(cs.backgroundColor),
        cor: hex(cs.color),
        raio: cs.borderRadius,
        padding: `${cs.paddingTop} ${cs.paddingRight}`,
        fonte: `${cs.fontWeight} ${cs.fontSize}`,
      });
    }
  }

  // variáveis CSS de :root/html (todas, não só as de cor), com o valor RESOLVIDO
  const vars = new Map();
  const raiz = getComputedStyle(document.documentElement);
  // desce em @layer/@media/@supports: o Tailwind v4 põe o tema inteiro dentro de `@layer theme`
  const varrer = (regras, nivel) => {
    for (const regra of regras || []) {
      if (vars.size >= 600) return;
      if (regra.cssRules && !regra.style && nivel < 4) {
        varrer(regra.cssRules, nivel + 1);
        continue;
      }
      if (!regra.style || !/(^|,\s*)(:root|html|:host)\b/.test(regra.selectorText || "")) continue;
      for (const p of regra.style) {
        if (!p.startsWith("--") || vars.has(p)) continue;
        let v = raiz.getPropertyValue(p).trim().slice(0, 120);
        // cor em lab()/oklch()/color(): vai junto o hex, que é o que o agente usa nos tokens
        if (/^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color)\b|^#/i.test(v)) {
          const h = hex(v);
          if (h && !v.startsWith("#")) v = `${v} (${h})`;
        }
        vars.set(p, v);
      }
    }
  };
  for (const folha of document.styleSheets) {
    try {
      varrer(folha.cssRules, 0);
    } catch {
      /* folha de outra origem sem CORS */
    }
  }

  const texto = (sel, n, max = 60) =>
    [...document.querySelectorAll(sel)]
      .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, max))
      .filter(Boolean)
      .slice(0, n);
  const meta = (nome) => document.querySelector(`meta[name="${nome}"], meta[property="${nome}"]`)?.getAttribute("content") || "";
  const logos = [
    ...[...document.querySelectorAll('img[src*="logo" i], img[alt*="logo" i], header img')].map((i) => i.currentSrc || i.src),
    ...[...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.href),
  ]
    .filter(Boolean)
    .slice(0, 6);
  const topo = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const qtd = (s) => document.querySelectorAll(s).length;

  return {
    url: location.href,
    titulo: document.title,
    descricao: meta("description") || meta("og:description"),
    themeColor: meta("theme-color"),
    amostrados: amostra.size,
    totalElementos: todos.length,
    viewport: `${innerWidth}x${innerHeight}`,
    cores: { fundo: topo(cores.fundo, 12), texto: topo(cores.texto, 10), borda: topo(cores.borda, 8) },
    fontes: topo(fontes, 6),
    tamanhos: topo(tamanhos, 12),
    pesos: topo(pesos, 6),
    alturasDeLinha: topo(alturas, 6),
    raios: topo(raios, 8),
    sombras: topo(sombras, 5),
    espacos: topo(espacos, 14),
    transicoes: topo(transicoes, 4),
    botoes,
    // escala de paleta (red-50…red-950 do Tailwind) vai pro fim: são centenas, e esconderiam
    // as semânticas (--primary, --background…) que dizem mais sobre a marca
    variaveis: [...vars]
      .sort((a, b) => Number(/-(50|[1-9]00|950)$/.test(a[0])) - Number(/-(50|[1-9]00|950)$/.test(b[0])))
      .slice(0, 120),
    titulos: texto("h1, h2, h3", 15),
    navegacao: texto('nav a, [role="navigation"] a', 15, 30),
    logos,
    componentes: {
      botoes: qtd('button, [role="button"]'),
      campos: qtd("input:not([type=hidden]), textarea, select"),
      tabelas: qtd("table"),
      formularios: qtd("form"),
      cards: qtd('[class*="card"], [class*="Card"], article'),
      codigo: qtd("pre, code"),
      imagens: qtd("img, svg, picture"),
    },
    tailwind: qtd('[class*="bg-"], [class*="text-"], [class*="px-"]') > 20,
  };
}
/* eslint-enable no-undef */

const LARGURA_MAX_PRINT = 1280;

/**
 * Coleta + screenshot do `<webview>` visível. O print é JPEG (bem menor que PNG) com largura
 * máxima de 1280px, igual ao `screenshot` do modo navegador.
 */
export async function capturarReferencia(webview) {
  if (!webview || typeof webview.executeJavaScript !== "function") throw new Error("abra uma página no Browser primeiro");
  const dados = await webview.executeJavaScript(`(${extrairDaPagina.toString()})()`);
  let screenshot = null;
  try {
    let imagem = await webview.capturePage();
    if (!imagem.isEmpty()) {
      const { width } = imagem.getSize();
      if (width > LARGURA_MAX_PRINT) imagem = imagem.resize({ width: LARGURA_MAX_PRINT });
      const base64 = jpegParaBase64(imagem.toJPEG(72));
      if (base64) screenshot = { mime: "image/jpeg", data: base64 };
    }
  } catch {
    /* sem print, a coleta ainda serve */
  }
  return { url: dados.url, titulo: dados.titulo, dados, screenshot };
}

/** Linha curta pro formulário: o que foi capturado. */
export function resumoCurto(ref) {
  if (!ref?.dados) return "";
  const d = ref.dados;
  const cores = new Set([...d.cores.fundo, ...d.cores.texto].map(([h]) => h.split("@")[0])).size;
  return `${d.titulo || d.url} · ${cores} cores · ${d.fontes.length} fonte(s) · ${d.variaveis.length} variáveis CSS${ref.screenshot ? " · screenshot" : ""}`;
}
