import type { EngineEvent } from "@nexo/shared";

export const LIMIT_RE =
  /rate_limit|\bquota\b|\b429\b|session limit|usage limit|hit your (session )?limit|you've hit your/i;

/**
 * Aviso de limite é sempre curto. Texto longo aqui é conteúdo de arquivo lido
 * por ferramenta — e código que fala de "quota" já se passou por aviso de quota.
 */
const CLASSIFY_MAX = 600;

export function isLimitText(s: string): boolean {
  return s.length <= CLASSIFY_MAX && LIMIT_RE.test(s);
}

/** Nada que vá pra UI passa de um parágrafo. */
function cap(s: string, max = CLASSIFY_MAX): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Falha de credencial: token vencido/revogado. Retry não resolve — só login novo. */
export const AUTH_RE =
  /failed to authenticate|oauth (session|token) (expired|revoked)|could not be refreshed|authentication_error|invalid_(token|grant|api_key)|credentials? (expired|invalid)|not logged in|log ?in again|please run .{0,4}\/login/i;

export function isAuthText(s: string): boolean {
  return s.length <= CLASSIFY_MAX && AUTH_RE.test(s);
}

const AUTH_STATUS_RE = /\b401\b/;

function asText(v: unknown, depth = 0): string {
  if (v == null || depth > 4) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => asText(x, depth + 1)).filter(Boolean).join(" ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const kind = typeof o.type === "string" ? o.type : "";
    const msg =
      asText(o.message, depth + 1) || asText(o.result, depth + 1) || asText(o.error, depth + 1) || asText(o.detail, depth + 1);
    if (msg && kind && !msg.includes(kind)) return `${kind}: ${msg}`;
    if (msg) return msg;
    if (kind) return kind;
    // serializar objeto desconhecido só se for pequeno: era isso que jogava
    // um tool_result inteiro (arquivo lido) dentro da mensagem de erro
    try {
      const raw = JSON.stringify(v);
      return raw && raw.length <= CLASSIFY_MAX ? raw : "";
    } catch {
      return "";
    }
  }
  return "";
}

