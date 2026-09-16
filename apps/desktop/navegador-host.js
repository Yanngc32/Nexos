/**
 * Adapter do painel Browser pra `nexo_navegador_*`. Um pendente por thread —
 * duas conversas podem ler/clicar ao mesmo tempo, cada uma no próprio `<webview>`.
 *
 * `abrir`/`screenshot` usam métodos NATIVOS (`loadURL`/`capturePage`). `ler`/`clicar`/
 * `digitar` passam pelo preload. `abrir` na URL que o guest já tem NÃO chama loadURL:
 * voltar pra conversa não pode matar a página.
 */
import { CANAL_NAVEGADOR, TIMEOUT_NAVEGADOR_MS } from "./navegador-protocolo.js";
import { hrefDoGuest, mesmoHref } from "./browser-pool.js";

export function criarNavegadorHost({ getWebview }) {
  /** Comando local em voo, por thread — mesma regra do daemon (um por conversa). */
  const pendentes = new Map();

  function chave(threadId) {
    return threadId || "_";
  }

  function enviar(threadId, canal, valor) {
    const webview = getWebview(threadId);
    if (!webview?.send) return;
    Promise.resolve(webview.send(canal, valor)).catch(() => {});
  }

  function aguardarResposta(threadId) {
    const key = chave(threadId);
    if (pendentes.has(key)) {
      return Promise.resolve({ ok: false, texto: "já existe um comando de navegador pendente nesta conversa" });
    }
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        pendentes.delete(key);
        resolve({ ok: false, texto: "preload do painel Browser não respondeu — a página está carregada?" });
      }, TIMEOUT_NAVEGADOR_MS);
      pendentes.set(key, { resolve, timeoutId });
    });
  }

  function resolverPendente(valor, threadId) {
    const key =
      threadId != null && threadId !== ""
        ? chave(threadId)
        : pendentes.size === 1
          ? [...pendentes.keys()][0]
          : "_";
    const p = pendentes.get(key);
    if (!p) return;
    clearTimeout(p.timeoutId);
    pendentes.delete(key);
    p.resolve(valor);
  }

  async function abrir(url, threadId) {
    const webview = getWebview(threadId);
    if (!webview?.loadURL) return { ok: false, texto: "painel Browser indisponível" };
    if (mesmoHref(hrefDoGuest(webview), url)) {
      return { ok: true, texto: `aberto: ${url}` };
    }
    try {
      await webview.loadURL(url);
      if (webview.dataset) webview.dataset.href = url;
      return { ok: true, texto: `aberto: ${url}` };
    } catch (e) {
      return { ok: false, texto: e?.message || "falhou ao navegar" };
    }
  }

  async function ler(threadId) {
    enviar(threadId, CANAL_NAVEGADOR.LER);
    const r = await aguardarResposta(threadId);
    if (!r.itens) return r;
    if (!r.itens.length) return { ok: true, texto: "(nenhum elemento interativo na página)" };
    const linhas = r.itens.map((it) => `${it.ref}: [${it.papel}] ${it.texto}`).join("\n");
    return { ok: true, texto: linhas };
  }

  const LARGURA_MAX_PRINT = 1280;

  async function screenshot(threadId) {
    const webview = getWebview(threadId);
    if (!webview?.capturePage) return { ok: false, texto: "painel Browser indisponível" };
    try {
      let imagem = await webview.capturePage();
      if (imagem.isEmpty()) {
        return { ok: false, texto: "painel Browser sem conteúdo pra capturar — a aba Browser está aberta e visível?" };
      }
      const { width } = imagem.getSize();
      if (width > LARGURA_MAX_PRINT) {
        imagem = imagem.resize({ width: LARGURA_MAX_PRINT });
      }
      return {
        ok: true,
        texto: "print tirado",
        imagem: { dataBase64: imagem.toJPEG(70).toString("base64"), mimeType: "image/jpeg" },
      };
    } catch (e) {
      return { ok: false, texto: e?.message || "falhou ao tirar print" };
    }
  }

  async function clicar(ref, threadId) {
    enviar(threadId, CANAL_NAVEGADOR.CLICAR, ref);
    return aguardarResposta(threadId);
  }

  async function digitar(ref, texto, threadId) {
    enviar(threadId, CANAL_NAVEGADOR.DIGITAR, { ref, texto });
    return aguardarResposta(threadId);
  }

  return {
    abrir,
    ler,
    screenshot,
    clicar,
    digitar,
    receberLido: (dado, threadId) => resolverPendente(dado, threadId),
    receberAcaoResultado: (dado, threadId) => resolverPendente(dado, threadId),
  };
}
