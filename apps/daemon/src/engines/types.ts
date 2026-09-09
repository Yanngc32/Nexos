import type { EngineEvent, StartOpts } from "@nexo/shared";

export type EngineHandler = (ev: EngineEvent) => void;

export interface Engine {
  start(opts: StartOpts, onEvent: EngineHandler): Promise<void>;
  /**
   * Refaz o contexto que vai no próximo `send`. Necessário porque nenhum motor de
   * `--print`/`exec` (nem a chamada de API) guarda a conversa entre invocações —
   * cada `send` sobe um processo (ou request) novo. Sem reempurrar o pack a cada
   * turno, o motor só veria o retrato de quando o engine subiu, e "esqueceria" a
   * própria resposta anterior e o que rodou de ferramenta desde então.
   */
  updatePack(pack: string): void;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
}
