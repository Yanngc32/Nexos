import { EventEmitter } from "node:events";

/**
 * O barramento de eventos ao vivo de cada conversa, à parte de `session.ts` — mesmo motivo de
 * `veredito.ts` ter saído pra arquivo próprio: `perguntas.ts` precisa emitir evento (pausa/retoma
 * de `nexo_perguntar`) e `session.ts` precisa do nome da ferramenta pra montar o
 * `--allowed-tools`; um `perguntas.ts` → `session.ts` fecharia ciclo de módulo.
 *
 * `session.ts` reexporta isto — quem já importa `sessionBus` de lá continua funcionando.
 */
export const sessionBus = new EventEmitter();
