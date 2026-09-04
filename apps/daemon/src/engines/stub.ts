import type { EngineEvent, StartOpts } from "@nexo/shared";
import type { Engine, EngineHandler } from "./types.ts";

export class StubEngine implements Engine {
  lastStart?: StartOpts;
  lastSend?: string;
  lastCwd?: string;
  private handler?: EngineHandler;
  private aborted = false;
  private finished = false;

  constructor(readonly cwd: string) {
    this.lastCwd = cwd;
  }

  async start(opts: StartOpts, onEvent: EngineHandler): Promise<void> {
    this.aborted = false;
    this.finished = false;
    this.lastStart = opts;
    this.handler = onEvent;
  }

  async send(text: string): Promise<void> {
    this.lastSend = text;
    if (this.aborted || !this.handler) return;
    if (text === "QUOTA") {
      this.handler({ type: "quota" });
      return;
    }
    // resposta parcial e depois quota: exercita a retomada na conta nova
    if (text === "PARTQUOTA") {
      this.handler({ type: "text", text: "par" });
      this.handler({ type: "quota" });
      return;
    }
    if (text === "CRASH") {
      this.handler({ type: "error", message: "crash" });
      return;
    }
    if (text === "THINK") {
      this.handler({ type: "thinking", tokens: 42 });
      this.handler({ type: "text", text: "pronto" });
      this.handler({ type: "done" });
      return;
    }
    if (text === "USAGE") {
      this.handler({ type: "session", model: "claude-opus-5[1m]", contextWindow: 1_000_000 });
      this.handler({
        type: "limits",
        status: "allowed",
        fiveHour: { utilization: 0.38, resetsAt: 1788453600 },
        sevenDay: { utilization: 0.49, resetsAt: 1788706800 },
      });
      this.handler({
        type: "usage",
        input: 2,
        output: 4,
        cacheRead: 100,
        cacheCreate: 40274,
        contextTokens: 40376,
        costUsd: 0.4,
      });
      this.handler({ type: "done" });
      return;
    }
    // Simula um turno com várias idas e vindas de ferramenta: o "usage" final soma
    // tudo (pra custo), mas o contexto de verdade é o do último request individual.
    if (text === "TOOLLOOP") {
      this.handler({ type: "context", contextTokens: 50_000 });
      this.handler({ type: "tool", name: "Read", summary: "a.ts" });
      this.handler({ type: "context", contextTokens: 90_000 });
      this.handler({
        type: "usage",
        input: 10,
        output: 20,
        cacheRead: 400_000,
        cacheCreate: 100_000,
        contextTokens: 500_030,
      });
      this.handler({ type: "done" });
      return;
    }
    if (text === "SLOW") {
      this.handler({ type: "text", text: "par" });
      await new Promise((r) => setTimeout(r, 400));
      if (this.aborted || this.finished) return;
      this.handler({ type: "text", text: "tial" });
      this.handler({ type: "done" });
      return;
    }
    this.handler({ type: "text", text: `echo:${text}` });
    this.handler({ type: "done" });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (!this.finished) {
      this.finished = true;
      this.handler?.({ type: "done" });
    }
  }
}
