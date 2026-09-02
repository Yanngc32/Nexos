import type { EngineEvent, StartOpts } from "@nexo/shared";
import type { Engine, EngineHandler } from "./types.ts";

export class StubEngine implements Engine {
  lastStart?: StartOpts;
  lastCwd?: string;
  private handler?: EngineHandler;
  private aborted = false;

  constructor(readonly cwd: string) {
    this.lastCwd = cwd;
  }

  async start(opts: StartOpts, onEvent: EngineHandler): Promise<void> {
    this.aborted = false;
    this.lastStart = opts;
    this.handler = onEvent;
  }

  async send(text: string): Promise<void> {
    if (this.aborted || !this.handler) return;
    if (text === "QUOTA") {
      this.handler({ type: "quota" });
      return;
    }
    if (text === "CRASH") {
      this.handler({ type: "error", message: "crash" });
      return;
    }
    this.handler({ type: "text", text: `echo:${text}` });
    this.handler({ type: "done" });
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}
