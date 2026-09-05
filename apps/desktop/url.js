/**
 * URL do preview. `safeUrl` decide o que o iframe do app pode carregar, então
 * é fronteira de segurança, não conveniência: só http/https passam, todo o
 * resto (javascript:, file:, data:) cai em about:blank.
 */

export function safeUrl(raw) {
  const t = String(raw || "").trim();
  if (!t) return "about:blank";
  let u = t;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) u = "https://" + u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
    if (parsed.protocol === "about:") return "about:blank";
  } catch {
    /* ignore */
  }
  return "about:blank";
}

export function portaDaUrl(href) {
  try {
    const u = new URL(href);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}
