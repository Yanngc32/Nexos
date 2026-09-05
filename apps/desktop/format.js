/**
 * Helpers puros do renderer: valor -> string de exibição, e normalização de
 * caminho pra comparação. Sem DOM, sem `state`, sem rede — é o que os torna
 * testáveis fora do Electron.
 */

export function clip(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function folderName(p) {
  if (!p) return "Nenhum projeto";
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || p;
}

export function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 45) return "agora";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function elapsed(startedAt) {
  if (!startedAt) return "";
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 1 : 1)}k`;
  return String(v);
}

/** Igual ao painel do Claude Code: contagem curta pra hoje, dia da semana pra depois. */
export function fmtReset(unixSeconds) {
  const ms = Number(unixSeconds) * 1000;
  if (!ms || Number.isNaN(ms)) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "Reinicia agora";
  if (diff < 24 * 3600_000) {
    const h = Math.floor(diff / 3600_000);
    const m = Math.round((diff % 3600_000) / 60_000);
    return h ? `Reinicia em ${h} h ${m} min` : `Reinicia em ${m} min`;
  }
  const d = new Date(ms);
  const dia = d.toLocaleDateString("pt-BR", { weekday: "short" });
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `Reinicia ${dia}, ${hora}`;
}

export function fmtWhen(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString("pt-BR");
}

export function fmtDetail(d) {
  if (d == null || d === "") return "";
  if (typeof d === "object") {
    return fmtDetail(d.message || d.result || d.detail || d.type);
  }
  const s = String(d).replace(/\[object Object\]/gi, " ").replace(/\s+/g, " ").trim();
  if (/rate_limit/i.test(s) && !/you've hit your|session limit|resets /i.test(s)) {
    return "Limite de uso do Claude (rate limit). Espera um pouco ou troca de conta.";
  }
  return s;
}

export function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function samePath(a, b) {
  return Boolean(a && b && normPath(a) === normPath(b));
}
