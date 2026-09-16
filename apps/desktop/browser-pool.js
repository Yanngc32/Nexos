/**
 * Pool de `<webview>` do painel Browser: um guest por aba, vivo mesmo fora de
 * foco. Trocar de conversa NÃO atribui `src` de novo — só mostra o guest que
 * já tava carregado. `display:none` no ancestral mata o processo do guest no
 * Electron; por isso o pool só usa `.stowed` (visibility), nunca some do layout.
 *
 * `getURL`/`canGoBack` no `<webview>` são IPC síncrono pro guest — no caminho
 * de trocar de chat isso trava a UI. `hrefDoGuest` lê `dataset.href`.
 */

export function hrefDoGuest(el) {
  if (!el) return "about:blank";
  return el.dataset?.href || el.src || "about:blank";
}

export function mesmoHref(a, b) {
  const na = String(a || "about:blank");
  const nb = String(b || "about:blank");
  if (na === nb) return true;
  try {
    return new URL(na).href === new URL(nb).href;
  } catch {
    return false;
  }
}

function chave(threadId, tabId) {
  return `${threadId || "_none"}::${tabId}`;
}

export function criarBrowserPool({
  stage,
  criarGuest,
  onIpc,
  onDomReady,
  onNavigate,
  maxVivos = 4,
  podeDescartar,
} = {}) {
  const vivos = new Map();
  let visivelEl = null;

  function fabricar() {
    if (typeof criarGuest === "function") return criarGuest();
    return document.createElement("webview");
  }

  function tocar(k, el) {
    if (vivos.get(k) !== el) return;
    vivos.delete(k);
    vivos.set(k, el);
  }

  function stow(el) {
    if (!el) return;
    el.classList.add("stowed");
    if (visivelEl === el) visivelEl = null;
  }

  function anexar(el, threadId, tabId) {
    el.dataset.threadId = threadId || "";
    el.dataset.tabId = tabId;
    el.dataset.href = el.dataset.href || "about:blank";
    el.classList.add("stowed");
    el.addEventListener("ipc-message", (e) => onIpc?.(e, { threadId, tabId, el }));
    el.addEventListener("dom-ready", () => onDomReady?.({ threadId, tabId, el }));
    const aoNavegar = (e) => {
      const href = e.url || hrefDoGuest(el);
      el.dataset.href = href;
      onNavigate?.({ threadId, tabId, el, url: href });
    };
    el.addEventListener("did-navigate", aoNavegar);
    el.addEventListener("did-navigate-in-page", aoNavegar);
  }

  function obter(threadId, tabId, url) {
    const k = chave(threadId, tabId);
    let el = vivos.get(k);
    if (el) {
      tocar(k, el);
      return el;
    }
    el = fabricar();
    if (threadId) el.setAttribute("partition", `persist:nexo-b-${threadId}`);
    anexar(el, threadId, tabId);
    if (!el.getAttribute("src") && !el.src) {
      const href = url || "about:blank";
      el.dataset.href = href;
      el.setAttribute("src", href);
    }
    stage?.append(el);
    vivos.set(k, el);
    podar(threadId);
    return el;
  }

  function mostrar(threadId, tabId, url) {
    const alvo = obter(threadId, tabId, url);
    if (visivelEl === alvo) {
      alvo.classList.remove("stowed");
      visivelEl = alvo;
      return alvo;
    }
    stow(visivelEl);
    alvo.classList.remove("stowed");
    visivelEl = alvo;
    return alvo;
  }

  function esconder() {
    stow(visivelEl);
  }

  /**
   * Navega só se a URL mudou. `force` é o botão Recarregar — aí sim mata o
   * documento. Troca de chat nunca passa `force`.
   */
  function navegar(threadId, tabId, url, { force } = {}) {
    const href = url || "about:blank";
    const el = obter(threadId, tabId, href);
    if (!force && mesmoHref(hrefDoGuest(el), href)) return { mudou: false, el };
    el.dataset.href = href;
    if (force && typeof el.loadURL !== "function") {
      el.src = "about:blank";
      setTimeout(() => {
        el.src = href;
      }, 0);
      return { mudou: true, el };
    }
    if (typeof el.loadURL === "function") {
      const p = el.loadURL(href);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else if (el.src !== href) {
      el.src = href;
    }
    return { mudou: true, el };
  }

  function visivel() {
    if (visivelEl && !visivelEl.classList.contains("stowed")) return visivelEl;
    return null;
  }

  function daThread(threadId) {
    const prefix = `${threadId || "_none"}::`;
    for (const [k, el] of vivos) {
      if (k.startsWith(prefix)) return el;
    }
    return null;
  }

  function daAba(threadId, tabId) {
    return vivos.get(chave(threadId, tabId)) || null;
  }

  function descartar(threadId, tabId) {
    const k = chave(threadId, tabId);
    const el = vivos.get(k);
    if (!el) return;
    if (visivelEl === el) visivelEl = null;
    vivos.delete(k);
    el.remove();
  }

  function descartarThread(threadId) {
    const prefix = `${threadId || "_none"}::`;
    for (const k of [...vivos.keys()]) {
      if (k.startsWith(prefix)) {
        const el = vivos.get(k);
        if (visivelEl === el) visivelEl = null;
        el?.remove();
        vivos.delete(k);
      }
    }
  }

  function podar(manterThreadId) {
    if (vivos.size <= maxVivos) return;
    const extras = [];
    for (const [k, el] of vivos) {
      const tid = k.split("::")[0];
      if (tid === (manterThreadId || "_none")) continue;
      if (podeDescartar && !podeDescartar(tid)) continue;
      extras.push([k, el]);
    }
    const excesso = vivos.size - maxVivos;
    for (let i = 0; i < excesso && i < extras.length; i++) {
      const [k, el] = extras[i];
      if (visivelEl === el) visivelEl = null;
      vivos.delete(k);
      el.remove();
    }
  }

  return { obter, mostrar, esconder, navegar, visivel, daThread, daAba, descartar, descartarThread, hrefDoGuest };
}
