/**
 * Cliente HTTP do daemon.
 *
 * Porta e token moram aqui e em nenhum outro lugar: mudam a cada subida do
 * motor e só esta camada precisa deles. O que a UI precisa saber — se o motor
 * está de pé — sai pelo `onInfo`, porque disso ela depende em dezenas de
 * pontos.
 *
 * `daemonInfo` e `fetchImpl` entram por parâmetro pra que o retry possa ser
 * testado fora do Electron: é a função mais chamada do app e a que mais tem
 * caso de borda.
 */
/** Mesmo padrão do daemon. Vale só até o primeiro `aplicar`, mas evita depender da ordem do boot. */
const PORTA_PADRAO = 7432;

export function createApiClient({ daemonInfo, onInfo = () => {}, fetchImpl = fetch }) {
  let port = PORTA_PADRAO;
  let token = "";

  function headers() {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  function api(path) {
    return `http://127.0.0.1:${port}${path}`;
  }

  /** Guarda o que veio do motor e avisa a UI. Quem já tem o info empurra por aqui. */
  function aplicar(info) {
    port = info.port;
    token = info.token;
    onInfo(info);
  }

  /** Relê porta e token do motor: eles mudam quando o daemon reinicia. */
  async function renovarCredenciais() {
    try {
      const info = await daemonInfo();
      const mudou = info.port !== port || info.token !== token;
      aplicar(info);
      return mudou || info.ok;
    } catch {
      return false;
    }
  }

  /**
   * Uma re-tentativa em dois casos, ambos sem efeito no servidor: falha de
   * conexão (a requisição não chegou) e 401 (token antigo depois de reiniciar o
   * motor). Sem isso, qualquer reinício do daemon virava "Failed to fetch" na
   * cara do usuário até o próximo poll.
   */
  async function req(path, opts = {}) {
    const chamar = () => fetchImpl(api(path), { ...opts, headers: { ...headers(), ...opts.headers } });
    let res;
    try {
      res = await chamar();
    } catch (e) {
      if (!(await renovarCredenciais())) {
        throw new Error("O motor não está respondendo. Liga o motor e tenta de novo.");
      }
      try {
        res = await chamar();
      } catch {
        throw new Error("O motor não está respondendo. Liga o motor e tenta de novo.");
      }
    }
    if (res.status === 401) {
      await renovarCredenciais();
      res = await chamar().catch(() => res);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  /** Igual ao req, mas devolve bytes: anexo não é JSON. */
  async function reqBlob(path) {
    const chamar = () => fetchImpl(api(path), { headers: { authorization: `Bearer ${token}` } });
    let res = await chamar();
    if (res.status === 401) {
      await renovarCredenciais();
      res = await chamar();
    }
    if (!res.ok) throw new Error(`anexo ${res.status}`);
    return res.blob();
  }

  // api/headers saem porque os três streams SSE (chat, serviços, agentes) montam
  // o fetch na mão — EventSource não deixa mandar cabeçalho de autorização.
  return { api, aplicar, headers, renovarCredenciais, req, reqBlob };
}
