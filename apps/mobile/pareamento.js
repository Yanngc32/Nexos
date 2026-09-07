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

/** Os 6 caracteres do código, no alfabeto do Crockford (sem I, L, O e U). */
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODIGO_LEN = 6;

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

/**
 * O código que veio no QR, se veio.
 *
 * Está no fragmento (`#c=123456`) porque fragmento não trafega: não vira linha
 * de log no daemon nem `Referer` pra terceiro. E sai da barra assim que é lido
 * — código serve uma vez, então deixá-lo na URL só garante erro em quem
 * recarregar a página, e o guarda no histórico do navegador de graça.
 */
export function codigoDaUrl(loc = window.location) {
  // o padrão sai do próprio alfabeto pra não divergir dele: o que o QR carrega é
  // gerado pelo daemon, então fora do alfabeto não é código — é lixo na URL
  const m = new RegExp(`(?:^|[#&])c=([${ALFABETO}]{${CODIGO_LEN}})(?:&|$)`).exec(loc.hash || "");
  return m ? m[1] : "";
}

export function limparUrl(loc = window.location, hist = window.history) {
  if (!loc.hash) return;
  try {
    hist.replaceState(null, "", loc.pathname + loc.search);
  } catch {
    /* navegador sem replaceState: o fragmento fica, e o pior é um erro na tela */
  }
}

/**
 * Deixa o campo mostrando exatamente o que vai ser enviado: maiúscula, sem
 * separador, e com as confusões de leitura desfeitas — I e L viram 1, O vira 0.
 *
 * Esta regra é uma **cópia** da `normalizarCodigo` do `@nexo/shared`, e a cópia
 * é o preço de o app de celular ser JS servido a um navegador: ele não carrega
 * TypeScript do pacote compartilhado. Quem decide de verdade é o daemon; aqui é
 * só pra tela não mentir sobre o que foi digitado. Os dois lados têm teste com
 * a mesma tabela de casos.
 *
 * A diferença de propósito é o corte no tamanho: cortar é papel de quem está
 * moldando um campo de entrada, e o daemon não corta — lá, tentativa comprida é
 * tentativa errada.
 */
export function limparCodigo(bruto) {
  return String(bruto ?? "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .split("")
    .filter((c) => ALFABETO.includes(c))
    .join("")
    .slice(0, CODIGO_LEN);
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
  if (limpo.length !== CODIGO_LEN) return { ok: false, erro: `O código tem ${CODIGO_LEN} caracteres.` };
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
