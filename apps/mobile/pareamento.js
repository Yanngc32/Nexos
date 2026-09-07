/**
 * O lado do celular no pareamento: troca o código curto pelo token e o guarda.
 *
 * Separado da tela porque é a parte com regra: o que conta como resposta boa, o
 * que fazer com token que o daemon já não aceita, e onde ele mora.
 *
 * O token fica no `localStorage`. Não é cofre — é o mesmo nível do arquivo
 * `0600` no PC: quem já tem o aparelho destravado tem o token. O que ele NÃO é
 * é eterno: o daemon sorteia um novo a cada subida, então o celular vai
 * despareaer sozinho e precisa lidar com isso sem drama.
 */

const CHAVE = "nexo.mobile.credencial";

/** De onde a página foi servida — o daemon está lá, por definição. */
export function baseDaPagina(loc = window.location) {
  return `${loc.protocol}//${loc.host}`;
}

export function credencialGuardada(store = window.localStorage) {
  try {
    const raw = store.getItem(CHAVE);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return typeof c?.token === "string" && c.token ? { token: c.token, base: c.base || "" } : null;
  } catch {
    // localStorage bloqueado (aba privada, site sem permissão) não é erro fatal:
    // a pessoa pareia de novo e usa a sessão
    return null;
  }
}

export function guardar(credencial, store = window.localStorage) {
  try {
    store.setItem(CHAVE, JSON.stringify(credencial));
  } catch {
    /* sem persistência, só a sessão */
  }
}

export function esquecer(store = window.localStorage) {
  try {
    store.removeItem(CHAVE);
  } catch {
    /* nada a fazer */
  }
}

/** Só dígitos, no tamanho certo. O teclado do celular deixa passar espaço e traço. */
export function limparCodigo(bruto) {
  return String(bruto ?? "").replace(/\D/g, "").slice(0, 6);
}

/**
 * Troca o código pelo token.
 *
 * Erro do daemon (403 com motivo) é mensagem pra pessoa — o motivo vem de lá e
 * já é escrito pra ser lido. Falha de rede é outra coisa, e dizer "código
 * errado" nesse caso mandaria a pessoa procurar o problema no lugar errado.
 */
export async function parear(codigo, { base = baseDaPagina(), fetchImpl = fetch } = {}) {
  const limpo = limparCodigo(codigo);
  if (limpo.length !== 6) return { ok: false, erro: "O código tem 6 dígitos." };
  let res;
  try {
    res = await fetchImpl(`${base}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo: limpo }),
    });
  } catch {
    return { ok: false, erro: "Não alcancei o computador. O Nexo está ligado e o túnel de pé?" };
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, erro: dados.error || "O código não serviu." };
  if (typeof dados.token !== "string" || !dados.token) {
    return { ok: false, erro: "O computador respondeu sem token." };
  }
  return { ok: true, credencial: { token: dados.token, base } };
}
