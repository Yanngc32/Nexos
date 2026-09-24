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
import { coletarDaPagina, paginaParaMarkdown } from "./pagina-markdown.js";

/**
 * `NativeImage.toJPEG()` no renderer (sem `nodeIntegration`) devolve `Uint8Array`.
 * `Uint8Array#toString("base64")` IGNORA o encoding e vira `"255,216,…"` — o
 * cliente MCP recusa o tools/call inteiro (`Invalid Base64 string`).
 */
export function jpegParaBase64(buf) {
  if (buf == null) return "";
  if (buf instanceof Uint8Array) return bytesParaBase64(buf);
  if (typeof buf.toString === "function") {
    const s = buf.toString("base64");
    if (typeof s === "string" && s.length && !s.includes(",")) return s;
  }
  return "";
}

function bytesParaBase64(bytes) {
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(bytes).toString("base64");
  }
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

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

  /** Página inteira em markdown (pagina-markdown.js): serializa no guest, converte aqui. */
  async function markdown(threadId, libs) {
    const webview = getWebview(threadId);
    if (!webview?.executeJavaScript) return { ok: false, texto: "painel Browser indisponível" };
    try {
      const pagina = await webview.executeJavaScript(`(${coletarDaPagina.toString()})()`);
      return { ok: true, texto: paginaParaMarkdown(pagina, libs) };
    } catch (e) {
      return { ok: false, texto: e?.message || "falhou ao converter a página" };
    }
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
      const dataBase64 = jpegParaBase64(imagem.toJPEG(70));
      if (!dataBase64) {
        return { ok: false, texto: "print saiu sem bytes — tenta de novo com o painel Browser visível" };
      }
      return {
        ok: true,
        texto: "print tirado",
        imagem: { dataBase64, mimeType: "image/jpeg" },
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
    markdown,
    screenshot,
    clicar,
    digitar,
    receberLido: (dado, threadId) => resolverPendente(dado, threadId),
    receberAcaoResultado: (dado, threadId) => resolverPendente(dado, threadId),
  };
}
