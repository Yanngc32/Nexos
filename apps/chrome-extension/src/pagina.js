/**
 * Roda DENTRO da aba (mundo isolado do content script, a página não enxerga nada daqui). O build
 * junta isto com o leitor do painel Browser (`navegador-selector.cjs`), o markdown
 * (`pagina-markdown.js`), Readability e Turndown num `pagina-bundle.js` protegido contra injeção
 * dupla — cada comando reinjeta o arquivo e só a 1ª vez vale.
 *
 * Globais que o bundle entrega antes deste trecho: `__sel`, `__md`, `Readability`,
 * `TurndownService`.
 */
/* global __sel, __md, Readability, TurndownService */

let refs = new Map();
let proximoRef = 1;

function ler() {
  refs = new Map();
  proximoRef = 1;
  const raiz = document.body || document.documentElement;
  const { itens: elementos, truncado } = __sel.elementosInterativosComInfo(raiz, window);
  const itens = elementos.map((el) => {
    const ref = `ref_${proximoRef++}`;
    refs.set(ref, el);
    return { ref, papel: __sel.papelDe(el), texto: __sel.textoDe(el) };
  });
  if (truncado) itens.push({ ref: "", papel: "aviso", texto: `(lista cortada em ${__sel.MAX_ITENS} itens — role a página ou refine o que procura)` });
  return itens;
}

function elDo(ref) {
  const el = refs.get(ref);
  if (!el || !el.isConnected) throw new Error(`ref inválido: ${ref} — releia a página (nexo_chrome_ler)`);
  return el;
}

/* ---------- camada visual: destaque do alvo + pílula "Nexos mexendo nesta aba" ---------- */

let host = null;
let sombra = null;
let pilulaTimer = 0;

function garantirHost() {
  if (host?.isConnected) return;
  host = document.createElement("nexos-agente");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  sombra = host.attachShadow({ mode: "closed" });
  // hex = valores dos tokens do DS (primary, primary-text, surface-3, border-strong...): dentro da
  // página alheia não existe `var(--color-*)` pra ler
  sombra.innerHTML = `<style>
    :host{all:initial}
    .alvo{position:fixed;border:2px dashed #b7a3e3;border-radius:4px;transition:opacity .18s;pointer-events:none}
    .ref{position:absolute;top:-22px;left:-2px;background:#7c5cbf;color:#fff;font:500 10px/1 "JetBrains Mono",ui-monospace,monospace;padding:4px 6px;border-radius:4px;white-space:nowrap}
    .pil{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:8px;background:#26262d;color:#ececef;border:1px solid #31313a;border-radius:999px;padding:4px 4px 4px 12px;font:400 12px/1.45 Inter,system-ui,"Segoe UI",sans-serif;box-shadow:0 1px 3px #00000059;pointer-events:auto;transition:opacity .3s}
    .pil b{color:#b7a3e3;font-weight:600}
    .pil button{all:unset;cursor:pointer;background:#202026;border-radius:999px;padding:4px 12px;font:500 12px/1.45 Inter,system-ui,"Segoe UI",sans-serif;color:#ececef}
    .pil button:hover{background:#31313a}
    .pil button:focus-visible{outline:2px solid #b7a3e3;outline-offset:2px}
    .oculta{opacity:0;pointer-events:none}
  </style><div class="pil oculta" role="status"><b aria-hidden="true">✦</b><span>Nexos mexendo nesta aba</span><button type="button">❚❚ Pausar</button></div>`;
  sombra.querySelector("button").addEventListener("click", () => {
    chrome.runtime.sendMessage({ tipo: "pausar" });
    sombra.querySelector(".pil span").textContent = "Agente pausado";
    sombra.querySelector(".pil button").remove();
  });
  (document.body || document.documentElement).appendChild(host);
}

/** Mostra a pílula e esconde de novo depois de 10 s sem ação. */
function pilula() {
  garantirHost();
  const p = sombra.querySelector(".pil");
  p.classList.remove("oculta");
  clearTimeout(pilulaTimer);
  pilulaTimer = setTimeout(() => p.classList.add("oculta"), 10_000);
}

function destacar(el, rotulo) {
  garantirHost();
  const r = el.getBoundingClientRect();
  const d = document.createElement("div");
  d.className = "alvo";
  Object.assign(d.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  const tag = document.createElement("span");
  tag.className = "ref";
  tag.textContent = rotulo;
  d.appendChild(tag);
  sombra.appendChild(d);
  setTimeout(() => {
    d.style.opacity = "0";
    setTimeout(() => d.remove(), 200);
  }, 1200);
}

function trazerPraVista(el) {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
}

/* ---------- ações ---------- */

function clicarSintetico(ref) {
  const el = elDo(ref);
  trazerPraVista(el);
  destacar(el, `${ref} · clicando`);
  const opts = { bubbles: true, cancelable: true, view: window };
  const Ptr = typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Ptr("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.focus?.();
  el.dispatchEvent(new Ptr("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return "clicado";
}

/** Pro clique/digitação REAL (CDP): traz pra vista, destaca e devolve o centro em px da viewport. */
function mirar(ref, rotulo, focar) {
  const el = elDo(ref);
  trazerPraVista(el);
  if (focar) {
    el.focus?.();
    if ("select" in el && typeof el.select === "function") el.select();
    else if (el.isContentEditable) document.execCommand("selectAll");
  }
  destacar(el, `${ref} · ${rotulo}`);
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

/** Valor por setter NATIVO: React/Vue guardam o valor antigo no próprio elemento e ignoram `el.value = x`. */
function digitarSintetico(ref, texto, enter) {
  const el = elDo(ref);
  trazerPraVista(el);
  destacar(el, `${ref} · digitando`);
  el.focus?.();
  if (el.isContentEditable) {
    document.execCommand("selectAll");
    document.execCommand("insertText", false, texto);
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, texto);
    else el.value = texto;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: texto }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (enter) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    if (el.form && typeof el.form.requestSubmit === "function") el.form.requestSubmit();
  }
  return enter ? "digitado e Enter" : "digitado";
}

function rolar({ ref, direcao }) {
  if (ref) {
    const el = elDo(ref);
    trazerPraVista(el);
    destacar(el, ref);
    return `rolado até ${ref}`;
  }
  const alt = window.innerHeight * 0.85;
  if (direcao === "topo") window.scrollTo({ top: 0, behavior: "instant" });
  else if (direcao === "fim") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  else window.scrollBy({ top: direcao === "cima" ? -alt : alt, behavior: "instant" });
  const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  return `rolado (${Math.round((window.scrollY / max) * 100)}% da página)`;
}

function markdown() {
  return __md.paginaParaMarkdown(__md.coletarDaPagina(), { Readability, TurndownService, DOMParser });
}

globalThis.__nexo = { ler, clicarSintetico, mirar, digitarSintetico, rolar, markdown, pilula };
