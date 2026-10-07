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

/**
 * O `<webview>` está sendo pintado? Guardado no pool (`.stowed`) ou dentro de um painel escondido
 * ele herda `visibility: hidden` — e aí o `capturePage` não volta vazio: TRAVA (medido no Electron
 * 33, também pelo processo principal e com `stayHidden:false`). Sem estilo computado (teste) = sim.
 */
export function estaPintado(webview, win = globalThis) {
  if (!webview?.style || typeof win.getComputedStyle !== "function") return true;
  const cs = win.getComputedStyle(webview);
  return cs.visibility === "visible" && Number(cs.opacity || 1) > 0;
}

/** Dois quadros: o primeiro aplica o estilo, o segundo garante que o guest já compôs. */
function doisQuadros(win = globalThis) {
  if (typeof win.requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((ok) => win.requestAnimationFrame(() => win.requestAnimationFrame(ok)));
}

/**
 * Print com o preview escondido (a pessoa em outra conversa ou outro painel): o `<webview>` fica
 * visível pro compositor e transparente pra pessoa (`visibility: visible` explícito vence o
 * `hidden` herdado do painel; `opacity: 0` não mostra nada) só durante a captura, e volta.
 * Jogar pra fora da tela não serve: a captura sai vazia. Medido com Electron 33.
 */
export async function comPreviewPintado(webview, f, { win = globalThis, esperar = doisQuadros } = {}) {
  if (estaPintado(webview, win)) return f();
  const antes = { visibility: webview.style.visibility, opacity: webview.style.opacity, pointerEvents: webview.style.pointerEvents };
  webview.style.visibility = "visible";
  webview.style.opacity = "0";
  webview.style.pointerEvents = "none";
  try {
    await esperar(win);
    return await f();
  } finally {
    webview.style.visibility = antes.visibility;
    webview.style.opacity = antes.opacity;
    webview.style.pointerEvents = antes.pointerEvents;
  }
}

/** Carga da página mais longa que isso volta como "ainda carregando" — abaixo dos 20 s do daemon. */
const CARGA_TETO_MS = 12_000;

/**
 * Espera o guest terminar de carregar (ou falhar no frame principal). Guest recém-criado ainda não
 * aceita `isLoading()` (lança antes do dom-ready): aí só os eventos dizem quando terminou.
 * `ERR_ABORTED` (-3) é navegação substituída, não erro.
 */
export function esperarCarregar(webview, { teto = CARGA_TETO_MS, conferirAgora = true } = {}) {
  let cancelar = () => {};
  let encerrar = () => {};
  const promessa = new Promise((resolve) => {
    if (typeof webview?.addEventListener !== "function") return resolve({});
    let tetoId;
    const fim = (r) => {
      cancelar();
      resolve(r);
    };
    encerrar = fim;
    const parou = () => fim({});
    const falhou = (e) => {
      if (e?.isMainFrame === false || e?.errorCode === -3) return;
      fim({ erro: e?.errorDescription || `erro ${e?.errorCode ?? "desconhecido"}` });
    };
    cancelar = () => {
      clearTimeout(tetoId);
      webview.removeEventListener?.("did-stop-loading", parou);
      webview.removeEventListener?.("did-fail-load", falhou);
    };
    webview.addEventListener("did-stop-loading", parou);
    webview.addEventListener("did-fail-load", falhou);
    tetoId = setTimeout(() => fim({ teto: true }), teto);
    // sem navegação nova, a carga pode já ter acabado antes de ouvir: guest pronto e parado = pronto
    try {
      if (conferirAgora && typeof webview.isLoading === "function" && !webview.isLoading()) {
        queueMicrotask(() => fim({}));
      }
    } catch {
      /* recém-criado, antes do dom-ready: espera os eventos */
    }
  });
  return { promessa, cancelar: () => cancelar(), encerrar: (r) => encerrar(r) };
}

/** Teto da captura: guest que não pinta nunca responde — melhor erro claro que a ferramenta parada. */
const CAPTURA_TETO_MS = 8000;

export function criarNavegadorHost({ getWebview, win = globalThis }) {
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
    const navegar = !mesmoHref(hrefDoGuest(webview), url);
    const espera = esperarCarregar(webview, { conferirAgora: !navegar });
    if (navegar) {
      if (webview.dataset) webview.dataset.href = url;
      try {
        // não espera o loadURL: quem diz como a carga terminou é o evento (ou o teto)
        Promise.resolve(webview.loadURL(url)).catch((e) => {
          // ERR_ABORTED: redirect/nova navegação trocou a carga — segue esperando a que ficou
          if (!/ERR_ABORTED|\(-3\)/.test(String(e?.message || e))) {
            espera.encerrar({ erro: e?.message || "falhou ao navegar" });
          }
        });
      } catch {
        // guest recém-criado, antes do dom-ready: o loadURL lança na hora; o atributo navega
        webview.src = url;
      }
    }
    const fim = await espera.promessa;
    if (fim.erro) return { ok: false, texto: `não abriu ${url}: ${fim.erro}` };
    if (fim.teto) return { ok: true, texto: `aberto: ${url} (a página ainda está carregando)` };
    return { ok: true, texto: `aberto: ${url}` };
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
      let tetoId;
      const teto = new Promise((ok) => {
        tetoId = setTimeout(() => ok(null), CAPTURA_TETO_MS);
      });
      let imagem = await comPreviewPintado(webview, () => Promise.race([webview.capturePage(), teto]), { win });
      clearTimeout(tetoId);
      if (!imagem) return { ok: false, texto: "o preview não respondeu ao print a tempo — a página ainda está carregando?" };
      if (imagem.isEmpty()) {
        return { ok: false, texto: "painel Browser sem conteúdo pra capturar — a página carregou?" };
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
