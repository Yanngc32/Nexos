/**
 * View "Design System": board estruturado (seções e cards, com pan e zoom) que mostra e edita o
 * design system do projeto. Fala com `/v1/ds*` (`apps/daemon/src/design-system.ts`).
 * Spec: docs/superpowers/specs/2026-09-22-canvas-design-system-design.md (Fase 1: sem IA).
 *
 * Os arquivos do DS são a fonte da verdade: o agente edita direto no disco, o daemon observa a
 * pasta e manda `changed` pelo SSE, e aqui a gente relê e anima SÓ o que mudou (cursor sintético
 * + contorno + entrada do elemento).
 *
 * Cada card roda num `<iframe sandbox="allow-same-origin">` SEM `allow-scripts`: o HTML do card é
 * gerado por LLM e não executa JS, mas o host (este módulo) consegue ler e escrever o documento
 * dele — é o que permite medir altura, trocar variável ao vivo e achar o elemento que mudou.
 *
 * Mesmo idioma de `tarefas-board.js`: dependências por parâmetro, funções puras exportadas pra
 * teste com happy-dom.
 */

import { resumoCurto } from "./ds-extrator.js";
import { rotuloDoElemento } from "./inspector-mensagem.js";

/* ---------------------------------------------------------------------------
 * Funções puras
 * ------------------------------------------------------------------------- */

/** Nomes de variável CSS referenciados via `var(--x)`. */
export function tokensUsados(html) {
  const out = new Set();
  for (const m of String(html || "").matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) out.add(m[1]);
  return out;
}

/**
 * Troca o valor do token em `caminho` ("color.bg", ou "titulo.fontSize" pra campo de composto)
 * numa CÓPIA da árvore DTCG — a árvore de entrada não é tocada.
 */
export function setNoCaminho(tokens, caminho, valor) {
  const raiz = structuredClone(tokens ?? {});
  const partes = String(caminho).split(".");
  let no = raiz;
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i];
    const ultimo = i === partes.length - 1;
    if (no && typeof no === "object" && "$value" in no && !(p in no)) {
      // entrou num composto: o resto do caminho é dentro do $value
      if (typeof no.$value !== "object" || no.$value === null) return raiz;
      no = no.$value;
    }
    if (ultimo) {
      if (no[p] && typeof no[p] === "object" && "$value" in no[p]) no[p].$value = valor;
      else no[p] = valor;
      return raiz;
    }
    if (!no[p] || typeof no[p] !== "object") return raiz;
    no = no[p];
  }
  return raiz;
}

/**
 * Texto digitado no painel → valor DTCG no MESMO formato do original: `{value, unit}` continua
 * objeto, número continua número, lista de fonte continua lista.
 */
