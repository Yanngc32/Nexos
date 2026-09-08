/**
 * Adapter único do `<webview>` do painel Browser pro modo seleção: transporte (envio via
 * `send()`, sempre com `.catch` — `send()` de `<webview>` devolve Promise, e falha por
 * preview ainda não anexado rejeita de forma assíncrona, escapando de um try/catch comum)
 * + a máquina de estado pura de `inspector-estado.js` ligada aos eventos do próprio
 * `<webview>` (dom-ready/did-navigate re-armam o handshake sozinhos).
 *
 * `renderer.js` só chama os métodos daqui e re-renderiza a UI a partir do estado devolvido
 * em `onMudarEstado` — nenhuma lógica de fase mora em renderer.js.
 */
import { FASE, EVENTOS, estadoInicial, transicionar, botaoPressionado } from "./inspector-estado.js";
import { CANAL, TIMEOUT_HANDSHAKE_MS } from "./inspector-protocolo.js";

export function criarInspectorHost({ getWebview, temPreview, onMudarEstado }) {
  let estado = estadoInicial();
  let timeoutId = 0;

  function limparTimeout() {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = 0;
  }

  function aplicar(evento) {
    const novo = transicionar(estado, evento);
    if (novo === estado) return estado;
    estado = novo;
    onMudarEstado(estado);
    return estado;
  }

  function armarTimeout() {
    limparTimeout();
    timeoutId = setTimeout(() => aplicar({ tipo: EVENTOS.TIMEOUT }), TIMEOUT_HANDSHAKE_MS);
  }

  function enviar(canal, valor) {
    const webview = getWebview();
    if (!webview?.send) return;
    Promise.resolve(webview.send(canal, valor)).catch(() => {
      /* preview sem preload anexado ainda — o timeout do handshake cobre esse caso */
    });
  }

  /** Liga: se não há preview carregado, vai direto pro erro sem round-trip nenhum. */
  function ligar() {
    if (estado.fase === FASE.LIGADO || estado.fase === FASE.ARMANDO) return;
    aplicar({ tipo: EVENTOS.LIGAR });
    if (!temPreview()) {
      aplicar({ tipo: EVENTOS.TIMEOUT });
      return;
    }
    armarTimeout();
    enviar(CANAL.TOGGLE, true);
  }

  function desligar() {
    limparTimeout();
    if (estado.fase === FASE.DESLIGADO) return;
    aplicar({ tipo: EVENTOS.DESLIGAR });
    enviar(CANAL.TOGGLE, false);
  }

  function receberPronto() {
    limparTimeout();
    aplicar({ tipo: EVENTOS.PRONTO });
  }

  function receberSelecionado(dado) {
    aplicar({ tipo: EVENTOS.SELECIONADO, dado });
  }

  /** Esc dentro do guest: ele já desligou sozinho, aqui só sincroniza o estado do host. */
  function receberEsc() {
    limparTimeout();
    aplicar({ tipo: EVENTOS.DESLIGAR });
  }

  /**
   * dom-ready/did-navigate do `<webview>`: o documento (e o preload) morreram e nasceram
   * de novo. Enquanto o modo tava ligado ou armando, o host reenvia o toggle e reabre o
   * handshake — sem isto, reload apaga o preload em silêncio e o botão fica aceso morto.
   */
  function aoRecarregarPreview() {
    if (estado.fase === FASE.DESLIGADO || estado.fase === FASE.ERRO) return;
    aplicar({ tipo: EVENTOS.RECARREGOU });
    armarTimeout();
    enviar(CANAL.TOGGLE, true);
  }

  function removerSelecionado(indiceBase0) {
    if (estado.fase !== FASE.LIGADO) return;
    const indice1based = indiceBase0 + 1;
    aplicar({ tipo: EVENTOS.REMOVER, indice: indiceBase0 });
    enviar(CANAL.DESMARCAR, indice1based);
  }

  function realcarSelecionado(indiceBase0) {
    enviar(CANAL.REALCAR, indiceBase0 + 1);
  }

  return {
    ligar,
    desligar,
    receberPronto,
    receberSelecionado,
    receberEsc,
    aoRecarregarPreview,
    removerSelecionado,
    realcarSelecionado,
    estadoAtual: () => estado,
    botaoPressionado: () => botaoPressionado(estado),
  };
}
