import type { EngineEvent, StartOpts } from "@nexo/shared";

export type EngineHandler = (ev: EngineEvent) => void;

export interface Engine {
  start(opts: StartOpts, onEvent: EngineHandler): Promise<void>;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
}
