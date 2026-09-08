/**
 * Canais IPC entre o host (renderer.js / inspector-host.js) e o preload que roda dentro
 * do preview (`browser-inspector-preload.cjs`). Fonte única dos nomes de canal do lado
 * host — o preload é CommonJS e vive num processo/contexto separado, então mantém os
 * mesmos literais por conta própria; qualquer mudança de nome aqui precisa espelhar lá.
 */
export const CANAL = Object.freeze({
  TOGGLE: "nexo-inspector:toggle",
  PRONTO: "nexo-inspector:pronto",
  SELECIONADO: "nexo-inspector:selecionado",
  // guest -> host: Esc apertado dentro do preview. O guest já desligou sozinho (não espera
  // confirmação do host) — isto só avisa o host pra ele sincronizar o próprio estado/UI.
  ESC: "nexo-inspector:esc",
  // host -> guest: sincroniza a lista de badges do preview com a caixa lateral do host,
  // que é quem tem o "✕" por item e o hover que realça.
  DESMARCAR: "nexo-inspector:desmarcar",
  REALCAR: "nexo-inspector:realcar",
});

/** Handshake de armar o modo: quanto tempo o host espera o preload confirmar `PRONTO`. */
export const TIMEOUT_HANDSHAKE_MS = 1000;
