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

/**
 * O endereço que o celular abre — com o código de pareamento no fragmento,
 * quando há um.
 *
 * **IPv6 vai entre colchetes**, e isto não é preciosismo: endereço de Tailscale
 * é IPv6 (`fd7a:115c:…`), e sem colchete o navegador lê `http://fd7a:115c:…`
 * como host `fd7a` e porta `115c`. Um endereço digitado errado a pessoa
 * corrige; um QR ela não corrige — ele só não funciona.
 *
 * O código vai no **fragmento**, não na query: fragmento não é enviado ao
 * servidor, então não entra em log de acesso nem em `Referer`.
 */
export function urlDoCelular(host, porta, codigo) {
  const h = String(host || "127.0.0.1").trim();
  const alvo = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
  const frag = /^\d{6}$/.test(String(codigo ?? "")) ? `#c=${codigo}` : "";
  return `http://${alvo}:${porta || 7432}/app/${frag}`;
}

export function portaDaUrl(href) {
  try {
    const u = new URL(href);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}
