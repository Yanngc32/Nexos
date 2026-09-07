import type { PackConfig, ThreadEvent } from "@nexo/shared";

export type PackResult = {
  text: string;
  trimmed?: { keptMessages: number; droppedMessages: number };
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function render(event: ThreadEvent): string | undefined {
  switch (event.type) {
    case "thread_meta":
    case "context_trimmed":
    case "cleared":
    case "usage":
      return undefined;
    case "user":
      // O caminho da imagem entra no pack: nos turnos seguintes o motor ainda sabe abrir.
      return event.attachments?.length
        ? [`User: ${event.text}`, ...event.attachments.map((a) => `[imagem anexada: ${a.path}]`)].join("\n")
        : `User: ${event.text}`;
    case "assistant":
      return `Assistant: ${event.text}`;
    case "tool":
      return `Agente executou ${event.name}: ${event.summary}`;
    case "switched":
      return `System: switched ${event.fromProfileId} -> ${event.toProfileId} (${event.reason})`;
    case "error":
      return `System: error ${event.message}`;
  }
}

function isKeepable(event: ThreadEvent): boolean {
  return event.type === "user" || event.type === "assistant";
}

/**
 * Teto do pack quando a janela do motor é desconhecida. Era o teto ÚNICO até
 * aqui, então manter esse valor é o que garante que nada regride: motor sem
 * janela conhecida continua se comportando exatamente como antes.
 */
export const TOKEN_CAP_PISO = 8000;

/**
 * Metade da janela vai pro histórico. A outra metade não é folga: ela paga o
 * system prompt, as instruções do agente, a definição das ferramentas, o
 * resultado de cada ida e volta de ferramenta DENTRO do turno, e a resposta.
 * Mandar histórico até encostar na janela faria o turno estourar no meio.
 */
const FRACAO = 0.5;

/**
 * Teto do teto. O pack vai inteiro em TODO turno, então uma janela de 1M sem
 * limite mandaria 500 mil tokens por mensagem — dólares por turno numa
 * conversa que ninguém pediu que fosse caro. 128k já é uma conversa longuíssima;
 * o que passa disso vale menos que o que custa.
 */
const TETO = 128_000;

/**
 * Quanto de histórico cabe, dada a janela do motor.
 *
 * Existe porque o teto era 8000 pra toda conta: uma janela de 1M recebia o
 * mesmo corte de uma de 8k, e conversa longa "esquecia" coisa que caberia
 * folgado. O `estimateTokens` acima é aproximado (4 chars por token), e a
 * fração também absorve esse erro.
 */
export function tetoDeToken(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return TOKEN_CAP_PISO;
  const alvo = Math.floor(contextWindow * FRACAO);
  return Math.min(TETO, Math.max(TOKEN_CAP_PISO, alvo));
}

export function pack(events: ThreadEvent[], packCfg: PackConfig, tokenCap: number): PackResult {
  // "/clear" marca um corte: tudo antes fica só no JSONL, nunca mais vai pro motor.
  const lastClear = events.map((e) => e.type).lastIndexOf("cleared");
  const scoped = lastClear === -1 ? events : events.slice(lastClear + 1);

  const lines: { event: ThreadEvent; text: string; keepable: boolean }[] = [];
  for (const event of scoped) {
    const text = render(event);
    if (text === undefined) continue;
    lines.push({ event, text, keepable: isKeepable(event) });
  }

  const full = lines.map((l) => l.text).join("\n");
  if (estimateTokens(full) <= tokenCap) return { text: full };

  const keepable = lines.filter((l) => l.keepable);
  const kept = keepable.slice(-packCfg.keepLastMessages);
  const dropped = keepable.slice(0, Math.max(0, keepable.length - kept.length));
  const prefixRaw = dropped.map((l) => l.text).join(" ");
  const prefix = prefixRaw.slice(0, packCfg.prefixCharBudget);
  const suffix = kept.map((l) => l.text).join("\n");
  const text = `Contexto anterior (cortado):${prefix ? ` ${prefix}` : ""}\n${suffix}`.trim();
  return {
    text,
    trimmed: {
      keptMessages: kept.length,
      droppedMessages: dropped.length,
    },
  };
}
