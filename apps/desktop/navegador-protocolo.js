/**
 * Canais IPC entre o host (`navegador-host.js`) e o preload que roda dentro do `<webview>`
 * (`browser-inspector-preload.cjs`, mesmo arquivo do modo "inspecionar elemento" — `main.cjs`
 * trava UM preload só por `<webview>`). Fonte única dos nomes do lado host — o preload é CJS e
 * vive num processo/contexto separado, mantém os mesmos literais por conta própria (mesmo motivo
 * de `inspector-protocolo.js`).
 */
export const CANAL_NAVEGADOR = Object.freeze({
  LER: "nexo-navegador:ler",
  LIDO: "nexo-navegador:lido", // guest -> host, resposta de LER
  CLICAR: "nexo-navegador:clicar",
  DIGITAR: "nexo-navegador:digitar",
  ACAO_RESULTADO: "nexo-navegador:acao-resultado", // guest -> host, resposta de CLICAR/DIGITAR
});

/**
 * Handshake local host<->preload (bem mais curto que o timeout de 20s da ponte do daemon —
 * navegador.ts — porque isto é só "o preload está vivo e respondeu", não o round-trip técnico
 * inteiro incluindo o próprio `capturePage`/`executeJavaScript`).
 */
export const TIMEOUT_NAVEGADOR_MS = 5000;