function flattenClaude(obj: Record<string, unknown>): string {
  return [asText(obj.result), asText(obj.error), asText(obj.message)]
    .filter(Boolean)
    .join(" — ")
    .replace(/\[object Object\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function prettyQuota(raw: string): string {
  const t = cap(raw.replace(/\[object Object\]/gi, " ").replace(/\s+/g, " "));
  if (/you've hit your|session limit|usage limit|resets \d/i.test(t)) return t;
  if (/rate_limit|\bquota\b|\b429\b/i.test(t)) {
    return "Limite de uso do Claude (rate limit). Espera um pouco ou troca de conta.";
  }
  return t || "Limite de uso do Claude.";
}

function quotaEvent(detail?: string): EngineEvent {
  const d = detail?.trim();
  return d ? { type: "quota", detail: d } : { type: "quota" };
}

export function prettyAuth(raw: string): string {
  return cap(raw.replace(/\[object Object\]/gi, " ").replace(/\s+/g, " "));
}

function authEvent(detail?: string): EngineEvent {
  const d = detail ? prettyAuth(detail) : "";
  return d ? { type: "auth", detail: d } : { type: "auth" };
}

const SUMMARY_MAX = 160;

function short(v: unknown, max = SUMMARY_MAX): string {
  const t = String(v ?? "")
    .replace(/[\u005c]/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Caminho fica no que importa: as duas últimas pastas + arquivo. */
function tail(path: unknown, keep = 3): string {
  const parts = String(path ?? "")
    .replace(/[\u005c]/g, "/")
    .split("/")
    .filter(Boolean);
  const cut = parts.slice(-keep).join("/");
  return short(parts.length > keep ? `…/${cut}` : cut);
}

/**
 * Resumo legível por ferramenta. Antes ia `JSON.stringify(input)` cortado em 200,
 * que quebrava no meio do caminho e vazava barras escapadas pra tela.
 */
export function toolSummary(name: string, input: unknown): string {
  const arg = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read":
    case "Write":
    case "NotebookEdit":
      return tail(arg.file_path ?? arg.notebook_path ?? arg.path);
    case "Edit": {
      const alvo = tail(arg.file_path);
      const trecho = short(arg.old_string, 40);
      return trecho ? `${alvo} · troca "${trecho}"` : alvo;
    }
    case "Grep": {
      const onde = arg.path ? ` em ${tail(arg.path)}` : "";
      const filtro = arg.glob ? ` (${short(arg.glob, 30)})` : "";
      return `${short(arg.pattern, 80)}${onde}${filtro}`;
    }
    case "Glob":
      return short(arg.pattern, 100) + (arg.path ? ` em ${tail(arg.path)}` : "");
    case "Bash":
      return short(String(arg.command ?? "").split("\n")[0]);
    case "WebFetch":
      return short(arg.url, 100);
    case "WebSearch":
      return short(arg.query, 100);
    case "Task":
    case "Agent":
      return short(arg.description ?? arg.subagent_type);
    case "TodoWrite":
      return Array.isArray(arg.todos) ? `${arg.todos.length} item(s)` : "";
    default: {
      const pares = Object.entries(arg)
        .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        .slice(0, 3)
        .map(([k, v]) => `${k}=${short(v, 40)}`);
      return short(pares.join(" · "));
    }
  }
}

/**
 * `message.usage` é do request individual (a resposta que acabou de chegar), diferente
 * do `usage` do evento "result" que soma todos os requests internos do turno (tool loop).
 * É esse valor por request que reflete o que está ocupando a janela agora.
 */
function contextEventFrom(usage: unknown): EngineEvent | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const contextTokens = int(u.input_tokens) + int(u.cache_read_input_tokens) + int(u.cache_creation_input_tokens);
  return contextTokens > 0 ? { type: "context", contextTokens } : undefined;
}

function contentToEvents(message: { content?: unknown; usage?: unknown } | undefined): EngineEvent[] {
  const out: EngineEvent[] = [];
  const ctx = contextEventFrom(message?.usage);
  if (ctx) out.push(ctx);
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; text?: string; name?: string; input?: unknown };
      if (b.type === "text" && b.text) out.push({ type: "text", text: b.text });
      // thinking do bloco completo é ignorado: já veio em delta pelo stream_event.
      if (b.type === "tool_use") {
        out.push({ type: "tool", name: b.name ?? "tool", summary: toolSummary(b.name ?? "", b.input) });
      }
    }
  }
  return out;
}

type StreamDelta = { type?: string; text?: string; thinking?: string; estimated_tokens?: unknown };

function thinkingEvent(d: StreamDelta): EngineEvent {
  const text = typeof d.thinking === "string" ? d.thinking : "";
  const tokens = typeof d.estimated_tokens === "number" ? d.estimated_tokens : undefined;
  return {
    type: "thinking",
    ...(text ? { text } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

/**
 * Com --include-partial-messages o pensamento chega em delta. Só thinking interessa:
 * o texto da resposta vem inteiro no assistant, então text_delta duplicaria.
 * O CLI zera o campo `thinking` — o que dá pra mostrar é o progresso em tokens.
 */
function streamEventToEvents(obj: Record<string, unknown>): EngineEvent[] {
  const event = obj.event as { delta?: StreamDelta; content_block?: StreamDelta } | undefined;
  if (event?.delta?.type === "thinking_delta") return [thinkingEvent(event.delta)];
  if (event?.content_block?.type === "thinking") return [thinkingEvent(event.content_block)];
  return [];
}

const CONTEXT_1M = 1_000_000;
const CONTEXT_DEFAULT = 200_000;

/** O CLI escreve a janela no nome: "claude-opus-5[1m]". Sem sufixo, 200k. */
export function contextWindowOf(model: string): number {
  return /\[1m\]/i.test(model) ? CONTEXT_1M : CONTEXT_DEFAULT;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function usageEvents(obj: Record<string, unknown>): EngineEvent[] {
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!usage) return [];
  const input = int(usage.input_tokens);
  const cacheRead = int(usage.cache_read_input_tokens);
  const cacheCreate = int(usage.cache_creation_input_tokens);
  const details = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinking = int(details?.thinking_tokens);
  const cost = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined;
  return [
    {
      type: "usage",
      input,
      output: int(usage.output_tokens),
      cacheRead,
      cacheCreate,
      contextTokens: input + cacheRead + cacheCreate,
      ...(thinking ? { thinking } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    },
  ];
}

function sessionEvents(obj: Record<string, unknown>): EngineEvent[] {
  if (obj.subtype !== "init") return [];
  const model = typeof obj.model === "string" ? obj.model : "";
  const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
  const version = typeof obj.claude_code_version === "string" ? obj.claude_code_version : undefined;
  return [
    {
      type: "session",
      contextWindow: contextWindowOf(model),
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(version ? { version } : {}),
    },
  ];
}

type UnifiedWindow = { utilization?: unknown; resetsAt?: unknown };

function windowOf(raw: unknown): { utilization: number; resetsAt: number } | undefined {
  const w = raw as UnifiedWindow | undefined;
  if (!w || typeof w.utilization !== "number") return undefined;
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : 0,
  };
}

type RateLimitInfo = {
  status?: unknown;
  resetsAt?: unknown;
  rateLimitType?: unknown;
  unifiedWindows?: Record<string, unknown>;
};

/** rate_limit_event é telemetria de uso; só vira quota quando não está mais liberado. */
function rateLimitToEvents(obj: Record<string, unknown>): EngineEvent[] {
  const info = obj.rate_limit_info as RateLimitInfo | undefined;
  const status = typeof info?.status === "string" ? info.status : "";
  const fiveHour = windowOf(info?.unifiedWindows?.five_hour);
  const sevenDay = windowOf(info?.unifiedWindows?.seven_day);
  const limits: EngineEvent[] =
    fiveHour || sevenDay
      ? [
          {
            type: "limits",
            ...(status ? { status } : {}),
            ...(fiveHour ? { fiveHour } : {}),
            ...(sevenDay ? { sevenDay } : {}),
          },
        ]
      : [];
  /*
   * "allowed_warning" é aviso de aproximação, não estouro: a conta continua
   * servindo. Tratar como quota terminava o turno, gravava erro no histórico,
   * pausava a fila e — em switchMode auto — trocava de conta sozinho com a
   * conta ainda utilizável. Só status fora da família "allowed" é bloqueio.
   */
  if (!status || status.startsWith("allowed")) return limits;
  const resets = typeof info?.resetsAt === "number" ? new Date(info.resetsAt * 1000) : undefined;
  const when = resets ? ` Volta ${resets.toLocaleString("pt-BR")}.` : "";
  const janela = typeof info?.rateLimitType === "string" ? ` (${info.rateLimitType})` : "";
  return [...limits, quotaEvent(`Limite de uso${janela}: ${status}.${when}`)];
}

export function parseClaudeJson(obj: Record<string, unknown>): EngineEvent[] {
  const type = String(obj.type ?? "");
  if (type === "stream_event") return streamEventToEvents(obj);
  if (type === "rate_limit_event") return rateLimitToEvents(obj);
  // eco do tool_result: o resultado da ferramenta já foi mostrado como evento tool
  if (type === "user") return [];
  const flat = flattenClaude(obj);
  if (type !== "assistant" && isAuthText(flat)) return [authEvent(flat)];
  if (type !== "assistant" && isLimitText(flat)) return [quotaEvent(prettyQuota(flat))];
  if (type === "system") return sessionEvents(obj);
  if (type === "result") {
    if (obj.is_error) {
      const msg = cap(flat) || "erro no motor";
      if (isAuthText(msg) || AUTH_STATUS_RE.test(msg)) return [authEvent(msg)];
      if (isLimitText(msg)) return [quotaEvent(prettyQuota(msg))];
      return [{ type: "error", message: msg }];
    }
    return usageEvents(obj);
  }
  if (type === "error") {
    const msg = cap(flat) || "erro no motor";
    if (isAuthText(msg) || AUTH_STATUS_RE.test(msg)) return [authEvent(msg)];
    if (isLimitText(msg)) return [quotaEvent(prettyQuota(msg))];
    return [{ type: "error", message: msg }];
  }
  if (type === "assistant") {
    const message = obj.message as { content?: unknown; usage?: unknown } | undefined;
    return contentToEvents(message);
  }
  const delta =
    (obj.delta as { text?: string } | undefined) ??
    ((obj.event as { delta?: { text?: string } } | undefined)?.delta);
  if (delta?.text) return [{ type: "text", text: delta.text }];
  return [];
}

export function parseCliLine(line: string): EngineEvent[] {
  if (!line) return [];
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      return parseClaudeJson(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      /* texto comum que começa com { */
    }
  }
  if (isAuthText(line)) return [authEvent(trimmed)];
  if (isLimitText(line)) return [quotaEvent(prettyQuota(trimmed))];
  if (line.startsWith("tool:")) {
    const [name, ...rest] = line.slice(5).split(" ");
    return [{ type: "tool", name: name ?? "tool", summary: rest.join(" ") }];
  }
  return [{ type: "text", text: line }];
}
