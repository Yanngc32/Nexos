/**
 * Sessão de preview por conversa: abas abertas + recents de URL.
 *
 * O painel de trabalho é UM por thread — voltar pra conversa restaura o que
 * estava aberto, sem o Browser nascer de novo. Recents são globais (igual à
 * paleta do Cursor): localhost:5173 usado em qualquer chat aparece na lista.
 */
import { pareceUrl, urlDePreview } from "./url.js";

export const KIND_UNICO = new Set(["file", "terminal", "canvas", "graph", "agentes", "tarefas", "ds", "planejamento"]);
export const KIND_TAB = new Set(["file", "terminal", "browser", "canvas", "graph", "agentes", "tarefas", "ds", "planejamento"]);

const NOMES = {
  file: "Arquivos",
  terminal: "Terminal",
  browser: "Browser",
  canvas: "Canvas",
  graph: "Memória",
  agentes: "Agentes",
  tarefas: "Tarefas",
  ds: "Design System",
  planejamento: "Planejamento",
};

let seq = 0;
function newId() {
  seq += 1;
  return `tab-${Date.now().toString(36)}-${seq}`;
}

export function chaveWork(threadId, projectPath) {
  if (threadId) return String(threadId);
  const p = String(projectPath || "").trim();
  return p ? `proj:${p}` : "_none";
}

export function sessaoVazia() {
  return { tabs: [], activeId: "" };
}

function tabValida(t) {
  return t && typeof t === "object" && typeof t.id === "string" && KIND_TAB.has(t.kind);
}

export function hidratarSessao(raw) {
  if (!raw || typeof raw !== "object") return sessaoVazia();
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).filter(tabValida).map((t) => ({
    id: t.id,
    kind: t.kind,
    url: t.kind === "browser" ? String(t.url || "about:blank") : undefined,
  }));
  const activeId = tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0]?.id || "";
  return { tabs, activeId };
}

export function abaAtiva(sessao) {
  if (!sessao?.tabs?.length) return null;
  return sessao.tabs.find((t) => t.id === sessao.activeId) || sessao.tabs[0] || null;
}

export function ativarAba(sessao, id) {
  if (!sessao.tabs.some((t) => t.id === id)) return abaAtiva(sessao);
  sessao.activeId = id;
  return abaAtiva(sessao);
}

/**
 * Abre ou foca uma aba. Módulos únicos (Arquivos, Terminal, …) não duplicam.
 * Browser: mesma URL foca a aba existente, a não ser que `nova` peça outra.
 */
export function abrirAba(sessao, kind, { url, nova } = {}) {
  if (!KIND_TAB.has(kind)) return abaAtiva(sessao);
  if (kind === "browser") {
    const href = url ? urlDePreview(url) : "";
    if (href && href !== "about:blank" && !nova) {
      const mesma = sessao.tabs.find((t) => t.kind === "browser" && t.url === href);
      if (mesma) {
        sessao.activeId = mesma.id;
        return mesma;
      }
      const vazia = sessao.tabs.find((t) => t.kind === "browser" && (!t.url || t.url === "about:blank"));
      if (vazia) {
        vazia.url = href;
        sessao.activeId = vazia.id;
        return vazia;
      }
    }
    if (!nova && !href) {
      const existente = sessao.tabs.find((t) => t.kind === "browser");
      if (existente) {
        sessao.activeId = existente.id;
        return existente;
      }
    }
    const tab = { id: newId(), kind: "browser", url: href || "about:blank" };
    sessao.tabs.push(tab);
    sessao.activeId = tab.id;
    return tab;
  }
  if (KIND_UNICO.has(kind)) {
    const existente = sessao.tabs.find((t) => t.kind === kind);
    if (existente) {
      sessao.activeId = existente.id;
      return existente;
    }
  }
  const tab = { id: newId(), kind };
  sessao.tabs.push(tab);
  sessao.activeId = tab.id;
  return tab;
}

export function fecharAba(sessao, id) {
  const i = sessao.tabs.findIndex((t) => t.id === id);
  if (i < 0) return abaAtiva(sessao);
  sessao.tabs.splice(i, 1);
  if (sessao.activeId === id) {
    sessao.activeId = sessao.tabs[i]?.id || sessao.tabs[i - 1]?.id || "";
  }
  return abaAtiva(sessao);
}

export function setUrlDaAba(sessao, id, url) {
  const tab = sessao.tabs.find((t) => t.id === id);
  if (!tab || tab.kind !== "browser") return tab || null;
  tab.url = urlDePreview(url);
  return tab;
}

export function rotuloDeUrl(url) {
  const href = String(url || "").trim();
  if (!href || href === "about:blank") return "Browser";
  try {
    const u = new URL(href);
    const path = u.pathname === "/" ? "" : u.pathname;
    return path ? `${u.host}${path}` : u.host || "Browser";
  } catch {
    return href;
  }
}

export function rotuloDaAba(tab) {
  if (!tab) return "";
  if (tab.kind === "browser") return rotuloDeUrl(tab.url);
  return NOMES[tab.kind] || tab.kind;
}

export function hidratarRecents(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const url = typeof r === "string" ? r : r?.url;
    if (!url || url === "about:blank" || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, at: Number(r?.at) || 0 });
  }
  return out;
}

export function lembrarRecent(recents, url, { max = 12 } = {}) {
  const href = urlDePreview(url);
  if (!href || href === "about:blank") return recents || [];
  return [{ url: href, at: Date.now() }, ...(recents || []).filter((r) => r.url !== href)].slice(0, max);
}

/** Itens da paleta: módulos + Recentes (URLs) + URL digitada. */
export function itensDaPaleta({ modules, recents, filtro }) {
  const q = String(filtro || "").trim();
  const qn = q.toLowerCase();
  const mods = (modules || []).filter((m) => {
    if (!qn) return true;
    return `${m.name} ${m.id} ${m.keys}`.toLowerCase().includes(qn);
  });
  const items = mods.map((m) => ({ tipo: "mod", id: m.id, name: m.name, keys: m.keys || "", ico: m.ico }));
  const recs = hidratarRecents(recents).filter((r) => {
    if (!qn) return true;
    return r.url.toLowerCase().includes(qn) || rotuloDeUrl(r.url).toLowerCase().includes(qn);
  });
  const digitada = pareceUrl(q) ? urlDePreview(q) : "";
  const temDigitada = digitada && digitada !== "about:blank" && !recs.some((r) => r.url === digitada);
  if (!recs.length && !temDigitada) return items;
  items.push({ tipo: "sep", id: "sep-recents", name: "Recentes", keys: "", ico: "" });
  if (temDigitada) {
    items.push({
      tipo: "url",
      id: `url:${digitada}`,
      name: rotuloDeUrl(digitada),
      keys: "",
      ico: "🌐",
      url: digitada,
    });
  }
  for (const r of recs) {
    items.push({
      tipo: "recent",
      id: `recent:${r.url}`,
      name: rotuloDeUrl(r.url),
      keys: "",
      ico: "🌐",
      url: r.url,
    });
  }
  return items;
}

/** Primeiro item selecionável (pula o separador "Recentes"). */
export function indiceSelecionavel(items, i) {
  if (!items.length) return 0;
  let n = Math.max(0, Math.min(i, items.length - 1));
  if (items[n]?.tipo === "sep") n = Math.min(n + 1, items.length - 1);
  return n;
}
