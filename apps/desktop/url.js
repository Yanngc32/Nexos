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
 * Endereço pronto pra entrar numa URL: IPv6 vai entre colchetes.
 *
 * Sem eles, `http://fd7a:115c::1:7432/` faz o navegador ler `fd7a` como host e
 * `115c` como porta. A tela do celular e o QR usam isto; o daemon tem a mesma
 * regra em `@nexo/shared`.
 */
export function hostNaUrl(host) {
  const h = String(host || "").trim();
  return h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
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
/**
 * `https`, quando informado (`{ hostname, port }`, de `GET /v1/escuta`), troca
 * o endereço inteiro pelo certificado de verdade emitido via `tailscale cert`
 * — nunca `https://` num IP, que nenhuma CA pública assina. Sem ele, cai no
 * `http://host:porta` de sempre. Ver
 * `docs/superpowers/specs/2026-09-13-https-tailscale-cert-design.md`.
 */
function enderecoBase(host, porta, https) {
  if (https?.hostname && https.port) return `https://${https.hostname}:${https.port}`;
  const alvo = hostNaUrl(String(host || "127.0.0.1").trim());
  return `http://${alvo}:${porta || 7432}`;
}

export function urlDoCelular(host, porta, codigo, https) {
  // só um código no formato exato entra no fragmento; qualquer outra coisa fica
  // de fora em vez de entrar torta e virar um QR que leva a erro
  const frag = /^[0-9A-HJKMNP-TV-Z]{6}$/.test(String(codigo ?? "")) ? `#c=${codigo}` : "";
  return `${enderecoBase(host, porta, https)}/app/${frag}`;
}

/**
 * O endereço que o QR de download de APK carrega — SEMPRE separado do de
 * pareamento, e nunca com `#c=` misturado no mesmo link.
 *
 * O código vai na QUERY, não no fragmento: `GET /apk` roda no daemon, e
 * fragmento nunca chega ao servidor — só o `#c=` do pareamento pode ficar lá,
 * porque quem lê aquele é o JS da SPA, já carregada. Aqui não há SPA
 * nenhuma antes: o celular ainda pode nem ter o Nexo aberto.
 */
export function urlDoApk(host, porta, codigo, https) {
  const q = /^[0-9A-HJKMNP-TV-Z]{6}$/.test(String(codigo ?? "")) ? `?c=${codigo}` : "";
  return `${enderecoBase(host, porta, https)}/apk${q}`;
}

export function portaDaUrl(href) {
  try {
    const u = new URL(href);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return 0;
  }
}

/**
 * Paleta/urlbar: loopback e IP local sem esquema entram como http (servidor de
 * dev), não https. `safeUrl("localhost:5173")` sozinho prefixava https e a
 * prévia quebrava.
 */
export function urlDePreview(raw) {
  const t = String(raw || "").trim();
  if (!t) return "about:blank";
  // http(s) explícito: não reinterpretar. Loopback SEM esquema vira http — "localhost:5173"
  // casaria como scheme `localhost:` no URL parser e o safeUrl mandaria pra about:blank.
  if (/^https?:\/\//i.test(t)) return safeUrl(t);
  if (ehLoopbackOuIp(t)) return safeUrl("http://" + t);
  return safeUrl(t);
}

function ehLoopbackOuIp(t) {
  const host = t.replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (/^localhost$/i.test(host) || host === "127.0.0.1" || host === "[::1]" || host === "::1") return true;
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

/** Texto da paleta parece URL/endereço de preview, não nome de módulo. */
export function pareceUrl(q) {
  const t = String(q || "").trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(t)) return true;
  if (/^[a-z0-9.-]+:\d{2,5}(\/|$)/i.test(t)) return true;
  return false;
}
