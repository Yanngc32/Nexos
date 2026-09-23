import type { EngineEvent, EngineOverrides, StartOpts } from "@nexos/shared";
import { MODELO_AUTO, MODELO_AUTO_FALLBACK } from "@nexos/shared";
import type { Engine, EngineHandler, EngineMcp } from "./types.ts";
import { getProfile, readApiKey } from "../profiles.ts";

type ApiEngineOpts = {
  home: string;
  profileId: string;
  fetchImpl?: typeof fetch;
};

export class ApiEngine implements Engine {
  /** Override do turno (modelo escolhido por complexidade). Ver `updateOverrides`. */
  private overridesDoTurno: EngineOverrides = {};
  private handler?: EngineHandler;
  private opts?: StartOpts;
  private readonly fetchImpl: typeof fetch;
  private readonly home: string;
  private readonly profileId: string;
  private aborted = false;
  private finished = false;

  constructor(opts: ApiEngineOpts) {
    this.home = opts.home;
    this.profileId = opts.profileId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async start(opts: StartOpts, onEvent: EngineHandler): Promise<void> {
    this.aborted = false;
    this.finished = false;
    this.opts = opts;
    this.handler = onEvent;
  }

  updatePack(pack: string): void {
    if (this.opts) this.opts = { ...this.opts, contextPack: pack };
  }

  updateMcp(_mcp: EngineMcp): void {
    // Chamada de API direta ao provedor, sem cliente MCP — nunca teve ferramenta MCP a atualizar.
  }

  updateResume(_sessionId?: string): void {
    // Sem sessão de CLI pra retomar.
  }

  updateOverrides(over: EngineOverrides): void {
    this.overridesDoTurno = over;
  }

  async send(text: string): Promise<void> {
    if (this.aborted || !this.handler) return;
    const profile = getProfile(this.profileId, this.home);
    if (!profile?.api) {
      this.handler({ type: "error", message: "perfil api sem provider" });
      return;
    }
    const apiKey = readApiKey(this.profileId, this.home);
    if (!apiKey) {
      this.handler({ type: "error", message: "api key ausente" });
      return;
    }
    const base = process.env.NEXOS_API_BASE ?? defaultBase(profile.api.provider);
    const url = `${base.replace(/\/$/, "")}/v1/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modeloEfetivo(this.overridesDoTurno.model ?? profile.api.model),
        // 1024 cortava resposta longa no meio (um card do DS sozinho passa disso); o limite só corta,
        // a cobrança é pelo que sair
        max_tokens: 8192,
        stream: true,
        system: this.opts?.contextPack || undefined,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (res.status === 429) {
      this.handler({ type: "quota" });
      return;
    }
    if (res.status === 401 || res.status === 403) {
      this.handler({ type: "auth", detail: `api ${res.status}: chave inválida ou sem acesso` });
      return;
    }
    if (!res.ok) {
      this.handler({ type: "error", message: `api ${res.status}` });
      return;
    }
    if (this.aborted) return;
    let out: string;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
      const lido = await this.lerStream(res.body);
      if (lido === null) return;
      out = lido;
    } else {
      // provedor/proxy que ignora `stream` e devolve a mensagem inteira
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      out = body.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
    }
    if (this.aborted || this.finished) return;
    if (out) this.handler({ type: "text", text: out });
    this.finished = true;
    this.handler({ type: "done" });
  }

  /**
   * SSE da Messages API: cada `text_delta` vira `text_parcial` (resposta ao vivo — o Canvas do DS
   * desenha o card enquanto chega) e o texto inteiro volta pra virar o `text` final, igual ao CLI.
   * `null` = abortado ou erro já emitido.
   */
  private async lerStream(corpo: ReadableStream<Uint8Array>): Promise<string | null> {
    const leitor = corpo.getReader();
    const dec = new TextDecoder();
    let resto = "";
    let out = "";
    try {
      for (;;) {
        const { value, done } = await leitor.read();
        if (this.aborted) {
          void leitor.cancel().catch(() => {});
          return null;
        }
        if (done) break;
        resto += dec.decode(value, { stream: true });
        let fim: number;
        while ((fim = resto.indexOf("\n\n")) >= 0) {
          const bloco = resto.slice(0, fim);
          resto = resto.slice(fim + 2);
          const dados = bloco
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!dados) continue;
          let ev: { type?: string; delta?: { type?: string; text?: string }; error?: { type?: string; message?: string } };
          try {
            ev = JSON.parse(dados);
          } catch {
            continue;
          }
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            out += ev.delta.text;
            this.handler!({ type: "text_parcial", text: ev.delta.text });
          } else if (ev.type === "error") {
            this.finished = true;
            if (ev.error?.type === "rate_limit_error") this.handler!({ type: "quota" });
            else this.handler!({ type: "error", message: `api: ${ev.error?.message ?? ev.error?.type ?? "erro no stream"}` });
            return null;
          }
        }
      }
    } catch (e) {
      if (this.aborted) return null;
      this.finished = true;
      this.handler!({ type: "error", message: `api: stream caiu (${(e as Error).message})` });
      return null;
    }
    return out;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    if (!this.finished) {
      this.finished = true;
      this.handler?.({ type: "done" });
    }
  }
}

function defaultBase(provider: string): string {
  if (provider === "openai") return "https://api.openai.com";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com";
  return "https://api.anthropic.com";
}

/** "auto" nunca é nome de modelo: sem escolha dinâmica do turno, vale o fallback. */
function modeloEfetivo(model: string): string {
  return model === MODELO_AUTO ? MODELO_AUTO_FALLBACK.model : model;
}
