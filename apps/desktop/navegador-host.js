/**
 * Adapter único do `<webview>` do painel Browser pro modo navegador (`nexo_navegador_*`) — mesmo
 * papel de `inspector-host.js` pro modo seleção, mas mais simples: aqui não há máquina de estado
 * (cada comando é um round-trip independente, sem "ligado"/"desligado" persistente).
 *
 * `abrir`/`screenshot` usam métodos NATIVOS do `<webview>` (`loadURL`/`capturePage`) — não
 * precisam do preload. `ler`/`clicar`/`digitar` precisam rodar JS dentro da página, então passam
 * pelo preload via `send()`/`ipc-message`, com timeout próprio e curto (handshake local, bem
 * menor que o timeout de 20s da ponte do daemon em navegador.ts).
 */
import { CANAL_NAVEGADOR, TIMEOUT_NAVEGADOR_MS } from "./navegador-protocolo.js";

export function criarNavegadorHost({ getWebview }) {
  /** Comando local em voo (preload -> host) — só um de cada vez, mesma regra do daemon. */
  let pendente = null;

  function enviar(canal, valor) {
    const webview = getWebview();
    if (!webview?.send) return;
    // `send()` de `<webview>` devolve Promise que rejeita async se o preload ainda não anexou —
    // mesma razão do `.catch` em inspector-host.js: o timeout de baixo cobre esse caso.
    Promise.resolve(webview.send(canal, valor)).catch(() => {});
  }

  function aguardarResposta() {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        pendente = null;
        resolve({ ok: false, texto: "preload do painel Browser não respondeu — a página está carregada?" });
      }, TIMEOUT_NAVEGADOR_MS);
      pendente = { resolve, timeoutId };
    });
  }

  function resolverPendente(valor) {
    if (!pendente) return;
    clearTimeout(pendente.timeoutId);
    const { resolve } = pendente;
    pendente = null;
    resolve(valor);
  }

  async function abrir(url) {
    const webview = getWebview();
    if (!webview?.loadURL) return { ok: false, texto: "painel Browser indisponível" };
    try {
      await webview.loadURL(url);
      return { ok: true, texto: `aberto: ${url}` };
    } catch (e) {
      return { ok: false, texto: e?.message || "falhou ao navegar" };
    }
  }

  async function ler() {
    enviar(CANAL_NAVEGADOR.LER);
    const r = await aguardarResposta();
    if (!r.itens) return r; // erro/timeout, já no formato {ok, texto}
    if (!r.itens.length) return { ok: true, texto: "(nenhum elemento interativo na página)" };
    const linhas = r.itens.map((it) => `${it.ref}: [${it.papel}] ${it.texto}`).join("\n");
    return { ok: true, texto: linhas };
  }

  /** Teto de largura do print — em px físicos, não CSS. Independe de zoom/DPI da tela: um
   * monitor 4K/retina captura em pixels físicos e estouraria isso sem redimensionar. */
  const LARGURA_MAX_PRINT = 1280;

  async function screenshot() {
    const webview = getWebview();
    if (!webview?.capturePage) return { ok: false, texto: "painel Browser indisponível" };
    try {
      let imagem = await webview.capturePage();
      const { width } = imagem.getSize();
      // Comprimir sozinho (JPEG em vez de PNG) não basta: página densa (gráfico, muita cor) em
      // tela HiDPI ainda gera um JPEG grande o bastante pra estourar o limite de tamanho de
      // resultado de ferramenta de algum cliente MCP (CLI do Claude/Codex) — o corpo chega
      // cortado no meio da string base64, que na ponta do modelo aparece como "base64 malformado".
      // Redimensionar antes garante um teto de tamanho previsível, não dependente da tela/página.
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

  async function clicar(ref) {
    enviar(CANAL_NAVEGADOR.CLICAR, ref);
    return aguardarResposta();
  }

  async function digitar(ref, texto) {
    enviar(CANAL_NAVEGADOR.DIGITAR, { ref, texto });
    return aguardarResposta();
  }

  return {
    abrir,
    ler,
    screenshot,
    clicar,
    digitar,
    /** `nexo-navegador:lido` chegou do preload — ver listener de `ipc-message` em renderer.js. */
    receberLido: (dado) => resolverPendente(dado),
    /** `nexo-navegador:acao-resultado` chegou do preload (clique/digitação). */
    receberAcaoResultado: (dado) => resolverPendente(dado),
  };
}
