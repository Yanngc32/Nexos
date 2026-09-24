/**
 * Janela do chat: abrir uma conversa desenha só o fim dela. Desenhar tudo travava a tela
 * (conversa de 2,6 MB = 3,7 s parado), e quase todo o peso é de ferramenta que ninguém abre.
 *
 * O corte cai sempre numa mensagem sua: assim o `tool_result` acha o `tool` dele e as bolhas de
 * fase fecham certo, porque o turno entra inteiro. O último turno entra mesmo passando do limite.
 */

/** Eventos desenhados ao abrir; "mostrar anteriores" soma outro tanto. */
export const LIMITE_DO_CHAT = 300;

/** Índice do primeiro evento a desenhar pra ficar em até `limite` eventos (0 = desenha tudo). */
export function inicioDaJanela(events, limite = LIMITE_DO_CHAT) {
  if (events.length <= limite) return 0;
  let inicio = -1;
  for (let i = events.length - 1; i > 0; i--) {
    if (events[i]?.type !== "user") continue;
    if (inicio >= 0 && events.length - i > limite) break;
    inicio = i;
  }
  return inicio > 0 ? inicio : 0;
}

/** Quantas mensagens suas ficaram fora da janela (texto do botão). */
export function mensagensAntesDe(events, inicio) {
  let n = 0;
  for (let i = 0; i < inicio; i++) if (events[i]?.type === "user" && !events[i].automatico) n++;
  return n;
}
