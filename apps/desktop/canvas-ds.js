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

const GRUPOS = [
  { id: "cor", titulo: "Cores", teste: (v) => v.tipo === "color" || /^colou?rs?\./.test(v.caminho) },
  { id: "tipo", titulo: "Tipografia", teste: (v) => /^(font|typography|type|text)\b/.test(v.caminho) || /^font/.test(v.tipo || "") },
  { id: "espaco", titulo: "Espaçamento", teste: (v) => /^(space|spacing|gap|size)\b/.test(v.caminho) },
  { id: "forma", titulo: "Raio & sombra", teste: (v) => /radius|radii|shadow|elevation/.test(v.caminho) || v.tipo === "shadow" },
  { id: "motion", titulo: "Motion", teste: (v) => /^(motion|duration|ease|easing|transition)\b/.test(v.caminho) || v.tipo === "duration" || v.tipo === "cubicBezier" },
];

/** Separa as variáveis nos grupos dos cards de Fundamentos. Cada variável cai no PRIMEIRO grupo que casa. */
export function agruparVars(vars) {
  const out = new Map(GRUPOS.map((g) => [g.id, []]));
  out.set("outros", []);
  for (const v of vars || []) {
    const g = GRUPOS.find((x) => x.teste(v));
    out.get(g ? g.id : "outros").push(v);
  }
  return out;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Cards de Fundamentos: gerados aqui a partir dos tokens, não de arquivo. Usam só `var()` — trocar
 * um token atualiza o card na hora, como qualquer outro.
 */
export function cardsDeFundamentos(vars) {
  const g = agruparVars(vars);
  const cards = [];
  const rotulo = (v) => `<div class="f-nome">${esc(v.caminho)}</div><div class="f-val">${esc(v.valor)}</div>`;
  const base = `<style>
    .f-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}
    .f-nome{font:600 12px/1.3 system-ui,sans-serif;opacity:.9;margin-top:8px;word-break:break-all}
    .f-val{font:11px/1.3 ui-monospace,monospace;opacity:.6;margin-top:2px;word-break:break-all}
    .f-lin{display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid rgba(127,127,127,.18)}
    .f-lin:last-child{border-bottom:0}
    .f-lin .f-nome,.f-lin .f-val{margin:0;min-width:150px}
  </style>`;
  if (g.get("cor").length) {
    cards.push({
      id: "fund-cores",
      titulo: "Cores",
      subtitulo: "Superfícies, marca e semânticas",
      grupo: "cor",
      html: `${base}<div class="f-grade">${g
        .get("cor")
        .map(
          (v) =>
            `<div><div style="height:64px;border-radius:8px;background:var(${v.nome});border:1px solid rgba(127,127,127,.25)"></div>${rotulo(v)}</div>`,
        )
        .join("")}</div>`,
    });
  }
  if (g.get("tipo").length) {
    const linhas = g
      .get("tipo")
      .map((v) => {
        let amostra = "";
        if (/family/i.test(v.caminho) || v.tipo === "fontFamily") amostra = `<span style="font-family:var(${v.nome});font-size:22px">Aa Bb Cc 0123</span>`;
        else if (/weight/i.test(v.caminho) || v.tipo === "fontWeight") amostra = `<span style="font-weight:var(${v.nome});font-size:18px">Peso</span>`;
        else if (/size/i.test(v.caminho) || v.tipo === "dimension") amostra = `<span style="font-size:var(${v.nome})">O rato roeu</span>`;
        else if (/line|leading/i.test(v.caminho)) amostra = `<span style="line-height:var(${v.nome})">Linha</span>`;
        return `<div class="f-lin">${rotulo(v)}${amostra}</div>`;
      })
      .join("");
    cards.push({ id: "fund-tipografia", titulo: "Tipografia", subtitulo: "Famílias, escala e pesos", grupo: "tipo", html: `${base}${linhas}` });
  }
  if (g.get("espaco").length) {
    cards.push({
      id: "fund-espaco",
      titulo: "Espaçamento",
      subtitulo: "Escala de espaço",
      grupo: "espaco",
      html: `${base}${g
        .get("espaco")
        .map((v) => `<div class="f-lin">${rotulo(v)}<div style="height:12px;width:var(${v.nome});background:currentColor;opacity:.55;border-radius:2px"></div></div>`)
        .join("")}`,
    });
  }
  if (g.get("forma").length) {
    cards.push({
      id: "fund-forma",
      titulo: "Raio & sombra",
      subtitulo: "Cantos e elevação",
      grupo: "forma",
      html: `${base}<div class="f-grade">${g
        .get("forma")
        .map((v) => {
          const sombra = v.tipo === "shadow" || /shadow|elevation/.test(v.caminho);
          const estilo = sombra
            ? `box-shadow:var(${v.nome});border-radius:8px`
            : `border-radius:var(${v.nome});border:2px solid currentColor;opacity:.8`;
          return `<div><div style="height:64px;${estilo};background:rgba(127,127,127,.12)"></div>${rotulo(v)}</div>`;
        })
        .join("")}</div>`,
    });
  }
  const resto = [...g.get("motion"), ...g.get("outros")];
  if (resto.length) {
    cards.push({
      id: "fund-outros",
      titulo: "Motion & outros",
      subtitulo: "Duração, curva e demais tokens",
      grupo: "motion",
      html: `${base}${resto.map((v) => `<div class="f-lin">${rotulo(v)}</div>`).join("")}`,
    });
  }
  return cards;
}

const CSS_BASE = `html,body{margin:0}
body{padding:20px;box-sizing:border-box;min-height:40px;
  background:var(--color-bg,var(--color-background,var(--bg,transparent)));
  color:var(--color-text,var(--color-fg,var(--text,currentColor)));
  font-family:var(--font-family-body,var(--font-body,system-ui,sans-serif))}
[data-ds-anim]{transition:opacity .28s ease,transform .28s ease}`;

/** Esqueleto do documento do card. O conteúdo entra depois, por `body.innerHTML`. */
export function montarSrcdoc({ css, baseHref }) {
  const base = baseHref ? `<base href="${esc(baseHref)}">` : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">${base}
<style id="ds-tokens">${css || ""}</style><style id="ds-base">${CSS_BASE}</style><style id="ds-override"></style>
</head><body></body></html>`;
}

/** `file:///C:/…/pasta/cards/` — base pra imagem relativa do card (logo do projeto). */
export function baseHrefDaPasta(pastaAbs) {
  if (!pastaAbs) return "";
  const p = String(pastaAbs).replace(/\\/g, "/").replace(/\/+$/, "");
  const comBarra = p.startsWith("/") ? p : `/${p}`;
  return `file://${encodeURI(comBarra)}/cards/`;
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
  pickFolder = async () => null,
  avisar = (msg) => Promise.resolve(window.alert(msg)),
  fetchImpl = (...a) => fetch(...a),
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
  let painelModo = "tokens"; // "tokens" | "avisos"
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
    vazio.classList.toggle("hidden", !getProjectPath() || !!ds);
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
    if (editando) pintarPainel();
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
    el("ds-pasta").textContent = ds ? ds.pasta : "";
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
    const fund = cardsDeFundamentos(ds.vars).map((c) => ({ ...c, secao: "fundamentos", gerado: true, lint: [] }));
    return [...fund, ...ds.cards];
  }

  function secoesDoBoard(ds) {
    return [{ id: "fundamentos", titulo: "Fundamentos" }, ...ds.secoes.filter((s) => s.id !== "fundamentos")];
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
      anteriorEl = bloco;
    }

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
      void atualizarCartao(f, card, ds, { animar, mudadas });
    }
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
        <button type="button" class="ghost ds-card-edit">Editar</button>
      </header>
      <div class="ds-card-corpo"><iframe class="ds-card-frame" sandbox="allow-same-origin" tabindex="-1"></iframe></div>`;
    const frame = cartao.querySelector("iframe");
    cartao.querySelector(".ds-card-edit").addEventListener("click", () => abrirPainel(card.id, "tokens"));
    cartao.querySelector(".ds-card-lint").addEventListener("click", () => abrirPainel(card.id, "avisos"));
    return { cartao, frame, hash: null, html: "", pronto: null, css: "" };
  }

  /** Garante o documento base no iframe; resolve quando dá pra escrever nele. */
  function prepararFrame(f, ds) {
    const base = baseHrefDaPasta(ds.pastaAbs);
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
      f.frame.srcdoc = montarSrcdoc({ css: ds.css, baseHref: base });
    });
    return f.pronto;
  }

  /** Eventos do documento do card que o board precisa: roda do mouse (pan/zoom) e altura. */
  function ligarFrame(f) {
    const d = f.frame.contentDocument;
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

    await prepararFrame(f, ds);
    aplicarVarsNoFrame(f, ds);
    const d = f.frame.contentDocument;
    const body = d?.body;
    if (!body) return;

    const html = card.html;
    if (f.html !== html) {
      const primeira = f.hash === null;
      const antigos = primeira ? [] : digitaisDe(body);
      body.innerHTML = html;
      f.html = html;
      f.hash = card.hash ?? html;
      medir(f);
      setTimeout(() => medir(f), 60);
      if (animar && !primeira) enfileirar(f, elementosNovos(antigos, body));
    } else if (animar && mudadas.size && [...tokensUsados(html)].some((n) => mudadas.has(n))) {
      pulsar(f);
    }
  }

  function limparFrames() {
    for (const f of frames.values()) {
      f.ro?.disconnect?.();
      f.cartao.remove();
    }
    frames.clear();
    const board = el("ds-board");
    if (board) board.innerHTML = "";
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
  function retanguloNaTela(f, alvo) {
    const vp = el("ds-viewport").getBoundingClientRect();
    const fr = f.frame.getBoundingClientRect();
    const k = f.frame.offsetWidth ? fr.width / f.frame.offsetWidth : 1;
    const r = alvo.getBoundingClientRect();
    return { x: fr.left - vp.left + r.left * k, y: fr.top - vp.top + r.top * k, w: r.width * k, h: r.height * k };
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
        const r = retanguloNaTela(f, alvo);
        cursor.style.transform = `translate(${r.x + Math.min(r.w, 24)}px, ${r.y + Math.min(r.h, 18)}px)`;
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
      const g = agruparVars(ds.vars);
      return card.grupo === "motion" ? [...g.get("motion"), ...g.get("outros")] : g.get(card.grupo) || [];
    }
    const usados = tokensUsados(card.html);
    return ds.vars.filter((v) => usados.has(v.nome));
  }

  function abrirPainel(id, modo) {
    editando = id;
    painelModo = modo;
    el("ds-painel").classList.remove("hidden");
    for (const f of frames.values()) f.cartao.classList.toggle("editando", f.card?.id === id);
    pintarPainel();
  }

  function fecharPainel() {
    editando = null;
    el("ds-painel")?.classList.add("hidden");
    for (const f of frames.values()) f.cartao.classList.remove("editando");
  }

  function pintarPainel() {
    const card = cardPorId(editando);
    if (!card) {
      fecharPainel();
      return;
    }
    el("ds-painel-tit").textContent = card.titulo;
    el("ds-painel-tab-tokens").dataset.on = painelModo === "tokens" ? "1" : "0";
    el("ds-painel-tab-avisos").dataset.on = painelModo === "avisos" ? "1" : "0";
    const avisos = card.gerado ? estado.ds.tokensLint : card.lint;
    el("ds-painel-tab-avisos").textContent = avisos.length ? `Avisos (${avisos.length})` : "Avisos";
    const corpo = el("ds-painel-corpo");
    corpo.innerHTML = "";
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
    const pasta = el(`${prefixo}-pasta`).value.trim() || "design-system";
    el(`${prefixo}-err`).textContent = "";
    try {
      estado = await req(`/v1/ds?${qs()}`, { method: "POST", body: JSON.stringify({ nome, pasta }) });
      ajustouUmaVez = false;
      limparFrames();
      pintar();
      ouvir();
      el("ds-novo")?.classList.add("hidden");
    } catch (e) {
      el(`${prefixo}-err`).textContent = e.message;
    }
  }

  async function escolherPasta(prefixo) {
    const p = await pickFolder();
    if (p) el(`${prefixo}-pasta`).value = p;
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

  function mostrarNovo() {
    const caixa = el("ds-novo");
    caixa.classList.toggle("hidden");
    if (!caixa.classList.contains("hidden")) el("ds-novo-nome").focus();
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
      el(`${prefixo}-escolher`).addEventListener("click", () => void escolherPasta(prefixo));
    }
    el("ds-painel-fechar").addEventListener("click", fecharPainel);
    el("ds-painel-tab-tokens").addEventListener("click", () => {
      painelModo = "tokens";
      pintarPainel();
    });
    el("ds-painel-tab-avisos").addEventListener("click", () => {
      painelModo = "avisos";
      pintarPainel();
    });
  }

  /** Troca de projeto: o SSE e os cards do projeto anterior não valem mais. */
  function trocouProjeto() {
    parar();
    projetoCarregado = "";
    estado = { sistemas: [], ativo: null, ds: null };
  }

  return { abrir, recarregar, parar, trocouProjeto, ajustar, _estado: () => estado, _vista: () => vista };
}
