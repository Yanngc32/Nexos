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