export function textoParaBruto(texto, original) {
  const t = String(texto).trim();
  if (original && typeof original === "object" && !Array.isArray(original) && "unit" in original) {
    const m = t.match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
    if (m) return { value: Number(m[1]), unit: m[2] || original.unit };
    return t;
  }
  if (typeof original === "number") {
    const n = Number(t);
    return Number.isFinite(n) && t !== "" ? n : t;
  }
  if (Array.isArray(original) && original.every((v) => typeof v === "string")) {
    return t.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  return t;
}

/** Valor do input de cor (`#rrggbb`), ou `null` se o valor não for um hex simples. */
export function paraHexInput(valor) {
  const v = String(valor || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const m = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  return null;
}

/**
 * Valor DTCG → CSS, pro override ao vivo enquanto o daemon não devolve o CSS oficial. Mesmas
 * regras de `valorCss` (`design-system.ts`) pros formatos que o painel edita.
 */
export function cssDoBruto(bruto) {
  if (bruto && typeof bruto === "object" && !Array.isArray(bruto) && "unit" in bruto) return `${bruto.value}${bruto.unit}`;
  if (Array.isArray(bruto)) return bruto.map((f) => (/^[a-z-]+$/i.test(f) ? f : `"${String(f).replace(/"/g, "")}"`)).join(", ");
  return String(bruto).replace(
    /\{([a-zA-Z0-9_.-]+)\}/g,
    (_m, r) => `var(--${r.split(".").map((p) => p.replace(/[^a-zA-Z0-9-]+/g, "-")).join("-")})`,
  );
}

/**
 * Seletor curto e legível pro agente achar o elemento no HTML do card: `#id`, senão tag + até 2
 * classes, subindo até 3 ancestrais. É contexto, não uma query que precisa ser única.
 */
export function seletorDe(el) {
  const partes = [];
  let atual = el;
  for (let i = 0; atual && atual.nodeType === 1 && i < 4; i++) {
    const tag = atual.tagName.toLowerCase();
    if (tag === "body" || tag === "html") break;
    if (atual.id) {
      partes.unshift(`${tag}#${atual.id}`);
      break;
    }
    const classes = [...atual.classList].filter((c) => !c.startsWith("ds-")).slice(0, 2);
    partes.unshift(classes.length ? `${tag}.${classes.join(".")}` : tag);
    atual = atual.parentElement;
  }
  return partes.join(" > ");
}

/** O que vai pro agente de um elemento apontado: seletor, tag de abertura + um trecho, e o texto. */
export function resumoDoElemento(el) {
  const clone = el.cloneNode(true);
  for (const n of [clone, ...clone.querySelectorAll("*")]) {
    n.removeAttribute("data-ds-hover");
    n.removeAttribute("data-ds-sel");
    n.removeAttribute("data-ds-anim");
  }
  const html = clone.outerHTML.replace(/\s+/g, " ").slice(0, 300);
  const texto = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 150);
  return { seletor: seletorDe(el), html, ...(texto ? { texto } : {}) };
}

export function ehVariante(id) {
  return /-var-\d+$/.test(String(id || ""));
}

/** Zoom em torno de um ponto da tela: o ponto sob o cursor continua sob o cursor. */
export function zoomEm(vista, px, py, fator, min = 0.2, max = 2.5) {
  const escala = Math.min(max, Math.max(min, vista.escala * fator));
  const k = escala / vista.escala;
  return { escala, x: px - (px - vista.x) * k, y: py - (py - vista.y) * k };
}

/** Vista que cabe `larg`×`alt` do board dentro da área `vw`×`vh`, com margem. */
export function ajustarATela(larg, alt, vw, vh, margem = 32) {
  if (!larg || !alt || !vw || !vh) return { escala: 1, x: margem, y: margem };
  const escala = Math.min(1, Math.max(0.2, Math.min((vw - margem * 2) / larg, (vh - margem * 2) / alt)));
  return { escala, x: Math.max(margem, (vw - larg * escala) / 2), y: margem };
}

/** Identidade "rasa" de um elemento: tag + atributos + texto próprio (sem o dos filhos). */
export function digitalDe(el) {
  const attrs = [...el.attributes]
    .filter((a) => a.name !== "style" || !el.hasAttribute("data-ds-anim"))
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join("|");
  let texto = "";
  for (const n of el.childNodes) if (n.nodeType === 3) texto += n.textContent;
  return `${el.tagName}|${attrs}|${texto.replace(/\s+/g, " ").trim()}`;
}

/**
 * Elementos de `raiz` que não existiam antes (por digital, contando repetição). Devolve só os de
 * cima: se o pai já entrou na lista, o filho anima junto com ele.
 */
export function elementosNovos(digitaisAntigos, raiz) {
  const sobra = new Map();
  for (const d of digitaisAntigos) sobra.set(d, (sobra.get(d) || 0) + 1);
  const novos = [];
  for (const el of raiz.querySelectorAll("*")) {
    if (el.tagName === "STYLE" || el.tagName === "SCRIPT") continue;
    const d = digitalDe(el);
    const n = sobra.get(d) || 0;
    if (n > 0) {
      sobra.set(d, n - 1);
      continue;
    }
    if (novos.some((p) => p.contains(el))) continue;
    novos.push(el);
  }
  return novos;
}

export function digitaisDe(raiz) {
  if (!raiz) return [];
  return [...raiz.querySelectorAll("*")].filter((el) => el.tagName !== "STYLE" && el.tagName !== "SCRIPT").map(digitalDe);
}

/** Variáveis cujo valor mudou entre duas leituras (inclui as que surgiram ou sumiram). */
export function varsMudadas(antes, depois) {
  const a = new Map((antes || []).map((v) => [v.nome, v.valor]));
  const b = new Map((depois || []).map((v) => [v.nome, v.valor]));
  const out = new Set();
  for (const [n, v] of b) if (a.get(n) !== v) out.add(n);
  for (const n of a.keys()) if (!b.has(n)) out.add(n);
  return out;
}

/** Temas declarados no CSS gerado (`:root[data-tema="x"]`). */
export function temasDoCss(css) {
  return [...new Set([...String(css || "").matchAll(/:root\[data-tema="([a-z0-9-]+)"\]/gi)].map((m) => m[1]))];
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const CSS_BASE = `html,body{margin:0}
body{padding:20px;box-sizing:border-box;min-height:40px;
  background:var(--color-bg,var(--color-background,var(--bg,transparent)));
  color:var(--color-text,var(--color-fg,var(--text,currentColor)));
  font-family:var(--font-family-body,var(--font-body,system-ui,sans-serif))}
[data-ds-anim]{transition:opacity .28s ease,transform .28s ease}`;

/** Esqueleto do documento do card. O conteúdo entra depois, por `body.innerHTML`. */
export function montarSrcdoc({ css, baseHref, fontes = [], kit = "" }) {
  const base = baseHref ? `<base href="${esc(baseHref)}">` : "";
  // kit = classes prontas do daemon (ds-kit.ts): mesmo visual pros Fundamentos e pros cards criados
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">${base}${linksDeFontes(fontes)}
<style id="ds-tokens">${css || ""}</style><style id="ds-base">${CSS_BASE}</style><style id="ds-kit">${kit}</style><style id="ds-override"></style>
</head><body></body></html>`;
}

const FAMILIAS_DO_SISTEMA = new Set([
  "system-ui", "sans-serif", "serif", "monospace", "cursive", "ui-sans-serif", "ui-serif", "ui-monospace",
  "ui-rounded", "-apple-system", "blinkmacsystemfont", "segoe ui", "segoe ui variable text", "helvetica",
  "helvetica neue", "arial", "consolas", "menlo", "monaco", "courier new", "sfmono-regular", "inherit",
]);

/**
 * URLs do Google Fonts pras famílias dos tokens de fonte (a primeira de cada lista, se não for do
 * sistema). UMA por família, na API v1: a css2 com pesos fixos derruba o pedido inteiro se uma
 * família não tiver um dos pesos, e família que não existe no Google derrubaria as outras junto.
 */
export function urlsDeFontes(vars) {
  const familias = new Set();
  for (const v of vars || []) {
    if (v.tipo !== "fontFamily" && !/family/i.test(v.caminho)) continue;
    const primeira = String(v.valor).split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (!primeira || primeira.startsWith("var(") || FAMILIAS_DO_SISTEMA.has(primeira.toLowerCase())) continue;
    familias.add(primeira);
  }
  return [...familias]
    .sort()
    .map((f) => `https://fonts.googleapis.com/css?family=${encodeURIComponent(f).replace(/%20/g, "+")}:400,500,600,700&display=swap`);
}

function linksDeFontes(urls) {
  return urls.map((u) => `<link rel="stylesheet" data-ds-fonte href="${esc(u)}">`).join("");
}

/**
 * Card que acabou de nascer: o que animar pra ele "se desenhar". Ordem do documento (pai antes do
 * filho), até `max` elementos — se passar, corta a profundidade até caber.
 */
export function elementosParaConstruir(raiz, max = 40) {
  const todos = [];
  const andar = (el, nivel) => {
    for (const filho of el.children) {
      if (filho.tagName === "STYLE" || filho.tagName === "SCRIPT" || filho.tagName === "LINK") continue;
      todos.push({ el: filho, nivel });
      andar(filho, nivel + 1);
    }
  };
  andar(raiz, 1);
  for (let prof = 4; prof >= 1; prof--) {
    const sel = todos.filter((t) => t.nivel <= prof);
    if (sel.length <= max || prof === 1) return sel.slice(0, max).map((t) => t.el);
  }
  return [];
}

/** Cards do plano da geração que ainda não existem em disco: viram esqueleto no board. */
export function cardsPendentes(geracao, cardsEmDisco) {
  if (!geracao || geracao.status !== "rodando") return [];
  const existentes = new Set((cardsEmDisco || []).map((c) => c.id));
  const etapaDe = new Map();
  for (const e of geracao.etapas || []) for (const id of e.cards || []) etapaDe.set(id, e);
  return (geracao.plano || [])
    .filter((c) => !existentes.has(c.id))
    .map((c) => ({ ...c, html: "", lint: [], pendente: true, etapaStatus: etapaDe.get(c.id)?.status || "pendente" }));
}

/**
 * `file:///C:/…/projeto/` — base pra imagem relativa do card. É a RAIZ DO PROJETO (repo), não a
 * pasta do DS: o logo real do projeto entra como `public/logo.svg`, não importa onde o DS mora.
 */
export function baseHrefDoProjeto(projetoAbs) {
  if (!projetoAbs) return "";
  const p = String(projetoAbs).replace(/\\/g, "/").replace(/\/+$/, "");
  const comBarra = p.startsWith("/") ? p : `/${p}`;
  return `file://${encodeURI(comBarra)}/`;
}

/** Largura útil do card no board (grade de 6 colunas em 1560px) pela largura do meta. */
const LARGURA_PX = { "1/3": 500, "1/2": 764, "2/3": 1028, 1: 1560 };

/**
 * Documento completo de UM card pro print do agente (`nexo_ds_print`): o mesmo do Canvas
 * (tokens, kit, fontes, base do projeto) com o HTML já no body, tema aplicado e CSP sem script —
 * a janela invisível do Electron renderiza exatamente o que a pessoa vê. `null` = card não existe.
 */
export function documentoDoPrint(ds, cardId, tema = "") {
  const card = [...(ds.fundamentos || []), ...(ds.cards || [])].find((c) => c.id === cardId);
  if (!card) return null;
  let html = montarSrcdoc({ css: ds.css, baseHref: baseHrefDoProjeto(ds.projetoAbs), fontes: urlsDeFontes(ds.vars), kit: ds.kitCss || "" });
  html = html.replace(
    '<meta charset="utf-8">',
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'">`,
  );
  if (tema && /^[a-z0-9-]+$/i.test(tema)) html = html.replace('<html lang="pt-BR">', `<html lang="pt-BR" data-tema="${tema}">`);
  html = html.replace("<body></body>", `<body>${card.html}</body>`);
  return { html, largura: LARGURA_PX[card.largura || "1/2"] || 764, titulo: card.titulo };
}

/* ---------------------------------------------------------------------------
 * Componente
 * ------------------------------------------------------------------------- */

const LS_ANIM = "nexo.ds.animacao";

export function createDsCanvas({
  req,
  api,
  headers,
  el,
  getProjectPath,
  isOk = () => true,
  lerEventos,
  avisar = (msg) => Promise.resolve(window.alert(msg)),
  confirmar = (msg) => Promise.resolve(window.confirm(msg)),
  fetchImpl = (...a) => fetch(...a),
  /** Contas pro formulário de geração, e a selecionada no app (vira a padrão). */
  getProfiles = () => [],
  getProfileId = () => "",
  aoAbrirConversa = () => {},
  /** Põe um pedido pronto no campo do chat (sem mandar): "corrigir cores soltas" da conformidade. */
  aoPedirNoChat = () => {},
  /** Cita um card no campo do chat (acrescenta, sem mandar). */
  aoMencionarNoChat = () => {},
  /** Manda pro chat um pedido com elementos apontados nos cards (mesmo formato do inspector do Browser). */
  aoMandarNoChat = () => {},
  doc = document,
  win = window,
}) {
  /** Estado do daemon (`GET /v1/ds`). */
  let estado = { sistemas: [], ativo: null, ds: null };
  let vista = { escala: 1, x: 32, y: 32 };
  let ajustouUmaVez = false;
  let tema = "";
  /** Overrides locais de variável (edição ainda não salva): nome → valor CSS. */
  const overrides = new Map();
  /** Card (id) aberto no painel de edição, ou null. */
  let editando = null;
  /** Geração por IA em curso (ou a última), como o daemon manda. */
  let geracao = null;
  /** Plano do daemon (`/v1/ds/gerar/plano`), pra montar o formulário. */
  let planoSecoes = null;
  let painelModo = "tokens"; // "feedback" | "tokens" | "controles" | "versoes" | "avisos"
  /** Feedback em curso: card e elementos apontados nele (seleção dentro do iframe). */
  let selecao = null;
  /** Seleção pro chat, em QUALQUER card: `{ itens: [{ card, el, seletor, html, texto? }] }`; null = desligada. */
  let mira = null;
  /** Valores dos Controles ainda não aplicados: var → valor. */
  const valoresControle = new Map();
  let salvarTimer = 0;
  /** Hash dos tokens que NÓS acabamos de salvar — a volta pelo observador não pulsa card. */
  let hashSalvoPorMim = "";
  let sse = null;
  let recarregarTimer = 0;
  let carregando = false;
  let projetoCarregado = "";
  /** id → { frame, cartao, hash, html } */
  const frames = new Map();
  let fila = [];
  let animando = false;

  const qs = () => `projectPath=${encodeURIComponent(getProjectPath())}`;

  function animacaoLigada() {
    try {
      if (win.localStorage?.getItem(LS_ANIM) === "0") return false;
    } catch {
      /* sem storage */
    }
    return !win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  /* ---------- carregar ---------- */

  async function abrir() {
    ligarUmaVez();
    const projeto = getProjectPath();
    if (projeto !== projetoCarregado) {
      projetoCarregado = projeto;
      ajustouUmaVez = false;
      editando = null;
      overrides.clear();
      limparFrames();
    }
    await recarregar({ animar: false });
    try {
      geracao = (await req(`/v1/ds/gerar?${qs()}`)).geracao;
    } catch {
      geracao = null;
    }
    pintarProgresso();
    if (geracao?.status === "rodando" && estado.ds) pintar();
    ouvir();
  }

  async function recarregar({ animar = true } = {}) {
    if (!getProjectPath()) {
      estado = { sistemas: [], ativo: null, ds: null };
      pintar();
      return;
    }
    if (carregando) {
      // uma releitura por vez; a que chegou no meio vira a próxima
      clearTimeout(recarregarTimer);
      recarregarTimer = setTimeout(() => void recarregar({ animar }), 150);
      return;
    }
    carregando = true;
    const anterior = estado.ds;
    try {
      estado = await req(`/v1/ds?${qs()}`);
      erroTopo("");
    } catch (e) {
      erroTopo(e.message);
    } finally {
      carregando = false;
    }
    pintar({ anterior, animar });
  }

  async function trocarPraDsDoDisco() {
    try {
      estado = await req(`/v1/ds?${qs()}`);
    } catch (e) {
      erroTopo(e.message);
      return;
    }
    ajustouUmaVez = false;
    fecharPainel();
    limparFrames();
    pintar();
    ouvir();
  }

  function aplicarDs(ds, { animar = false } = {}) {
    const anterior = estado.ds;
    estado = { ...estado, ds };
    pintar({ anterior, animar });
  }

  /* ---------- SSE ---------- */

  function ouvir() {
    sse?.abort();
    sse = null;
    if (!estado.ds || !isOk() || !getProjectPath()) return;
    const ac = new AbortController();
    sse = ac;
    const projeto = getProjectPath();
    const ativo = estado.ativo;
    fetchImpl(api(`/v1/ds/events?${qs()}`), { headers: headers(), signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) return;
        await lerEventos(res, (ev) => {
          if (ev.type === "geracao") {
            aplicarGeracao(ev.geracao);
            return;
          }
          if (ev.type === "ds_stream") {
            void receberStream(ev);
            return;
          }
          // o agente criou/ativou outro DS (nexo_ds_criar/ativar): troca a tela e passa a vigiar a pasta dele
          if (ev.type === "ds_ativo") {
            if (ev.ativo !== estado.ativo) void trocarPraDsDoDisco();
            return;
          }
          if (ev.type !== "changed") return;
          clearTimeout(recarregarTimer);
          recarregarTimer = setTimeout(() => void recarregar({ animar: true }), 120);
        });
        religar();
      })
      .catch(() => religar());

    function religar() {
      // fim limpo do stream = daemon reiniciando; mesmo cuidado de services.js
      if (sse !== ac || getProjectPath() !== projeto || estado.ativo !== ativo) return;
      setTimeout(() => {
        if (sse !== ac || !isOk()) return;
        void recarregar({ animar: true }).then(ouvir);
      }, 1500);
    }
  }

  function parar() {
    sse?.abort();
    sse = null;
  }

  /* ---------- pintura ---------- */

  function erroTopo(msg) {
    const p = el("ds-erro");
    if (!p) return;
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function pintar({ anterior = null, animar = false } = {}) {
    const ds = estado.ds;
    const vazio = el("ds-vazio");
    const viewport = el("ds-viewport");
    el("ds-sem-projeto")?.classList.toggle("hidden", !!getProjectPath());
    const mostrarVazio = !!getProjectPath() && !ds;
    if (mostrarVazio && vazio.classList.contains("hidden")) void carregarBases("ds-vazio-base");
    vazio.classList.toggle("hidden", !mostrarVazio);
    viewport.classList.toggle("hidden", !ds);
    pintarCabecalho();
    if (!ds) {
      limparFrames();
      fecharPainel();
      return;
    }
    const mudadas = anterior && ds.tokensHash !== hashSalvoPorMim ? varsMudadas(anterior.vars, ds.vars) : new Set();
    if (ds.tokensHash === hashSalvoPorMim) hashSalvoPorMim = "";
    // salvou → o que está em disco já tem os overrides; local não precisa mais
    if (anterior && anterior.tokensHash !== ds.tokensHash) {
      // o que ainda não foi gravado continua valendo por cima do que veio do disco
      for (const v of anterior.vars) if (!pendentes.has(v.caminho)) overrides.delete(v.nome);
    }
    pintarBoard(ds, { animar: animar && animacaoLigada(), mudadas });
    // DS do zero (ou tudo apagado): diz por onde começar em vez de mostrar um board em branco
    el("ds-quadro-vazio")?.classList.toggle("hidden", cardsDoBoard(ds).length > 0);
    // ferramenta (conformidade etc.) não refaz a varredura a cada recarga do board
    if (editando && editando !== FERRAMENTA) pintarPainel();
    if (!ajustouUmaVez) {
      ajustouUmaVez = true;
      requestAnimationFrame(() => ajustar());
    }
  }

  function pintarCabecalho() {
    const sel = el("ds-sistema");
    sel.innerHTML = "";
    for (const s of estado.sistemas) {
      const o = doc.createElement("option");
      o.value = s.id;
      o.textContent = s.nome;
      o.selected = s.id === estado.ativo;
      sel.append(o);
    }
    sel.classList.toggle("hidden", estado.sistemas.length < 2);
    const ds = estado.ds;
    // sem DS não há o que ajustar: só o título e o fechar
    el("ds-toolbar").classList.toggle("hidden", !ds);
    el("ds-pasta").classList.toggle("hidden", !ds);
    el("ds-nome").textContent = ds ? ds.nome : "";
    // caminho completo no hover; na pílula só o fim, que é o que distingue um DS do outro
    el("ds-pasta").textContent = ds ? ds.pastaAbs.replace(/\\/g, "/").split("/").slice(-2).join("/") : "";
    el("ds-pasta").title = ds ? ds.pastaAbs : "";
    const temas = ds ? temasDoCss(ds.css) : [];
    const tsel = el("ds-tema");
    tsel.innerHTML = "";
    for (const t of ["", ...temas]) {
      const o = doc.createElement("option");
      o.value = t;
      o.textContent = t ? `Tema: ${t}` : "Tema: padrão";
      o.selected = t === tema;
      tsel.append(o);
    }
    tsel.classList.toggle("hidden", temas.length === 0);
    if (!temas.includes(tema)) tema = "";
    el("ds-anim").setAttribute("aria-pressed", animacaoLigada() ? "true" : "false");
    el("ds-zoom-val").textContent = `${Math.round(vista.escala * 100)}%`;
    const avisos = ds ? ds.tokensLint.length + ds.cards.reduce((n, c) => n + c.lint.length, 0) : 0;
    const b = el("ds-avisos");
    b.textContent = avisos ? `${avisos} aviso${avisos > 1 ? "s" : ""}` : "";
    b.classList.toggle("hidden", !avisos);
  }

  /** Todos os cards na ordem do board: Fundamentos (gerados), DESIGN.md e os de arquivo. */
  function cardsDoBoard(ds) {
    const fund = (ds.fundamentos || []).filter((c) => !c.oculto).map((c) => ({ ...c, gerado: true, lint: [] }));
    // esqueleto dos cards previstos entra na posição do plano, dentro da seção dele
    const pendentes = cardsPendentes(geracao, ds.cards);
    return [...fund, ...ds.cards, ...pendentes];
  }

  function secoesDoBoard(ds) {
    // "fundamentos" sempre primeiro; entrada dela em `secoes` (título/alinhamento) vale se existir
    const fund = ds.secoes.find((s) => s.id === "fundamentos");
    return [{ id: "fundamentos", titulo: "Fundamentos", ...fund }, ...ds.secoes.filter((s) => s.id !== "fundamentos")];
  }

  function pintarBoard(ds, { animar, mudadas }) {
    const board = el("ds-board");
    const cards = cardsDoBoard(ds);
    const vivos = new Set(cards.map((c) => c.id));
    for (const [id, f] of frames) {
      if (!vivos.has(id)) {
        f.cartao.remove();
        frames.delete(id);
      }
    }

    // seções: recria só a casca que falta; os cartões são movidos, não recriados (iframe recriado
    // pisca e perde a animação)
    // Mover um <iframe> no DOM RECARREGA ele (perde o conteúdo e a medida). Por isso a ordem só é
    // corrigida quando está errada, e quem foi movido volta ao estado de "card novo".
    const usadas = new Set(cards.map((c) => c.secao));
    const secoes = secoesDoBoard(ds).filter((s) => usadas.has(s.id));
    const ordemNova = secoes.map((s) => s.id);
    const ordemAtual = [...board.querySelectorAll(":scope > .ds-secao")].map((b) => b.dataset.secao);
    const mantidasAtual = ordemAtual.filter((id) => ordemNova.includes(id));
    const mantidasNova = ordemNova.filter((id) => ordemAtual.includes(id));
    // seção existente trocou de lugar: mais simples (e raro) remontar tudo
    if (mantidasAtual.join("|") !== mantidasNova.join("|")) limparFrames();
    const blocos = new Map([...board.querySelectorAll(":scope > .ds-secao")].map((b) => [b.dataset.secao, b]));
    for (const [id, b] of blocos) {
      if (ordemNova.includes(id)) continue;
      for (const fr of b.querySelectorAll(".ds-card")) frames.delete(fr.dataset.card);
      b.remove();
      blocos.delete(id);
    }
    let anteriorEl = null;
    for (const s of secoes) {
      let bloco = blocos.get(s.id);
      if (!bloco) {
        bloco = doc.createElement("section");
        bloco.className = "ds-secao";
        bloco.dataset.secao = s.id;
        bloco.innerHTML = `<h2 class="ds-secao-titulo"></h2><div class="ds-secao-grade"></div>`;
        board.insertBefore(bloco, anteriorEl ? anteriorEl.nextSibling : board.firstChild);
      }
      bloco.querySelector(".ds-secao-titulo").textContent = s.titulo;
      bloco.querySelector(".ds-secao-grade").dataset.alinhamento = s.alinhamento || "topo";
      anteriorEl = bloco;
    }
    pintarNav(secoes);

    const grades = new Map([...board.querySelectorAll(".ds-secao")].map((b) => [b.dataset.secao, b.querySelector(".ds-secao-grade")]));
    const anteriorNaGrade = new Map();
    for (const card of cards) {
      const grade = grades.get(card.secao);
      if (!grade) continue;
      let f = frames.get(card.id);
      if (!f) {
        f = criarCartao(card);
        frames.set(card.id, f);
      }
      const antes = anteriorNaGrade.get(grade) ?? null;
      const lugarCerto = f.cartao.parentNode === grade && (antes ? antes.nextSibling === f.cartao : grade.firstChild === f.cartao);
      if (!lugarCerto) {
        const jaEstavaNoDom = f.cartao.isConnected;
        grade.insertBefore(f.cartao, antes ? antes.nextSibling : grade.firstChild);
        if (jaEstavaNoDom) reiniciarFrame(f);
      }
      anteriorNaGrade.set(grade, f.cartao);
      f.cartao.dataset.largura = card.largura || "1/2";
      void atualizarCartao(f, card, ds, { animar, mudadas });
      ajustarAlvenaria(f);
    }
  }

  /*
   * Alinhamento "alvenaria": grade de linhas de 8px e cada card ocupa as linhas da própria altura —
   * empilha em colunas sem o buraco que a linha mais alta deixa no modo "topo". Refeito sempre que
   * a altura do card muda (medir) ou a seção troca de alinhamento.
   */
  const LINHA_ALVENARIA = 8;
  function ajustarAlvenaria(f) {
    const grade = f.cartao.parentNode;
    if (!grade || grade.dataset?.alinhamento !== "alvenaria") {
      if (f.cartao.style.gridRowEnd) f.cartao.style.gridRowEnd = "";
      return;
    }
    const gap = parseFloat(win.getComputedStyle(grade).columnGap) || 0;
    const span = Math.max(1, Math.ceil((f.cartao.offsetHeight + gap) / LINHA_ALVENARIA));
    const valor = `span ${span}`;
    if (f.cartao.style.gridRowEnd !== valor) f.cartao.style.gridRowEnd = valor;
  }

  /* ---------- navegação lateral pelas seções ---------- */

  function pintarNav(secoes) {
    const nav = el("ds-nav");
    if (!nav) return;
    const atual = [...nav.querySelectorAll("button")].map((b) => `${b.dataset.secao}:${b.textContent}`).join("|");
    const nova = secoes.map((s) => `${s.id}:${s.titulo}`).join("|");
    if (atual === nova) return;
    nav.replaceChildren();
    for (const s of secoes) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "ds-nav-item";
      b.dataset.secao = s.id;
      b.textContent = s.titulo;
      b.title = `Ir pra ${s.titulo}`;
      b.addEventListener("click", () => irParaSecao(s.id));
      nav.append(b);
    }
  }

  /** Leva a seção pro topo do viewport, mantendo o zoom (com transição curta). */
  function irParaSecao(id) {
    const bloco = el("ds-board").querySelector(`:scope > .ds-secao[data-secao="${CSS.escape(id)}"]`);
    if (!bloco) return;
    const board = el("ds-board");
    board.classList.add("suave");
    vista = { ...vista, x: 32, y: 32 - bloco.offsetTop * vista.escala };
    aplicarVista();
    win.setTimeout(() => board.classList.remove("suave"), 320);
    for (const b of el("ds-nav").querySelectorAll("button")) b.dataset.on = b.dataset.secao === id ? "1" : "0";
  }

  function reiniciarFrame(f) {
    f.ro?.disconnect?.();
    f.pronto = null;
    f.html = "";
    f.css = "";
    f.hash = null;
  }

  function criarCartao(card) {
    const cartao = doc.createElement("article");
    cartao.className = "ds-card";
    cartao.dataset.card = card.id;
    cartao.innerHTML = `<header class="ds-card-head">
        <div class="ds-card-tit"><h3></h3><p></p></div>
        <button type="button" class="ds-card-lint hidden" title="Avisos do lint"></button>
        <span class="ds-card-variante hidden">
          <button type="button" class="primary ds-var-usar" title="Esta variante substitui o card original">Usar esta</button>
          <button type="button" class="ghost ds-var-descartar">Descartar</button>
        </span>
        <button type="button" class="ghost ds-card-chat" title="Mencionar este card no chat">@ Chat</button>
        <button type="button" class="ghost ds-card-feedback">Feedback</button>
        <button type="button" class="ghost ds-card-edit">Editar</button>
      </header>
      <div class="ds-card-corpo"><iframe class="ds-card-frame" sandbox="allow-same-origin" tabindex="-1"></iframe></div>`;
    const frame = cartao.querySelector("iframe");
    cartao.querySelector(".ds-card-edit").addEventListener("click", () => abrirPainel(card.id, "tokens"));
    cartao.querySelector(".ds-card-feedback").addEventListener("click", () => abrirPainel(card.id, "feedback"));
    cartao.querySelector(".ds-card-chat").addEventListener("click", () => {
      aoMencionarNoChat(referenciaDoCard(frames.get(card.id)?.card || card));
    });
    cartao.querySelector(".ds-var-usar").addEventListener("click", () => void acaoDeVariante(card.id, "usar"));
    cartao.querySelector(".ds-var-descartar").addEventListener("click", () => void acaoDeVariante(card.id, "descartar"));
    cartao.querySelector(".ds-card-lint").addEventListener("click", () => abrirPainel(card.id, "avisos"));
    return { cartao, frame, hash: null, html: "", pronto: null, css: "" };
  }

  /** Garante o documento base no iframe; resolve quando dá pra escrever nele. */
  function prepararFrame(f, ds) {
    const base = baseHrefDoProjeto(ds.projetoAbs);
    if (f.pronto && f.base === base) return f.pronto;
    f.base = base;
    f.pronto = new Promise((resolve) => {
      const pronto = () => {
        const d = f.frame.contentDocument;
        if (!d || !d.getElementById("ds-tokens")) return;
        f.frame.removeEventListener("load", pronto);
        ligarFrame(f);
        resolve();
      };
      f.frame.addEventListener("load", pronto);
      const fontes = urlsDeFontes(ds.vars);
      f.fontes = fontes.join("|");
      f.frame.srcdoc = montarSrcdoc({ css: ds.css, baseHref: base, fontes, kit: ds.kitCss || "" });
    });
    return f.pronto;
  }

  /** Eventos do documento do card que o board precisa: roda do mouse (pan/zoom) e altura. */
  function ligarFrame(f) {
    const d = f.frame.contentDocument;
    // Feedback: com a seleção ligada NESTE card, passar o mouse marca e clicar aponta/desaponta
    // Mira (seleção pro chat) vale em todos os cards ao mesmo tempo
    const selecionando = () => !!mira || (selecao && selecao.card === f.card?.id);
    if (mira) injetarMarcas(d);
    d.addEventListener("mouseover", (e) => {
      if (!selecionando() || e.target.nodeType !== 1 || e.target === d.body) return;
      d.querySelectorAll("[data-ds-hover]").forEach((n) => n.removeAttribute("data-ds-hover"));
      e.target.setAttribute("data-ds-hover", "");
    });
    d.addEventListener("mouseout", (e) => {
      if (e.target.nodeType === 1) e.target.removeAttribute("data-ds-hover");
    });
    d.addEventListener(
      "click",
      (e) => {
        if (!selecionando()) return;
        e.preventDefault();
        e.stopPropagation();
        const alvo = e.target;
        if (alvo.nodeType !== 1 || alvo === d.body) return;
        if (mira) return alternarNaMira(f.card?.id, alvo);
        if (alvo.hasAttribute("data-ds-sel")) {
          alvo.removeAttribute("data-ds-sel");
          selecao.itens = selecao.itens.filter((i) => i.el !== alvo);
        } else {
          alvo.setAttribute("data-ds-sel", String(selecao.itens.length + 1));
          selecao.itens.push({ el: alvo, ...resumoDoElemento(alvo) });
        }
        numerarSelecao(d);
        if (painelModo === "feedback") pintarListaSelecao();
      },
      true,
    );
    d.addEventListener(
      "wheel",
      (e) => {
        const r = f.frame.getBoundingClientRect();
        const k = f.frame.offsetWidth ? r.width / f.frame.offsetWidth : 1;
        e.preventDefault();
        aoRodar({ clientX: r.left + e.clientX * k, clientY: r.top + e.clientY * k, deltaX: e.deltaX, deltaY: e.deltaY, ctrlKey: e.ctrlKey || e.metaKey });
      },
      { passive: false },
    );
    d.addEventListener("mousedown", (e) => {
      if (e.button === 1 || espacoApertado) {
        e.preventDefault();
        const r = f.frame.getBoundingClientRect();
        const k = f.frame.offsetWidth ? r.width / f.frame.offsetWidth : 1;
        comecarArrasto(r.left + e.clientX * k, r.top + e.clientY * k);
      }
    });
    try {
      const ro = new win.ResizeObserver(() => medir(f));
      ro.observe(d.body);
      f.ro = ro;
    } catch {
      /* sem ResizeObserver cruzando documento: mede nos pontos fixos */
    }
    d.fonts?.ready?.then(() => medir(f)).catch(() => {});
  }

  function medir(f) {
    const d = f.frame.contentDocument;
    if (!d?.body) return;
    // body, não documentElement: o scrollHeight do <html> nunca fica menor que o próprio iframe,
    // e o card não encolheria quando o conteúdo diminui
    const alt = Math.max(40, Math.ceil(d.body.getBoundingClientRect().height));
    if (f.frame.style.height !== `${alt}px`) f.frame.style.height = `${alt}px`;
    ajustarAlvenaria(f);
  }

  function aplicarVarsNoFrame(f, ds) {
    const d = f.frame.contentDocument;
    if (!d) return;
    const t = d.getElementById("ds-tokens");
    if (t && f.css !== ds.css) {
      t.textContent = ds.css;
      f.css = ds.css;
    }
    const o = d.getElementById("ds-override");
    if (o) o.textContent = overrides.size ? `:root{${[...overrides].map(([n, v]) => `${n}:${v}`).join(";")}}` : "";
    const fontes = urlsDeFontes(ds.vars);
    if (f.fontes !== fontes.join("|")) {
      f.fontes = fontes.join("|");
      for (const l of d.querySelectorAll("link[data-ds-fonte]")) l.remove();
      d.head.insertAdjacentHTML("afterbegin", linksDeFontes(fontes));
    }
    if (tema) d.documentElement.dataset.tema = tema;
    else delete d.documentElement.dataset.tema;
  }

  async function atualizarCartao(f, card, ds, { animar, mudadas }) {
    f.card = card;
    f.cartao.querySelector("h3").textContent = card.titulo;
    f.cartao.querySelector("p").textContent = card.subtitulo || "";
    const lint = f.cartao.querySelector(".ds-card-lint");
    lint.textContent = card.lint.length ? `${card.lint.length} ⚠` : "";
    lint.classList.toggle("hidden", !card.lint.length);
    f.cartao.classList.toggle("tem-aviso", card.lint.length > 0);
    f.cartao.classList.toggle("editando", editando === card.id);
    f.cartao.classList.toggle("pendente", !!card.pendente);
    f.cartao.dataset.etapa = card.pendente ? card.etapaStatus : "";
    f.cartao.querySelector(".ds-card-edit").classList.toggle("hidden", !!card.pendente);
    f.cartao.querySelector(".ds-card-chat").classList.toggle("hidden", !!card.pendente);
    // Fundamentos saem dos tokens: feedback neles é feedback nos tokens (aba Tokens)
    f.cartao.querySelector(".ds-card-feedback").classList.toggle("hidden", !!card.pendente || !!card.gerado);
    f.cartao.querySelector(".ds-card-variante").classList.toggle("hidden", !ehVariante(card.id) || !!card.pendente);
    f.cartao.classList.toggle("variante", ehVariante(card.id));

    await prepararFrame(f, ds);
    aplicarVarsNoFrame(f, ds);
    const d = f.frame.contentDocument;
    const body = d?.body;
    if (!body) return;

    const html = card.html;
    // card que chegou ao vivo: o que está no iframe JÁ é esse HTML (escrito pedaço por pedaço) e
    // já foi animado — só normaliza pro arquivo final, sem desenhar de novo
    if (f.streaming) {
      // recarga no meio do stream (outro card foi salvo) traz o HTML ANTIGO deste do disco:
      // não pode cortar o que está sendo escrito. Só o arquivo novo encerra.
      if (!html || html === f.htmlOrigem) return;
      encerrarStream(f);
      f.frame.contentDocument.body.innerHTML = html;
      f.html = html;
      f.hash = card.hash ?? html;
      medir(f);
      return;
    }
    if (f.html !== html) {
      const primeira = f.hash === null;
      const antigos = primeira ? [] : digitaisDe(body);
      body.innerHTML = html;
      f.html = html;
      f.hash = card.hash ?? html;
      if (mira) pintarMira();
      medir(f);
      setTimeout(() => medir(f), 60);
      // card que acabou de nascer (geração) se desenha inteiro; card que mudou anima só a diferença
      if (animar && html) enfileirar(f, primeira ? elementosParaConstruir(body) : elementosNovos(antigos, body));
    } else if (animar && mudadas.size && [...tokensUsados(html)].some((n) => mudadas.has(n))) {
      pulsar(f);
    }
  }

  /* ---------- streaming real (Fase 3) ---------- */

  /**
   * HTML do card chegando enquanto o agente escreve (`ds_stream` do daemon). `document.write` num
   * documento aberto é o parser incremental do próprio navegador: HTML pela metade renderiza
   * certo, sem parser nosso. Cada elemento que o parser cria passa pelo `MutationObserver` e
   * entra na fila de animação (cursor + contorno + entrada) na hora em que nasce.
   */
  async function receberStream(ev) {
    const f = frames.get(ev.card);
    if (!f || !estado.ds) return; // card fora do board: o arquivo final chega pelo observador
    if (ev.fase === "abriu") {
      await iniciarStream(f);
      return;
    }
    if (ev.fase !== "pedaco" || !ev.html) return;
    if (!f.streaming) await iniciarStream(f);
    if (f.filaStream) {
      f.filaStream.push(ev.html); // documento ainda abrindo
      return;
    }
    escreverStream(f, ev.html);
  }

  async function iniciarStream(f) {
    if (f.streaming) return;
    f.streaming = true;
    f.filaStream = [];
    f.htmlOrigem = f.html;
    f.ro?.disconnect?.();
    const ds = estado.ds;
    await prepararFrame(f, ds);
    const d = f.frame.contentDocument;
    if (!d || !f.streaming) return;
    f.cartao.classList.add("desenhando");
    const fontes = urlsDeFontes(ds.vars);
    d.open();
    d.write(montarSrcdoc({ css: ds.css, baseHref: baseHrefDoProjeto(ds.projetoAbs), fontes }).replace("<body></body></html>", "<body>"));
    f.css = ds.css;
    f.fontes = fontes.join("|");
    f.html = "";
    // `document.open` tira os ouvintes do documento: religa roda/arrasto e a medida
    ligarFrame(f);
    aplicarVarsNoFrame(f, ds);
    f.mo?.disconnect();
    try {
      f.mo = new win.MutationObserver((mudancas) => {
        const novos = [];
        for (const m of mudancas) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && !/^(STYLE|SCRIPT|LINK|META|BASE|HEAD|HTML|BODY)$/.test(n.tagName)) novos.push(n);
          }
        }
        if (novos.length && animacaoLigada()) enfileirar(f, novos);
        medir(f);
      });
      f.mo.observe(d.documentElement, { childList: true, subtree: true });
    } catch {
      /* sem observer cruzando documento: o card aparece, só não anima elemento por elemento */
    }
    const fila = f.filaStream;
    f.filaStream = null;
    for (const html of fila) escreverStream(f, html);
  }

  function escreverStream(f, html) {
    const d = f.frame.contentDocument;
    if (!d) return;
    d.write(html);
    medir(f);
  }

  function encerrarStream(f) {
    f.streaming = false;
    f.filaStream = null;
    f.mo?.disconnect();
    f.mo = null;
    f.cartao.classList.remove("desenhando");
    try {
      f.frame.contentDocument?.close();
    } catch {
      /* já fechado */
    }
  }

  function limparFrames() {
    for (const f of frames.values()) {
      f.ro?.disconnect?.();
      f.cartao.remove();
    }
    frames.clear();
    const board = el("ds-board");
    // só as seções: cursor e camada de contorno moram no board e ficam
    if (board) for (const s of board.querySelectorAll(":scope > .ds-secao")) s.remove();
    fila = [];
  }

  /* ---------- animação da diferença ---------- */

  function pulsar(f) {
    f.cartao.classList.remove("pulso");
    void f.cartao.offsetWidth;
    f.cartao.classList.add("pulso");
  }

  function enfileirar(f, elementos) {
    if (!elementos.length) return;
    for (const alvo of elementos.slice(0, 60)) {
      alvo.setAttribute("data-ds-anim", "");
      alvo.style.opacity = "0";
      alvo.style.transform = "scale(.97)";
      fila.push({ f, alvo });
    }
    if (!animando) void rodarFila();
  }

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Posição do elemento do card em coordenadas da camada de animação (sobre o viewport). */
  /**
   * Posição do elemento do card em coordenadas do BOARD (antes da escala) — cursor e contorno
   * moram dentro do board, então acompanham pan e zoom sem recalcular.
   */
  function retanguloNoBoard(f, alvo) {
    const b = el("ds-board").getBoundingClientRect();
    const fr = f.frame.getBoundingClientRect();
    const r = alvo.getBoundingClientRect(); // em px do documento do card = px do board
    const e = vista.escala || 1;
    return { x: (fr.left - b.left) / e + r.left, y: (fr.top - b.top) / e + r.top, w: r.width, h: r.height };
  }

  async function rodarFila() {
    animando = true;
    const cursor = el("ds-cursor");
    const camada = el("ds-traco");
    try {
      while (fila.length) {
        const { f, alvo } = fila.shift();
        if (!alvo.isConnected) continue;
        // fila grande acelera: o fim nunca atrasa muito do que já está em disco
        const passo = fila.length > 20 ? 40 : fila.length > 8 ? 70 : 110;
        const r = retanguloNoBoard(f, alvo);
        // contra-escala: o cursor mantém o tamanho na tela em qualquer zoom
        const s = 1 / (vista.escala || 1);
        cursor.style.transform = `translate(${r.x + Math.min(r.w, 24)}px, ${r.y + Math.min(r.h, 18)}px) scale(${s})`;
        cursor.classList.add("on");
        await esperar(passo);
        const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
        const w = Math.max(2, r.w);
        const h = Math.max(2, r.h);
        rect.setAttribute("x", String(r.x));
        rect.setAttribute("y", String(r.y));
        rect.setAttribute("width", String(w));
        rect.setAttribute("height", String(h));
        rect.setAttribute("rx", "4");
        const per = 2 * (w + h);
        rect.style.strokeDasharray = String(per);
        rect.style.strokeDashoffset = String(per);
        camada.append(rect);
        void rect.getBoundingClientRect();
        rect.classList.add("desenha");
        alvo.style.opacity = "";
        alvo.style.transform = "";
        setTimeout(() => {
          rect.classList.add("some");
          setTimeout(() => rect.remove(), 400);
        }, 380);
        setTimeout(() => {
          if (alvo.isConnected) alvo.removeAttribute("data-ds-anim");
        }, 400);
      }
    } finally {
      animando = false;
      setTimeout(() => {
        if (!animando) cursor.classList.remove("on");
      }, 500);
    }
  }

  /* ---------- pan / zoom ---------- */

  let espacoApertado = false;
  let arrasto = null;

  function aplicarVista() {
    el("ds-board").style.transform = `translate(${vista.x}px, ${vista.y}px) scale(${vista.escala})`;
    el("ds-zoom-val").textContent = `${Math.round(vista.escala * 100)}%`;
  }

  function aoRodar(e) {
    const vp = el("ds-viewport").getBoundingClientRect();
    if (e.ctrlKey) {
      vista = zoomEm(vista, e.clientX - vp.left, e.clientY - vp.top, Math.exp(-e.deltaY * 0.0015));
    } else {
      vista = { ...vista, x: vista.x - e.deltaX, y: vista.y - e.deltaY };
    }
    aplicarVista();
  }

  function zoomBotao(fator) {
    const vp = el("ds-viewport").getBoundingClientRect();
    vista = zoomEm(vista, vp.width / 2, vp.height / 2, fator);
    aplicarVista();
  }

  function ajustar() {
    const vp = el("ds-viewport");
    const board = el("ds-board");
    vista = ajustarATela(board.scrollWidth, board.scrollHeight, vp.clientWidth, vp.clientHeight);
    aplicarVista();
  }

  function comecarArrasto(x, y) {
    arrasto = { x, y, vx: vista.x, vy: vista.y };
    el("ds-viewport").classList.add("arrastando");
  }

  function aoMover(e) {
    if (!arrasto) return;
    vista = { ...vista, x: arrasto.vx + (e.clientX - arrasto.x), y: arrasto.vy + (e.clientY - arrasto.y) };
    aplicarVista();
  }

  function soltar() {
    if (!arrasto) return;
    arrasto = null;
    el("ds-viewport").classList.remove("arrastando");
  }

  /* ---------- painel de edição ---------- */

  function cardPorId(id) {
    const ds = estado.ds;
    if (!ds) return null;
    return cardsDoBoard(ds).find((c) => c.id === id) || null;
  }

  function varsDoCard(card) {
    const ds = estado.ds;
    if (!ds || !card) return [];
    if (card.gerado) {
      const nomes = new Set(card.tokens || []);
      return ds.vars.filter((v) => nomes.has(v.nome));
    }
    const usados = tokensUsados(card.html);
    return ds.vars.filter((v) => usados.has(v.nome));
  }

  function abrirPainel(id, modo) {
    if (editando !== id) {
      sairDaSelecao();
      descartarControles();
    }
    editando = id;
    painelModo = modo;
    if (modo === "feedback") entrarNaSelecao(id);
    el("ds-painel").classList.remove("hidden");
    for (const f of frames.values()) f.cartao.classList.toggle("editando", f.card?.id === id);
    pintarPainel();
  }

  function fecharPainel() {
    sairDaSelecao();
    descartarControles();
    editando = null;
    el("ds-painel")?.classList.add("hidden");
    for (const f of frames.values()) f.cartao.classList.remove("editando");
  }

  function pintarPainel() {
    if (editando === FERRAMENTA) return pintarFerramenta();
    const card = cardPorId(editando);
    if (!card) {
      fecharPainel();
      return;
    }
    el("ds-painel-tit").textContent = card.titulo;
    const avisos = card.gerado ? estado.ds.tokensLint : card.lint;
    pintarAbas(card, avisos);
    const corpo = el("ds-painel-corpo");
    corpo.innerHTML = "";
    if (painelModo === "feedback") return pintarFeedback(corpo, card);
    if (painelModo === "controles") return pintarControles(corpo, card);
    if (painelModo === "versoes") return void pintarVersoes(corpo, card);
    if (painelModo === "layout") return pintarLayout(corpo, card);
    if (painelModo === "avisos") {
      if (!avisos.length) {
        corpo.innerHTML = `<p class="ds-painel-vazio">Nenhum aviso do lint.</p>`;
        return;
      }
      for (const a of avisos) {
        const item = doc.createElement("div");
        item.className = "ds-aviso";
        item.innerHTML = `<strong></strong><code></code>`;
        item.querySelector("strong").textContent = a.msg;
        item.querySelector("code").textContent = a.trecho || "";
        corpo.append(item);
      }
      // card de arquivo: um agente refaz o card com os avisos como pedido (mesmo caminho do Feedback)
      if (!card.gerado) pintarPedirCorrecao(corpo, card, avisos);
      return;
    }
    const vars = varsDoCard(card);
    if (!vars.length) {
      corpo.innerHTML = `<p class="ds-painel-vazio">Este card não usa nenhum token.</p>`;
      return;
    }
    for (const v of vars) corpo.append(linhaDeToken(v));
  }

  function linhaDeToken(v) {
    const linha = doc.createElement("label");
    linha.className = "ds-token";
    linha.innerHTML = `<span class="ds-token-nome"></span><span class="ds-token-campos"></span>`;
    linha.querySelector(".ds-token-nome").textContent = v.caminho;
    linha.querySelector(".ds-token-nome").title = v.nome;
    const campos = linha.querySelector(".ds-token-campos");
    const atual = overrides.get(v.nome) ?? textoDoBruto(v);
    const texto = doc.createElement("input");
    texto.type = "text";
    texto.value = atual;
    texto.spellcheck = false;
    const hex = paraHexInput(overrides.get(v.nome) ?? v.valor);
    let cor = null;
    if (hex) {
      cor = doc.createElement("input");
      cor.type = "color";
      cor.value = hex;
      cor.addEventListener("input", () => {
        texto.value = cor.value;
        mudarToken(v, cor.value);
      });
      campos.append(cor);
    }
    texto.addEventListener("input", () => {
      const h = paraHexInput(texto.value);
      if (cor && h) cor.value = h;
      mudarToken(v, texto.value);
    });
    campos.append(texto);
    return linha;
  }

  function textoDoBruto(v) {
    const b = v.bruto;
    if (typeof b === "string") return b;
    if (typeof b === "number") return String(b);
    if (Array.isArray(b)) return b.join(", ");
    return v.valor;
  }

  /** Edição ao vivo: vale no board na hora (override de variável) e grava com debounce. */
  function mudarToken(v, texto) {
    const bruto = textoParaBruto(texto, v.bruto);
    overrides.set(v.nome, cssDoBruto(bruto));
    pendentes.set(v.caminho, bruto);
    for (const f of frames.values()) if (estado.ds) aplicarVarsNoFrame(f, estado.ds);
    clearTimeout(salvarTimer);
    salvarTimer = setTimeout(() => void salvarPendentes(), 500);
  }

  /** caminho → valor DTCG ainda não gravado. */
  const pendentes = new Map();

  async function salvarPendentes() {
    const ds = estado.ds;
    if (!ds || !pendentes.size) return;
    let tokens = ds.tokens;
    for (const [caminho, valor] of pendentes) tokens = setNoCaminho(tokens, caminho, valor);
    pendentes.clear();
    try {
      const novo = await req(`/v1/ds/tokens?${qs()}`, { method: "PUT", body: JSON.stringify({ tokens, base: ds.tokensHash }) });
      hashSalvoPorMim = novo.tokensHash;
      aplicarDs(novo);
    } catch (e) {
      overrides.clear();
      await avisar(
        /mudou desde a leitura/.test(e.message)
          ? "O tokens.json mudou no disco (agente ou editor) enquanto você editava. Recarreguei — refaça a mudança."
          : `Não consegui salvar os tokens: ${e.message}`,
      );
      await recarregar({ animar: false });
    }
  }

  /* ---------- criar / trocar DS ---------- */

  /** `prefixo` = "ds-vazio" (estado vazio) ou "ds-novo" (popover do cabeçalho): mesmos campos. */
  async function criar(prefixo) {
    const nome = el(`${prefixo}-nome`).value.trim();
    el(`${prefixo}-err`).textContent = "";
    try {
      const base = el(`${prefixo}-base`)?.value || "zero";
      estado = await req(`/v1/ds?${qs()}`, { method: "POST", body: JSON.stringify({ nome, base }) });
      ajustouUmaVez = false;
      limparFrames();
      pintar();
      ouvir();
      el("ds-novo")?.classList.add("hidden");
      // veio do botão do Browser sem DS no projeto: agora que existe, segue pra geração
      if (referencia) {
        el("ds-vazio-err").textContent = "";
        await mostrarGerar();
        el("ds-gerar-url").value = referencia.url || "";
      }
    } catch (e) {
      el(`${prefixo}-err`).textContent = e.message;
    }
  }


  async function trocarSistema(id) {
    try {
      estado = await req(`/v1/ds/ativo?${qs()}`, { method: "PUT", body: JSON.stringify({ id }) });
      ajustouUmaVez = false;
      editando = null;
      overrides.clear();
      limparFrames();
      pintar();
      ouvir();
    } catch (e) {
      erroTopo(e.message);
    }
  }

  /**
   * Leva o Canvas até uma tela (vinda de um anexo do Planejamento): troca pro DS dela se não for o
   * ativo (perguntando — trocar o ativo muda o DS que as conversas usam) e destaca o card.
   */
  async function focarCard(sistema, id, { confirmarTroca = async () => true } = {}) {
    if (sistema && sistema !== estado.ativo) {
      const nome = estado.sistemas.find((s) => s.id === sistema)?.nome ?? sistema;
      if (!(await confirmarTroca(nome))) return false;
      await trocarSistema(sistema);
    }
    const achar = () => el("ds-board")?.querySelector(`.ds-card[data-card="${CSS.escape(id)}"]`);
    for (let i = 0; i < 20 && !achar(); i++) await new Promise((r) => win.setTimeout(r, 50));
    const cartao = achar();
    if (!cartao) return false;
    const board = el("ds-board");
    const rb = board.getBoundingClientRect();
    const rc = cartao.getBoundingClientRect();
    board.classList.add("suave");
    vista = { ...vista, x: 32 - ((rc.left - rb.left) / vista.escala) * vista.escala, y: 32 - ((rc.top - rb.top) / vista.escala) * vista.escala };
    aplicarVista();
    win.setTimeout(() => board.classList.remove("suave"), 320);
    cartao.classList.remove("ds-card-foco");
    void cartao.offsetWidth;
    cartao.classList.add("ds-card-foco");
    win.setTimeout(() => cartao.classList.remove("ds-card-foco"), 1800);
    return true;
  }

  function mostrarNovo() {
    const caixa = el("ds-novo");
    caixa.classList.toggle("hidden");
    if (!caixa.classList.contains("hidden")) {
      void carregarBases("ds-novo-base");
      el("ds-novo-nome").focus();
    }
  }

  /**
   * Combobox "Começar de": do zero (padrão da tela), o padrão do Nexos ou cópia de um DS que já
   * existe em qualquer projeto. Recarrega a cada abertura — DS criado em outro projeto aparece.
   */
  async function carregarBases(idSelect) {
    const sel = el(idSelect);
    if (!sel) return;
    let bases;
    try {
      bases = await req(`/v1/ds/bases?${qs()}`);
    } catch {
      bases = [{ id: "zero", nome: "Do zero (vazio)" }, { id: "padrao", nome: "Padrão do Nexos" }];
    }
    const antes = sel.value;
    sel.replaceChildren();
    const fixos = bases.filter((b) => !b.id.startsWith("copia:"));
    const copias = bases.filter((b) => b.id.startsWith("copia:"));
    for (const b of fixos) sel.append(Object.assign(doc.createElement("option"), { value: b.id, textContent: b.nome }));
    if (copias.length) {
      const g = doc.createElement("optgroup");
      g.label = "Copiar um design system existente";
      for (const b of copias) g.append(Object.assign(doc.createElement("option"), { value: b.id, textContent: `${b.nome} — ${b.projeto}` }));
      sel.append(g);
    }
    sel.value = bases.some((b) => b.id === antes) ? antes : "zero";
  }

  /* ---------- ligar eventos (uma vez) ---------- */

  let ligado = false;
  function ligarUmaVez() {
    if (ligado) return;
    ligado = true;
    const vp = el("ds-viewport");
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        aoRodar({ clientX: e.clientX, clientY: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, ctrlKey: e.ctrlKey || e.metaKey });
      },
      { passive: false },
    );
    vp.addEventListener("mousedown", (e) => {
      const noFundo = !e.target.closest(".ds-card");
      if (e.button === 1 || espacoApertado || (e.button === 0 && noFundo)) {
        e.preventDefault();
        comecarArrasto(e.clientX, e.clientY);
      }
    });
    win.addEventListener("mousemove", aoMover);
    win.addEventListener("mouseup", soltar);
    // espaço segurado = modo mão (iframes param de receber mouse pra o arrasto passar por cima)
    win.addEventListener("keydown", (e) => {
      // pane escondido é `visibility: hidden`, não some do layout: tem que checar o is-on
      if (e.code !== "Space" || espacoApertado || !el("pane-ds")?.classList.contains("is-on") || !estado.ds) return;
      const alvo = e.target;
      if (alvo && /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName)) return;
      espacoApertado = true;
      vp.classList.add("mao");
      e.preventDefault();
    });
    win.addEventListener("keyup", (e) => {
      if (e.code !== "Space") return;
      espacoApertado = false;
      vp.classList.remove("mao");
    });
    el("ds-btn-mira")?.addEventListener("click", () => (mira ? sairDaMira() : entrarNaMira()));
    el("ds-mira-descartar")?.addEventListener("click", sairDaMira);
    el("ds-mira-mandar")?.addEventListener("click", mandarMira);
    el("ds-mira-pedido")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        mandarMira();
      }
    });
    win.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && mira) sairDaMira();
    });
    el("ds-zoom-menos").addEventListener("click", () => zoomBotao(1 / 1.2));
    el("ds-zoom-mais").addEventListener("click", () => zoomBotao(1.2));
    el("ds-ajustar").addEventListener("click", ajustar);
    el("ds-anim").addEventListener("click", () => {
      try {
        win.localStorage?.setItem(LS_ANIM, animacaoLigada() ? "0" : "1");
      } catch {
        /* sem storage */
      }
      pintarCabecalho();
    });
    el("ds-tema").addEventListener("change", (e) => {
      tema = e.target.value;
      if (estado.ds) for (const f of frames.values()) aplicarVarsNoFrame(f, estado.ds);
    });
    el("ds-sistema").addEventListener("change", (e) => void trocarSistema(e.target.value));
    el("ds-btn-novo").addEventListener("click", mostrarNovo);
    el("ds-avisos").addEventListener("click", () => {
      const comAviso = estado.ds?.cards.find((c) => c.lint.length);
      if (comAviso) abrirPainel(comAviso.id, "avisos");
      else if (estado.ds?.tokensLint.length) abrirPainel(cardsDoBoard(estado.ds)[0]?.id, "avisos");
    });
    for (const prefixo of ["ds-vazio", "ds-novo"]) {
      el(`${prefixo}-criar`).addEventListener("click", () => void criar(prefixo));
    }
    el("ds-painel-fechar").addEventListener("click", fecharPainel);
    el("ds-btn-gerar").addEventListener("click", () => void mostrarGerar());
    el("ds-btn-ferramentas").addEventListener("click", () => el("ds-ferramentas").classList.toggle("hidden"));
    el("ds-btn-card").addEventListener("click", () => abrirFerramenta("novo-card"));
    el("ds-vazio-gerar")?.addEventListener("click", () => void mostrarGerar());
    el("ds-vazio-card")?.addEventListener("click", () => abrirFerramenta("novo-card"));
    // a lista de seções fica por cima do board: roda e arrasto nela não podem virar pan/zoom
    for (const id of ["ds-nav", "ds-quadro-vazio"]) {
      for (const tipo of ["wheel", "mousedown", "pointerdown"]) el(id)?.addEventListener(tipo, (e) => e.stopPropagation());
    }
    for (const b of el("ds-ferramentas").querySelectorAll("[data-ferramenta]")) {
      b.addEventListener("click", () => abrirFerramenta(b.dataset.ferramenta));
    }
    el("ds-gerar-fechar").addEventListener("click", () => el("ds-gerar").classList.add("hidden"));
    el("ds-gerar-ir").addEventListener("click", () => void gerar());
    el("ds-gerar-form").addEventListener("change", pintarEstimativa);
    el("ds-progresso-cancelar").addEventListener("click", () => void cancelarGeracao());
    el("ds-gerar-ref-tirar").addEventListener("click", () => {
      referencia = null;
      pintarReferencia();
    });
    el("ds-progresso-fechar").addEventListener("click", () => {
      el("ds-progresso").classList.add("hidden");
      progressoDispensado = geracao?.id || "";
    });

  }

  /* ---------- ferramentas: conformidade, ressincronizar, exportar (Fase 5) ---------- */

  const FERRAMENTA = "__ferramenta";
  let ferramenta = "";

  function abrirFerramenta(qual) {
    el("ds-ferramentas").classList.add("hidden");
    sairDaSelecao();
    descartarControles();
    for (const f of frames.values()) f.cartao.classList.remove("editando");
    editando = FERRAMENTA;
    ferramenta = qual;
    el("ds-painel").classList.remove("hidden");
    pintarPainel();
  }

  function pintarFerramenta() {
    const titulos = { conformidade: "Conformidade do código", ressincronizar: "Ressincronizar com o código", exportar: "Exportar tokens", "novo-card": "Novo card" };
    el("ds-painel-tit").textContent = titulos[ferramenta] || "";
    el("ds-painel-abas").replaceChildren();
    const corpo = el("ds-painel-corpo");
    corpo.innerHTML = `<p class="ds-painel-vazio">Carregando…</p>`;
    if (ferramenta === "novo-card") void pintarNovoCard(corpo);
    else if (ferramenta === "conformidade") void pintarConformidade(corpo);
    else if (ferramenta === "ressincronizar") void pintarRessincronia(corpo);
    else pintarExportar(corpo);
  }

  function linhaTexto(classe, texto) {
    const p = doc.createElement("p");
    p.className = classe;
    p.textContent = texto;
    return p;
  }

  async function pintarConformidade(corpo) {
    let r;
    try {
      r = await req(`/v1/ds/conformidade?${qs()}`);
    } catch (e) {
      corpo.replaceChildren(linhaTexto("ag-err", e.message));
      return;
    }
    if (editando !== FERRAMENTA || ferramenta !== "conformidade") return;
    corpo.replaceChildren();
    const partes = [
      r.cores ? `${r.cores} cor${r.cores > 1 ? "es" : ""}` : "",
      r.tamanhos ? `${r.tamanhos} tamanho${r.tamanhos > 1 ? "s" : ""}` : "",
    ].filter(Boolean);
    corpo.append(
      linhaTexto(
        "ds-painel-vazio",
        r.total
          ? `${partes.join(" e ")} solto${r.total > 1 ? "s" : ""} em ${r.porArquivo.length} arquivo(s) de ${r.arquivosLidos} lidos. ${r.exatos} já têm token igual, ${r.perto} ficam perto de um token, ${r.foraDaPaleta} estão fora do DS.`
          : `Nenhuma cor ou tamanho solto nos ${r.arquivosLidos} arquivos de front lidos.`,
      ),
    );
    if (!r.total) return;
    const resumo = doc.createElement("div");
    resumo.className = "ds-conf-resumo";
    for (const [rotulo, n, tipo] of [["trocar pelo token", r.exatos, "exato"], ["quase um token", r.perto, "perto"], ["fora do DS", r.foraDaPaleta, "fora"]]) {
      const b = doc.createElement("span");
      b.className = "ds-conf-num";
      b.dataset.tipo = tipo;
      b.innerHTML = `<strong></strong><span></span>`;
      b.querySelector("strong").textContent = String(n);
      b.querySelector("span").textContent = rotulo;
      resumo.append(b);
    }
    corpo.append(resumo);
    const ICONE = { fonte: "Aa", espaco: "↔", raio: "◜" };
    const lista = doc.createElement("ol");
    lista.className = "ds-conf-lista";
    for (const a of r.achados.slice(0, 80)) {
      const li = doc.createElement("li");
      li.dataset.tipo = a.classe;
      li.innerHTML = `<span class="ds-conf-cor"></span><code class="ds-conf-onde"></code><span class="ds-conf-sug"></span>`;
      const marca = li.querySelector(".ds-conf-cor");
      if (a.tipo === "cor") marca.style.background = a.valor;
      else {
        marca.classList.add("ds-conf-med");
        marca.textContent = ICONE[a.grupo] ?? "";
      }
      li.querySelector(".ds-conf-onde").textContent = `${a.arquivo}:${a.linha} ${a.valor}`;
      li.querySelector(".ds-conf-sug").textContent = a.exato
        ? `→ var(${a.exato})`
        : a.sugestao
          ? `≈ var(${a.sugestao.token})${a.classe === "fora" ? " (longe)" : ""}`
          : "";
      lista.append(li);
    }
    corpo.append(lista);
    if (r.achados.length > 80) corpo.append(linhaTexto("ds-painel-vazio", `… e mais ${r.achados.length - 80}.`));
    const botao = doc.createElement("button");
    botao.type = "button";
    botao.className = "primary";
    botao.textContent = "Pedir a correção no chat";
    botao.title = "Monta o pedido no campo do chat — você revisa e manda";
    botao.addEventListener("click", () => {
      const itens = r.achados
        .filter((a) => a.classe !== "fora")
        .slice(0, 40)
        .map((a) => `- ${a.arquivo}:${a.linha} ${a.valor} → var(${a.exato || a.sugestao.token})`);
      const fora = r.achados.filter((a) => a.classe === "fora").length;
      aoPedirNoChat(
        `Troque os valores soltos do front (cor e tamanho) por tokens do design system "${estado.ds?.nome ?? ""}":\n${itens.join("\n")}` +
          (fora ? `\n\nOutros ${fora} valores estão fora do DS: me diga quais viram token novo (em tokens.json) e quais trocam por um token existente.` : ""),
      );
    });
    corpo.append(botao);
  }

  async function pintarRessincronia(corpo) {
    let r;
    try {
      r = await req(`/v1/ds/ressincronizar?${qs()}`);
    } catch (e) {
      corpo.replaceChildren(linhaTexto("ag-err", e.message));
      return;
    }
    if (editando !== FERRAMENTA || ferramenta !== "ressincronizar") return;
    corpo.replaceChildren();
    corpo.append(linhaTexto("ds-painel-vazio", "Marque o que entra no DS. Aplicar grava no tokens.json na hora, sem IA — os cards já usam os tokens por variável."));
    /** Cada item marcado vira uma ação; `montar()` lê o estado atual (nome pode ter sido editado). */
    const marcados = [];
    const secao = (titulo, itens, pintarItem, vazio) => {
      corpo.append(linhaTexto("ds-sync-tit", titulo));
      if (!itens.length) {
        corpo.append(linhaTexto("ds-painel-vazio", vazio));
        return;
      }
      const ul = doc.createElement("ul");
      ul.className = "ds-conf-lista ds-sync-lista";
      for (const it of itens) ul.append(pintarItem(it));
      corpo.append(ul);
    };
    const itemComCheck = ({ hex, texto, nome, desabilitado, dica, montar }) => {
      const li = doc.createElement("li");
      li.innerHTML = `<input type="checkbox" class="ds-sync-check" /><span class="ds-conf-cor"></span><code class="ds-conf-onde"></code>`;
      const check = li.querySelector("input");
      li.querySelector(".ds-conf-cor").style.background = hex;
      li.querySelector(".ds-conf-onde").textContent = texto;
      let campo = null;
      if (nome !== undefined) {
        campo = doc.createElement("input");
        campo.type = "text";
        campo.className = "ds-sync-nome";
        campo.value = nome;
        campo.spellcheck = false;
        campo.title = "Nome do token (a-z, 0-9, hífen)";
        li.append(campo);
      }
      if (desabilitado) {
        check.disabled = true;
        li.title = dica ?? "";
        li.dataset.tipo = "fora";
      }
      check.addEventListener("change", pintarBotao);
      marcados.push(() => (check.checked ? montar(campo?.value.trim() ?? "") : null));
      return li;
    };
    secao(
      "Cores que o código usa e o DS não tem",
      r.coresNovas,
      (c) =>
        itemComCheck({
          hex: c.hex,
          texto: `${c.hex} · ${c.usos} usos${c.maisPerto ? ` · mais perto: ${c.maisPerto.token}` : ""}`,
          nome: c.nomeSugerido,
          montar: (nome) => ({ acao: "adicionar-cor", hex: c.hex, nome }),
        }),
      "Nenhuma: toda cor frequente do código está coberta por um token.",
    );
    secao(
      "Fontes do código fora do DS",
      r.fontesNovas,
      (f) =>
        itemComCheck({
          hex: "transparent",
          texto: `${f.familia} · ${f.usos} usos`,
          nome: f.nomeSugerido,
          montar: (nome) => ({ acao: "adicionar-fonte", familia: f.familia, nome }),
        }),
      "Nenhuma.",
    );
    secao(
      "Tokens com outro valor no código",
      r.valoresAlterados,
      (v) =>
        itemComCheck({
          hex: /^#/.test(v.noCodigo) ? v.noCodigo : "transparent",
          texto: `${v.token}: ${v.noDs} → ${v.noCodigo}`,
          montar: () => ({ acao: "atualizar", token: v.token, valor: v.noCodigo }),
        }),
      "Nenhum: o código não redeclara token com outro valor.",
    );
    secao(
      "Tokens de cor que o código não usa (remover)",
      r.coresSemUso,
      (c) =>
        itemComCheck({
          hex: c.hex,
          texto: `${c.token} ${c.hex}`,
          desabilitado: c.usadoEmCards,
          dica: "Um card ou outro token usa este — remover quebraria",
          montar: () => ({ acao: "remover", token: c.token }),
        }),
      "Todos aparecem no código.",
    );
    const acoes = doc.createElement("div");
    acoes.className = "ds-ctl-acoes";
    const aplicar = doc.createElement("button");
    aplicar.type = "button";
    aplicar.className = "primary";
    aplicar.disabled = true;
    const ia = doc.createElement("button");
    ia.type = "button";
    ia.className = "ghost";
    ia.textContent = "Atualizar tokens com IA";
    ia.title = "Abre o Gerar com IA só com 'tokens e regras', lendo o código de novo";
    ia.addEventListener("click", async () => {
      fecharPainel();
      await mostrarGerar();
      for (const i of el("ds-gerar-secoes").querySelectorAll("input")) i.checked = false;
      el("ds-gerar-tokens").checked = true;
      el("ds-gerar-codigo").checked = true;
      pintarEstimativa();
    });
    const erro = linhaTexto("ag-err", "");
    function pintarBotao() {
      const n = marcados.filter((m) => m()).length;
      aplicar.disabled = !n;
      aplicar.textContent = n ? `Aplicar ${n} ${n > 1 ? "itens" : "item"}` : "Aplicar";
    }
    pintarBotao();
    aplicar.addEventListener("click", async () => {
      const itens = marcados.map((m) => m()).filter(Boolean);
      if (!itens.length) return;
      aplicar.disabled = true;
      erro.textContent = "";
      try {
        const novo = await req(`/v1/ds/ressincronizar/aplicar?${qs()}`, { method: "POST", body: JSON.stringify({ base: r.base, itens }) });
        hashSalvoPorMim = novo.tokensHash;
        aplicarDs(novo);
        corpo.innerHTML = `<p class="ds-painel-vazio">Carregando…</p>`;
        await pintarRessincronia(corpo);
      } catch (e) {
        erro.textContent = /mudou desde a leitura/.test(e.message) ? "O tokens.json mudou desde a leitura. Recarreguei a lista — confira e aplique de novo." : e.message;
        if (/mudou desde a leitura/.test(e.message)) {
          await pintarRessincronia(corpo);
          corpo.append(erro);
        } else pintarBotao();
      }
    });
    acoes.append(ia, aplicar);
    corpo.append(acoes, erro);
  }

  function pintarExportar(corpo) {
    corpo.replaceChildren(linhaTexto("ds-painel-vazio", "Os tokens no formato que o projeto usa. Copie pro código ou baixe o arquivo."));
    const escolha = doc.createElement("div");
    escolha.className = "ds-exp-formatos";
    const saida = doc.createElement("textarea");
    saida.className = "ds-exp-saida";
    saida.readOnly = true;
    saida.spellcheck = false;
    const acoes = doc.createElement("div");
    acoes.className = "ds-ctl-acoes";
    acoes.innerHTML = `<button type="button" class="ghost" data-a="copiar" disabled>Copiar</button><button type="button" class="primary" data-a="baixar" disabled>Baixar</button>`;
    let atual = null;
    for (const [id, rotulo] of [["css", "CSS vars"], ["tailwind4", "Tailwind v4"], ["tailwind3", "Tailwind v3"], ["dtcg", "tokens.json"]]) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "ax-tab";
      b.textContent = rotulo;
      b.addEventListener("click", async () => {
        for (const x of escolha.children) x.dataset.on = x === b ? "1" : "0";
        try {
          atual = await req(`/v1/ds/exportar?${qs()}&formato=${id}`);
          saida.value = atual.texto;
          for (const x of acoes.querySelectorAll("button")) x.disabled = false;
        } catch (e) {
          saida.value = e.message;
        }
      });
      escolha.append(b);
    }
    acoes.querySelector('[data-a="copiar"]').addEventListener("click", async () => {
      if (!atual) return;
      try {
        await win.navigator.clipboard.writeText(atual.texto);
        acoes.querySelector('[data-a="copiar"]').textContent = "Copiado";
      } catch {
        saida.select();
      }
    });
    acoes.querySelector('[data-a="baixar"]').addEventListener("click", () => {
      if (!atual) return;
      const url = URL.createObjectURL(new Blob([atual.texto], { type: atual.mime }));
      const a = doc.createElement("a");
      a.href = url;
      a.download = atual.nome;
      doc.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    corpo.append(escolha, saida, acoes);
    escolha.firstElementChild.click();
  }

  /* ---------- painel: abas ---------- */

  function pintarAbas(card, avisos) {
    const abas = el("ds-painel-abas");
    abas.replaceChildren();
    const lista = card.gerado
      ? [["tokens", "Tokens"], ["layout", "Layout"], ["avisos", avisos.length ? `Avisos (${avisos.length})` : "Avisos"]]
      : [
          ["feedback", "Feedback"],
          ["tokens", "Tokens"],
          ...(card.controles?.length ? [["controles", `Controles (${card.controles.length})`]] : []),
          ["layout", "Layout"],
          ["versoes", "Versões"],
          ["avisos", avisos.length ? `Avisos (${avisos.length})` : "Avisos"],
        ];
    if (!lista.some(([id]) => id === painelModo)) painelModo = lista[0][0];
    for (const [id, rotulo] of lista) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "ax-tab";
      b.setAttribute("role", "tab");
      b.dataset.on = id === painelModo ? "1" : "0";
      b.textContent = rotulo;
      b.addEventListener("click", () => {
        if (id !== "feedback") sairDaSelecao();
        if (id !== "controles") descartarControles();
        painelModo = id;
        if (id === "feedback") entrarNaSelecao(card.id);
        pintarPainel();
      });
      abas.append(b);
    }
  }

  /* ---------- pedir correção (avisos do lint) ---------- */

  function selectDeContas() {
    const sel = doc.createElement("select");
    for (const p of getProfiles() || []) {
      const o = doc.createElement("option");
      o.value = p.id;
      o.textContent = `${p.nickname || p.id} · ${p.engine}`;
      o.selected = p.id === getProfileId();
      sel.append(o);
    }
    // plano B (ds-sem-ia.ts no daemon): tokens + DESIGN.md por regra, sem conta e sem quota
    const semIa = doc.createElement("option");
    semIa.value = "";
    semIa.textContent = "Sem IA · só tokens e DESIGN.md, por regra";
    semIa.selected = !perfis.length;
    sel.append(semIa);
    return sel;
  }

  function pintarPedirCorrecao(corpo, card, avisos) {
    const caixa = doc.createElement("div");
    caixa.className = "ds-corrigir";
    const rot = doc.createElement("label");
    rot.className = "ds-fb-campo";
    rot.textContent = "Conta";
    const conta = selectDeContas();
    rot.append(conta);
    const err = linhaTexto("ag-err", "");
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "primary";
    b.textContent = "Pedir correção";
    b.title = "Um agente refaz este card corrigindo os avisos (verificado de novo antes de mostrar)";
    if (geracao?.status === "rodando") {
      b.disabled = true;
      err.textContent = "Espere a geração em curso terminar.";
    }
    b.addEventListener("click", async () => {
      b.disabled = true;
      err.textContent = "";
      const texto =
        "Corrija os avisos da verificação deste card, sem mudar o que não precisa:\n" +
        avisos.map((a) => `- ${a.msg}${a.trecho ? `: ${a.trecho}` : ""}`).join("\n");
      try {
        const r = await req(`/v1/ds/cards/${encodeURIComponent(card.id)}/feedback?${qs()}`, {
          method: "POST",
          body: JSON.stringify({ profileId: conta.value, texto }),
        });
        fecharPainel();
        progressoDispensado = "";
        aplicarGeracao(r.geracao);
      } catch (e) {
        err.textContent = e.message;
        b.disabled = false;
      }
    });
    caixa.append(rot, err, b);
    corpo.append(caixa);
  }

  /* ---------- layout do card (largura, seção, ordem, apagar/ocultar) ---------- */

  const LARGURAS = [["1/3", "⅓"], ["1/2", "½"], ["2/3", "⅔"], ["1", "Inteira"]];
  const ALINHAMENTOS = [["topo", "Topo"], ["esticar", "Mesma altura"], ["alvenaria", "Alvenaria (sem buracos)"]];

  async function mudarLayout(card, mudanca) {
    try {
      const ds = await req(`/v1/ds/cards/${encodeURIComponent(card.id)}?${qs()}`, { method: "PATCH", body: JSON.stringify(mudanca) });
      aplicarDs(ds);
      return true;
    } catch (e) {
      erroTopo(e.message);
      return false;
    }
  }

  function grupoDeBotoes(opcoes, atual, aoEscolher) {
    const g = doc.createElement("div");
    g.className = "ds-exp-formatos";
    for (const [valor, rotulo] of opcoes) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "ax-tab";
      b.dataset.on = valor === atual ? "1" : "0";
      b.textContent = rotulo;
      b.addEventListener("click", () => aoEscolher(valor));
      g.append(b);
    }
    return g;
  }

  function pintarLayout(corpo, card) {
    const ds = estado.ds;
    corpo.append(linhaTexto("ds-sync-tit", "Largura na linha"));
    corpo.append(grupoDeBotoes(LARGURAS, card.largura || "1/2", (largura) => void mudarLayout(card, { largura })));

    corpo.append(linhaTexto("ds-sync-tit", "Posição na seção"));
    const mover = doc.createElement("div");
    mover.className = "ds-ctl-acoes";
    mover.innerHTML = `<button type="button" class="ghost" data-m="-1">← Antes</button><button type="button" class="ghost" data-m="1">Depois →</button>`;
    for (const b of mover.querySelectorAll("button")) b.addEventListener("click", () => void mudarLayout(card, { mover: Number(b.dataset.m) }));
    corpo.append(mover);

    if (!card.gerado) {
      corpo.append(linhaTexto("ds-sync-tit", "Título e seção"));
      const tit = doc.createElement("input");
      tit.type = "text";
      tit.value = card.titulo;
      tit.className = "ds-layout-campo";
      tit.setAttribute("aria-label", "Título do card");
      tit.addEventListener("change", () => tit.value.trim() && void mudarLayout(card, { titulo: tit.value.trim() }));
      const sec = doc.createElement("select");
      sec.className = "ds-layout-campo";
      sec.setAttribute("aria-label", "Seção do card");
      for (const s of ds.secoes.filter((x) => x.id !== "fundamentos")) {
        const o = doc.createElement("option");
        o.value = s.id;
        o.textContent = s.titulo;
        o.selected = s.id === card.secao;
        sec.append(o);
      }
      const nova = doc.createElement("option");
      nova.value = "__nova";
      nova.textContent = "Nova seção…";
      sec.append(nova);
      const nomeNova = doc.createElement("input");
      nomeNova.type = "text";
      nomeNova.placeholder = "Nome da seção nova";
      nomeNova.className = "ds-layout-campo hidden";
      sec.addEventListener("change", () => {
        nomeNova.classList.toggle("hidden", sec.value !== "__nova");
        if (sec.value !== "__nova") void mudarLayout(card, { secao: sec.value });
        else nomeNova.focus();
      });
      nomeNova.addEventListener("change", () => nomeNova.value.trim() && void mudarLayout(card, { secao: nomeNova.value.trim() }));
      corpo.append(tit, sec, nomeNova);
    }

    const secao = secoesDoBoard(ds).find((s) => s.id === card.secao);
    corpo.append(linhaTexto("ds-sync-tit", `Alinhamento da seção "${secao?.titulo ?? card.secao}"`));
    corpo.append(
      grupoDeBotoes(ALINHAMENTOS, secao?.alinhamento || "topo", async (alinhamento) => {
        try {
          aplicarDs(await req(`/v1/ds/secoes/${encodeURIComponent(card.secao)}?${qs()}`, { method: "PATCH", body: JSON.stringify({ alinhamento }) }));
        } catch (e) {
          erroTopo(e.message);
        }
      }),
    );
    corpo.append(linhaTexto("ds-painel-vazio", "Dica: no chat, peça \"alinha os cards do design system\" — o agente reorganiza largura, ordem e alinhamento pelo meta.json."));

    const perigo = doc.createElement("button");
    perigo.type = "button";
    perigo.className = "ghost ds-perigo";
    perigo.textContent = card.gerado ? "Ocultar do board" : "Apagar card";
    perigo.title = card.gerado ? "Some do board; volta em + Card → Fundamentos ocultos" : "Apaga o arquivo do card (fica uma versão guardada)";
    perigo.addEventListener("click", async () => {
      if (card.gerado) {
        if (await mudarLayout(card, { oculto: true })) fecharPainel();
        return;
      }
      if (!(await confirmar(`Apagar o card "${card.titulo}"? Fica uma versão guardada em .versoes/.`))) return;
      try {
        aplicarDs(await req(`/v1/ds/cards/${encodeURIComponent(card.id)}?${qs()}`, { method: "DELETE" }));
        fecharPainel();
      } catch (e) {
        erroTopo(e.message);
      }
    });
    corpo.append(perigo);
  }

  /* ---------- + Card: criar card de um tipo ---------- */

  let novoTipo = "cores";

  async function pintarNovoCard(corpo) {
    let tipos;
    try {
      tipos = await req(`/v1/ds/tipos?${qs()}`);
    } catch (e) {
      corpo.replaceChildren(linhaTexto("ag-err", e.message));
      return;
    }
    if (editando !== FERRAMENTA || ferramenta !== "novo-card") return;
    const ds = estado.ds;
    corpo.replaceChildren();
    corpo.append(linhaTexto("ds-painel-vazio", "Card de token sai pronto do modelo (mesmo visual dos Fundamentos). Componente e livre a IA desenha."));
    const escolha = grupoDeBotoes(
      tipos.map((t) => [t.id, t.daIa ? `${t.titulo} ✦` : t.titulo]),
      novoTipo,
      (id) => {
        novoTipo = id;
        void pintarNovoCard(corpo);
      },
    );
    corpo.append(escolha);
    const tipo = tipos.find((t) => t.id === novoTipo) || tipos[0];

    const campo = (rotulo, input) => {
      const l = doc.createElement("label");
      l.className = "ds-fb-campo";
      l.textContent = rotulo;
      l.append(input);
      corpo.append(l);
      return input;
    };
    const titulo = campo("Título", Object.assign(doc.createElement("input"), { type: "text", value: tipo.titulo }));
    const subtitulo = campo("Subtítulo (opcional)", Object.assign(doc.createElement("input"), { type: "text" }));
    const secao = doc.createElement("select");
    for (const s of ds.secoes.filter((x) => x.id !== "fundamentos")) secao.append(Object.assign(doc.createElement("option"), { value: s.id, textContent: s.titulo }));
    secao.append(Object.assign(doc.createElement("option"), { value: "__nova", textContent: "Nova seção…" }));
    campo("Seção", secao);
    const secaoNova = Object.assign(doc.createElement("input"), { type: "text", placeholder: "Nome da seção nova", className: "ds-layout-campo hidden" });
    corpo.append(secaoNova);
    secao.addEventListener("change", () => secaoNova.classList.toggle("hidden", secao.value !== "__nova"));
    let largura = "1/2";
    corpo.append(linhaTexto("ds-sync-tit", "Largura"));
    const gl = grupoDeBotoes(LARGURAS, largura, (v) => {
      largura = v;
      for (const b of gl.children) b.dataset.on = b.textContent === LARGURAS.find(([x]) => x === v)[1] ? "1" : "0";
    });
    corpo.append(gl);

    let marcados = null;
    let pedido = null;
    let conta = null;
    if (!tipo.daIa) {
      corpo.append(linhaTexto("ds-sync-tit", `Tokens (${tipo.tokens.length})`));
      const ul = doc.createElement("ul");
      ul.className = "ds-conf-lista ds-sync-lista";
      marcados = [];
      for (const t of tipo.tokens) {
        const li = doc.createElement("li");
        li.innerHTML = `<input type="checkbox" class="ds-sync-check" checked /><code class="ds-conf-onde"></code>`;
        li.querySelector("code").textContent = `${t.caminho} · ${t.valor}`;
        marcados.push([t.nome, li.querySelector("input")]);
        ul.append(li);
      }
      if (!tipo.tokens.length) ul.append(linhaTexto("ds-painel-vazio", "Nenhum token desse tipo em tokens.json."));
      corpo.append(ul);
    } else {
      pedido = campo(
        "O que o card mostra",
        Object.assign(doc.createElement("textarea"), {
          rows: 4,
          placeholder: tipo.id === "componente" ? "Ex.: badges de status do pedido (novo, pago, enviado, cancelado) com e sem ícone." : "Ex.: grade de ícones do produto em 16/20/24px.",
        }),
      );
      conta = campo("Conta", selectDeContas());
    }

    const err = linhaTexto("ag-err", "");
    const criar = doc.createElement("button");
    criar.type = "button";
    criar.className = "primary";
    criar.textContent = tipo.daIa ? "Gerar com IA" : "Criar card";
    if (tipo.daIa && geracao?.status === "rodando") {
      criar.disabled = true;
      err.textContent = "Espere a geração em curso terminar.";
    }
    criar.addEventListener("click", async () => {
      err.textContent = "";
      const base = {
        tipo: tipo.id,
        titulo: titulo.value.trim(),
        subtitulo: subtitulo.value.trim(),
        secao: secao.value === "__nova" ? secaoNova.value.trim() : secao.value,
        largura,
      };
      criar.disabled = true;
      try {
        if (tipo.daIa) {
          const r = await req(`/v1/ds/cards/novo-ia?${qs()}`, {
            method: "POST",
            body: JSON.stringify({ ...base, texto: pedido.value.trim(), profileId: conta.value }),
          });
          fecharPainel();
          progressoDispensado = "";
          aplicarGeracao(r.geracao);
        } else {
          const r = await req(`/v1/ds/cards?${qs()}`, {
            method: "POST",
            body: JSON.stringify({ ...base, tokens: marcados.filter(([, c]) => c.checked).map(([n]) => n) }),
          });
          aplicarDs(r.ds);
          fecharPainel();
          win.setTimeout(() => { const f = frames.get(r.id); if (f) pulsar(f); }, 50);
        }
      } catch (e) {
        err.textContent = e.message;
        criar.disabled = false;
      }
    });
    corpo.append(err, criar);

    const ocultos = (ds.fundamentos || []).filter((f) => f.oculto);
    if (ocultos.length) {
      corpo.append(linhaTexto("ds-sync-tit", "Fundamentos ocultos"));
      for (const f of ocultos) {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = "ghost";
        b.textContent = `Mostrar "${f.titulo}"`;
        b.addEventListener("click", async () => {
          if (await mudarLayout(f, { oculto: false })) void pintarNovoCard(corpo);
        });
        corpo.append(b);
      }
    }
  }

  /* ---------- feedback por elemento ---------- */

  /** Como o card aparece no chat: título + onde mora, pro agente achar o arquivo. */
  function referenciaDoCard(card) {
    const onde = card.gerado ? "fundamento gerado dos tokens" : `cards/${card.id}.html`;
    return `card "${card.titulo}" do design system (${onde})`;
  }

  /** Contorno de hover/seleção dentro do card, na cor de destaque do app (o card não enxerga as variáveis do host). */
  function injetarMarcas(d) {
    const acento = getComputedStyle(doc.documentElement).getPropertyValue("--accent").trim() || "#7c5cbf";
    let st = d.getElementById("ds-marcas");
    if (!st) {
      st = d.createElement("style");
      st.id = "ds-marcas";
      d.head.append(st);
    }
    st.textContent =
      `*{cursor:crosshair!important}[data-ds-hover]{outline:1px dashed ${acento}!important;outline-offset:2px}` +
      `[data-ds-sel]{outline:2px solid ${acento}!important;outline-offset:2px;position:relative}` +
      `[data-ds-sel]::after{content:attr(data-ds-sel);position:absolute;top:-10px;left:-10px;min-width:16px;height:16px;` +
      `padding:0 3px;border-radius:8px;background:${acento};color:#fff;font:600 10px/16px system-ui;text-align:center;z-index:9}`;
  }

  function limparMarcas(d) {
    d.getElementById("ds-marcas")?.remove();
    d.querySelectorAll("[data-ds-hover],[data-ds-sel]").forEach((n) => {
      n.removeAttribute("data-ds-hover");
      n.removeAttribute("data-ds-sel");
    });
  }

  /* ---------- mira: selecionar elementos de qualquer card e mandar pro chat ---------- */

  function entrarNaMira() {
    if (mira) return;
    // o Feedback aponta num card só; as duas seleções juntas no mesmo iframe se atropelam
    if (painelModo === "feedback" && editando && editando !== FERRAMENTA) fecharPainel();
    sairDaSelecao();
    mira = { itens: [] };
    for (const f of frames.values()) {
      const d = f.frame.contentDocument;
      if (d?.head) injetarMarcas(d);
    }
    el("ds-btn-mira")?.setAttribute("aria-pressed", "true");
    el("ds-mira-faixa")?.classList.remove("hidden");
    pintarMira();
  }

  function sairDaMira() {
    if (!mira) return;
    mira = null;
    for (const f of frames.values()) {
      const d = f.frame.contentDocument;
      if (d?.head) limparMarcas(d);
    }
    el("ds-btn-mira")?.setAttribute("aria-pressed", "false");
    el("ds-mira-faixa")?.classList.add("hidden");
    el("ds-mira")?.classList.add("hidden");
    const pedido = el("ds-mira-pedido");
    if (pedido) pedido.value = "";
  }

  function alternarNaMira(card, alvo) {
    if (!mira || !card) return;
    if (alvo.hasAttribute("data-ds-sel")) {
      alvo.removeAttribute("data-ds-sel");
      mira.itens = mira.itens.filter((i) => i.el !== alvo);
    } else {
      mira.itens.push({ card, el: alvo, ...resumoDoElemento(alvo) });
    }
    pintarMira();
  }

  /** Caixa flutuante com um chip por elemento; fica escondida enquanto não há nenhum (só a faixa aparece). */
  function pintarMira() {
    if (!mira) return;
    // card redesenhado (agente editou, variante trocou) leva os elementos antigos junto
    mira.itens = mira.itens.filter((it) => it.el.isConnected);
    mira.itens.forEach((it, i) => it.el.setAttribute("data-ds-sel", String(i + 1)));
    const caixa = el("ds-mira");
    const lista = el("ds-mira-lista");
    if (!caixa || !lista) return;
    caixa.classList.toggle("hidden", !mira.itens.length);
    lista.replaceChildren();
    for (const [i, it] of mira.itens.entries()) {
      const li = doc.createElement("li");
      li.title = `${it.card}: ${it.texto ? `${it.seletor} — ${it.texto}` : it.seletor}`;
      const rot = doc.createElement("span");
      rot.className = "insp-rotulo";
      rot.textContent = rotuloDoElemento(it.el.tagName.toLowerCase(), i);
      const nome = doc.createElement("span");
      nome.className = "insp-card";
      nome.textContent = frames.get(it.card)?.card?.titulo || it.card;
      const tirar = doc.createElement("button");
      tirar.type = "button";
      tirar.className = "ghost insp-remover";
      tirar.title = "Remover";
      tirar.setAttribute("aria-label", "Remover");
      tirar.textContent = "✕";
      tirar.addEventListener("click", () => {
        it.el.removeAttribute("data-ds-sel");
        mira.itens = mira.itens.filter((x) => x !== it);
        pintarMira();
      });
      li.append(rot, nome, tirar);
      lista.append(li);
    }
  }

  function mandarMira() {
    if (!mira) return;
    const texto = (el("ds-mira-pedido")?.value || "").trim();
    const elementos = mira.itens.map((it, i) => {
      const c = frames.get(it.card)?.card;
      return {
        rotulo: rotuloDoElemento(it.el.tagName.toLowerCase(), i),
        seletor: `${c ? referenciaDoCard(c) : it.card} → ${it.seletor}`,
        ...(it.texto ? { texto: it.texto } : {}),
        html: it.html,
      };
    });
    if (!texto && !elementos.length) return;
    sairDaMira();
    aoMandarNoChat(texto, elementos);
  }

  function frameDoCard(id) {
    return frames.get(id)?.frame.contentDocument || null;
  }

  function entrarNaSelecao(id) {
    if (selecao?.card === id) return;
    sairDaSelecao();
    sairDaMira();
    selecao = { card: id, itens: [] };
    const d = frameDoCard(id);
    if (!d) return;
    injetarMarcas(d);
    frames.get(id)?.cartao.classList.add("selecionando");
  }

  function numerarSelecao(d) {
    selecao?.itens.forEach((it, i) => it.el.setAttribute("data-ds-sel", String(i + 1)));
    void d;
  }

  function sairDaSelecao() {
    if (!selecao) return;
    const d = frameDoCard(selecao.card);
    if (d) limparMarcas(d);
    frames.get(selecao.card)?.cartao.classList.remove("selecionando");
    selecao = null;
  }

  function pintarFeedback(corpo, card) {
    corpo.innerHTML = `<p class="ds-painel-vazio">Clique nos elementos do card pra apontar o que mudar (opcional) e descreva o pedido. Um agente refaz só este card.</p>
      <ol id="ds-fb-sel" class="ds-fb-sel"></ol>
      <label class="ds-fb-campo">O que mudar<textarea id="ds-fb-texto" rows="4" placeholder="Ex.: botão primário maior e com ícone à esquerda; tirar a sombra do secundário."></textarea></label>
      <label class="ds-fb-campo">Conta<select id="ds-fb-conta"></select></label>
      <label class="ds-check"><input type="checkbox" id="ds-fb-variante" /><span>Como variante (mantém o card atual pra comparar)</span></label>
      <p id="ds-fb-err" class="ag-err"></p>
      <button type="button" id="ds-fb-enviar" class="primary">Enviar feedback</button>`;
    const sel = corpo.querySelector("#ds-fb-conta");
    for (const p of getProfiles() || []) {
      const o = doc.createElement("option");
      o.value = p.id;
      o.textContent = `${p.nickname || p.id} · ${p.engine}`;
      o.selected = p.id === getProfileId();
      sel.append(o);
    }
    // plano B (ds-sem-ia.ts no daemon): tokens + DESIGN.md por regra, sem conta e sem quota
    const semIa = doc.createElement("option");
    semIa.value = "";
    semIa.textContent = "Sem IA · só tokens e DESIGN.md, por regra";
    semIa.selected = !perfis.length;
    sel.append(semIa);
    pintarListaSelecao();
    corpo.querySelector("#ds-fb-enviar").addEventListener("click", () => void enviarFeedback(card.id));
    if (geracao?.status === "rodando") {
      corpo.querySelector("#ds-fb-enviar").disabled = true;
      corpo.querySelector("#ds-fb-err").textContent = "Espere a geração em curso terminar.";
    }
  }

  function pintarListaSelecao() {
    const lista = el("ds-fb-sel");
    if (!lista) return;
    lista.replaceChildren();
    for (const [i, it] of (selecao?.itens || []).entries()) {
      const li = doc.createElement("li");
      li.innerHTML = `<span class="ds-fb-num"></span><code></code><button type="button" class="ghost" title="Tirar">✕</button>`;
      li.querySelector(".ds-fb-num").textContent = String(i + 1);
      li.querySelector("code").textContent = it.texto ? `${it.seletor} — "${it.texto.slice(0, 40)}"` : it.seletor;
      li.querySelector("button").addEventListener("click", () => {
        it.el.removeAttribute("data-ds-sel");
        selecao.itens = selecao.itens.filter((x) => x !== it);
        numerarSelecao();
        pintarListaSelecao();
      });
      lista.append(li);
    }
  }

  async function enviarFeedback(id) {
    const texto = el("ds-fb-texto").value.trim();
    const err = el("ds-fb-err");
    err.textContent = "";
    if (!texto) {
      err.textContent = "Escreva o que mudar.";
      return;
    }
    const corpo = {
      profileId: el("ds-fb-conta").value,
      texto,
      variante: el("ds-fb-variante").checked,
      elementos: (selecao?.itens || []).map(({ seletor, html, texto: t }) => ({ seletor, html, ...(t ? { texto: t } : {}) })),
    };
    try {
      const r = await req(`/v1/ds/cards/${encodeURIComponent(id)}/feedback?${qs()}`, { method: "POST", body: JSON.stringify(corpo) });
      sairDaSelecao();
      fecharPainel();
      progressoDispensado = "";
      aplicarGeracao(r.geracao);
    } catch (e) {
      err.textContent = e.message;
    }
  }

  async function acaoDeVariante(id, acao) {
    try {
      const ds =
        acao === "usar"
          ? await req(`/v1/ds/cards/${encodeURIComponent(id)}/promover?${qs()}`, { method: "POST", body: "{}" })
          : await req(`/v1/ds/cards/${encodeURIComponent(id)}?${qs()}`, { method: "DELETE" });
      aplicarDs(ds);
    } catch (e) {
      erroTopo(e.message);
    }
  }

  /* ---------- controles (sliders que o card declara) ---------- */

  function pintarControles(corpo, card) {
    const d = frameDoCard(card.id);
    const raiz = d ? getComputedStyle(d.documentElement) : null;
    for (const c of card.controles || []) {
      const linha = doc.createElement("label");
      linha.className = "ds-token";
      linha.innerHTML = `<span class="ds-token-nome"></span><span class="ds-token-campos"></span>`;
      linha.querySelector(".ds-token-nome").textContent = c.rotulo;
      linha.querySelector(".ds-token-nome").title = c.var;
      const campos = linha.querySelector(".ds-token-campos");
      const atual = valoresControle.get(c.var) ?? (raiz?.getPropertyValue(c.var).trim() || "");
      if (c.tipo === "range") {
        const n = Number.parseFloat(atual);
        const inicial = Number.isFinite(n) ? n : (c.padrao ?? c.min);
        const r = doc.createElement("input");
        r.type = "range";
        r.min = String(c.min);
        r.max = String(c.max);
        r.step = String(c.passo);
        r.value = String(inicial);
        const valor = doc.createElement("span");
        valor.className = "ds-ctl-valor";
        valor.textContent = `${inicial}${c.unidade}`;
        r.addEventListener("input", () => {
          valor.textContent = `${r.value}${c.unidade}`;
          mudarControle(card.id, c.var, Number(r.value), `${r.value}${c.unidade}`);
        });
        campos.append(r, valor);
      } else {
        const s = doc.createElement("select");
        const opcoes = estado.ds.vars.filter((v) => v.caminho === c.grupo || v.caminho.startsWith(`${c.grupo}.`));
        for (const v of opcoes) {
          const o = doc.createElement("option");
          o.value = v.nome;
          o.textContent = `${v.caminho} (${v.valor})`;
          o.selected = atual.includes(v.nome) || valoresControle.get(c.var) === v.nome;
          s.append(o);
        }
        s.addEventListener("change", () => mudarControle(card.id, c.var, s.value, `var(${s.value})`));
        campos.append(s);
      }
      corpo.append(linha);
    }
    const acoes = doc.createElement("div");
    acoes.className = "ds-ctl-acoes";
    acoes.innerHTML = `<p id="ds-ctl-err" class="ag-err"></p><button type="button" class="ghost" id="ds-ctl-descartar">Descartar</button><button type="button" class="primary" id="ds-ctl-aplicar">Aplicar</button>`;
    acoes.querySelector("#ds-ctl-descartar").addEventListener("click", () => {
      descartarControles();
      pintarPainel();
    });
    acoes.querySelector("#ds-ctl-aplicar").addEventListener("click", () => void aplicarControlesNoCard(card));
    corpo.append(acoes);
  }

  /** Ao vivo: muda a variável só no iframe deste card. Grava só no "Aplicar". */
  function mudarControle(cardId, nome, valor, css) {
    valoresControle.set(nome, valor);
    valoresControle.set("__card", cardId);
    frameDoCard(cardId)?.documentElement.style.setProperty(nome, css);
  }

  function descartarControles() {
    const cardId = valoresControle.get("__card");
    const d = cardId ? frameDoCard(cardId) : null;
    for (const nome of valoresControle.keys()) if (nome !== "__card") d?.documentElement.style.removeProperty(nome);
    valoresControle.clear();
  }

  async function aplicarControlesNoCard(card) {
    const valores = Object.fromEntries([...valoresControle].filter(([k]) => k !== "__card"));
    if (!Object.keys(valores).length) return;
    try {
      const ds = await req(`/v1/ds/cards/${encodeURIComponent(card.id)}/controles?${qs()}`, {
        method: "POST",
        body: JSON.stringify({ valores, base: card.hash }),
      });
      descartarControles();
      aplicarDs(ds);
    } catch (e) {
      const err = el("ds-ctl-err");
      if (err) err.textContent = /mudou desde a leitura/.test(e.message) ? "O card mudou no disco. Recarreguei — ajuste de novo." : e.message;
      if (/mudou desde a leitura/.test(e.message)) await recarregar({ animar: false });
    }
  }

  /* ---------- versões ---------- */

  async function pintarVersoes(corpo, card) {
    corpo.innerHTML = `<p class="ds-painel-vazio">Carregando…</p>`;
    let lista = [];
    try {
      lista = await req(`/v1/ds/cards/${encodeURIComponent(card.id)}/versoes?${qs()}`);
    } catch (e) {
      corpo.innerHTML = `<p class="ag-err"></p>`;
      corpo.querySelector("p").textContent = e.message;
      return;
    }
    if (editando !== card.id || painelModo !== "versoes") return;
    corpo.innerHTML = lista.length
      ? `<p class="ds-painel-vazio">Versões anteriores deste card (as ${lista.length} mais recentes). Restaurar guarda a atual antes.</p>`
      : `<p class="ds-painel-vazio">Nenhuma versão anterior ainda. Cada vez que a IA reescreve o card, a versão de antes fica aqui.</p>`;
    for (const v of lista) {
      const linha = doc.createElement("div");
      linha.className = "ds-versao";
      const quando = new Date(v.em);
      linha.innerHTML = `<span></span><button type="button" class="ghost">Restaurar</button>`;
      linha.querySelector("span").textContent = Number.isNaN(quando.getTime()) ? v.nome : quando.toLocaleString("pt-BR");
      linha.querySelector("button").addEventListener("click", async () => {
        try {
          aplicarDs(await req(`/v1/ds/cards/${encodeURIComponent(card.id)}/restaurar?${qs()}`, { method: "POST", body: JSON.stringify({ versao: v.nome }) }));
          pintarPainel();
        } catch (e) {
          erroTopo(e.message);
        }
      });
      corpo.append(linha);
    }
  }

  /** Troca de projeto: o SSE e os cards do projeto anterior não valem mais. */
  function trocouProjeto() {
    parar();
    projetoCarregado = "";
    estado = { sistemas: [], ativo: null, ds: null };
    geracao = null;
  }

  /* ---------- geração por IA ---------- */

  let progressoDispensado = "";

  function aplicarGeracao(g) {
    const antes = geracao;
    geracao = g;
    pintarProgresso();
    // esqueleto dos cards previstos aparece/some com o plano e o fim da geração; no meio, só o
    // status da etapa muda (sem repintar o board)
    if (!estado.ds) return;
    if (!antes || antes.id !== g.id || antes.status !== g.status) {
      pintar();
      return;
    }
    for (const f of frames.values()) {
      if (!f.card?.pendente) continue;
      const e = (g.etapas || []).find((x) => (x.cards || []).includes(f.card.id));
      f.cartao.dataset.etapa = e?.status || "pendente";
    }
  }

  const ROTULO_ETAPA = {
    pendente: "na fila",
    rodando: "gerando",
    corrigindo: "corrigindo",
    ok: "pronto",
    erro: "erro",
    cancelado: "cancelado",
  };

  function tituloDoProgresso(g) {
    if (g.status === "rodando") {
      const feitos = g.etapas.filter((e) => e.status === "ok").length;
      return `Gerando com IA · ${feitos}/${g.etapas.length}`;
    }
    if (g.status === "concluida") return g.erro ? "Geração concluída com pendências" : "Geração concluída";
    return g.status === "cancelada" ? "Geração cancelada" : "Geração falhou";
  }

  function pintarProgresso() {
    const caixa = el("ds-progresso");
    const rodando = geracao?.status === "rodando";
    el("ds-btn-gerar").disabled = rodando;
    if (!geracao || progressoDispensado === geracao.id) {
      caixa.classList.add("hidden");
      return;
    }
    caixa.classList.remove("hidden");
    caixa.dataset.status = geracao.status;
    el("ds-progresso-tit").textContent = tituloDoProgresso(geracao);
    el("ds-progresso-cancelar").classList.toggle("hidden", !rodando);
    el("ds-progresso-fechar").classList.toggle("hidden", rodando);
    const lista = el("ds-progresso-etapas");
    lista.innerHTML = "";
    for (const e of geracao.etapas) {
      // conversa da etapa não fica na barra lateral (é trabalho desta tela): o chip é o caminho
      const chip = doc.createElement(e.threadId ? "button" : "span");
      if (e.threadId) {
        chip.type = "button";
        chip.title = "Ver a conversa deste agente";
        chip.addEventListener("click", () => aoAbrirConversa(e.threadId));
      }
      chip.className = "ds-etapa";
      chip.dataset.status = e.status;
      const total = e.cards?.length || 0;
      const contagem = total ? ` ${e.prontos?.length || 0}/${total}` : "";
      chip.textContent = `${e.titulo} · ${ROTULO_ETAPA[e.status] || e.status}${contagem}`;
      if (e.erro) chip.title = e.erro;
      lista.append(chip);
    }
    const erro = el("ds-progresso-erro");
    erro.textContent = geracao.erro || "";
    erro.classList.toggle("hidden", !geracao.erro);
  }

  async function mostrarGerar() {
    const caixa = el("ds-gerar");
    if (!caixa.classList.contains("hidden")) {
      caixa.classList.add("hidden");
      return;
    }
    el("ds-gerar-err").textContent = "";
    const sel = el("ds-gerar-conta");
    sel.innerHTML = "";
    const perfis = getProfiles() || [];
    // sem conta neste motor (ex.: `run.bat dev`, que tem motor próprio): explica em vez de lista vazia
    el("ds-gerar-sem-conta").classList.toggle("hidden", perfis.length > 0);
    for (const p of perfis) {
      const o = doc.createElement("option");
      o.value = p.id;
      o.textContent = `${p.nickname || p.id} · ${p.engine}${p.status === "ready" ? "" : " (sem login)"}`;
      o.selected = p.id === getProfileId();
      sel.append(o);
    }
    // plano B (ds-sem-ia.ts no daemon): tokens + DESIGN.md por regra, sem conta e sem quota
    const semIa = doc.createElement("option");
    semIa.value = "";
    semIa.textContent = "Sem IA · só tokens e DESIGN.md, por regra";
    semIa.selected = !perfis.length;
    sel.append(semIa);
    if (!planoSecoes) {
      try {
        planoSecoes = (await req("/v1/ds/gerar/plano")).secoes;
      } catch (e) {
        el("ds-gerar-err").textContent = e.message;
        planoSecoes = [];
      }
    }
    const lista = el("ds-gerar-secoes");
    lista.innerHTML = "";
    for (const s of planoSecoes) {
      const l = doc.createElement("label");
      l.className = "ds-check";
      l.innerHTML = `<input type="checkbox" checked /><span></span>`;
      const input = l.querySelector("input");
      input.value = s.id;
      input.dataset.cards = String(s.cards);
      l.querySelector("span").textContent = `${s.titulo} (${s.cards})`;
      lista.append(l);
    }
    caixa.classList.remove("hidden");
    pintarReferencia();
    pintarEstimativa();
    el("ds-gerar-brief").focus({ preventScroll: true });
  }

  function secoesMarcadas() {
    return [...el("ds-gerar-secoes").querySelectorAll("input:checked")];
  }

  function pintarEstimativa() {
    const marcadas = secoesMarcadas();
    if (!el("ds-gerar-conta").value) {
      const tokens = el("ds-gerar-tokens").checked;
      el("ds-gerar-estimativa").textContent = tokens
        ? `Sem IA: tokens e DESIGN.md saem por regra, na hora e sem gastar quota${marcadas.length ? ". As seções de cards ficam de fora: precisam de uma conta." : "."}`
        : "Sem IA só dá pra gerar os tokens e as regras de uso.";
      el("ds-gerar-ir").disabled = !tokens;
      return;
    }
    const conversas = marcadas.length + (el("ds-gerar-tokens").checked ? 1 : 0);
    const cards = marcadas.reduce((n, i) => n + Number(i.dataset.cards || 0), 0);
    const paralelo = Math.max(1, Math.min(6, Number(el("ds-gerar-paralelo").value) || 3));
    el("ds-gerar-estimativa").textContent = conversas
      ? `≈ ${conversas} conversa${conversas > 1 ? "s" : ""} com o agente e ${cards} card${cards === 1 ? "" : "s"}, até ${paralelo} ao mesmo tempo. Tudo gasta quota da conta escolhida.`
      : "Escolha ao menos uma seção ou os tokens.";
    el("ds-gerar-ir").disabled = conversas === 0;
  }

  /** Página capturada no Browser (ds-extrator.js), esperando virar referência da geração. */
  let referencia = null;

  function pintarReferencia() {
    el("ds-gerar-ref").classList.toggle("hidden", !referencia);
    if (!referencia) return;
    el("ds-gerar-ref-txt").textContent = resumoCurto(referencia);
    const img = el("ds-gerar-ref-img");
    img.classList.toggle("hidden", !referencia.screenshot);
    if (referencia.screenshot) img.src = `data:${referencia.screenshot.mime};base64,${referencia.screenshot.data}`;
  }

  /**
   * Chamado pelo botão do Browser. Sem design system no projeto ainda, a referência espera: o
   * formulário abre sozinho logo depois de criar.
   */
  async function usarReferencia(ref) {
    referencia = ref;
    await abrir();
    if (!estado.ds) {
      erroTopo("");
      el("ds-vazio-err").textContent = "Crie o design system: a página capturada fica guardada pra geração.";
      return;
    }
    el("ds-gerar").classList.add("hidden");
    await mostrarGerar();
    el("ds-gerar-url").value = ref.url || "";
  }

  async function gerar() {
    const corpo = {
      ...(referencia ? { referencia } : {}),
      profileId: el("ds-gerar-conta").value,
      brief: el("ds-gerar-brief").value,
      usarCodigo: el("ds-gerar-codigo").checked,
      url: el("ds-gerar-url").value.trim(),
      gerarTokens: el("ds-gerar-tokens").checked,
      secoes: secoesMarcadas().map((i) => i.value),
      paralelo: Number(el("ds-gerar-paralelo").value) || 3,
    };
    el("ds-gerar-err").textContent = "";
    try {
      const r = await req(`/v1/ds/gerar?${qs()}`, { method: "POST", body: JSON.stringify(corpo) });
      el("ds-gerar").classList.add("hidden");
      progressoDispensado = "";
      referencia = null;
      aplicarGeracao(r.geracao);
    } catch (e) {
      el("ds-gerar-err").textContent = e.message;
    }
  }

  async function cancelarGeracao() {
    try {
      const r = await req(`/v1/ds/gerar/cancelar?${qs()}`, { method: "POST", body: "{}" });
      if (r.geracao) aplicarGeracao(r.geracao);
    } catch (e) {
      erroTopo(e.message);
    }
  }

  return {
    abrir,
    recarregar,
    parar,
    trocouProjeto,
    ajustar,
    _estado: () => estado,
    _vista: () => vista,
    _geracao: () => geracao,
    usarReferencia,
    focarCard,
  };
}
