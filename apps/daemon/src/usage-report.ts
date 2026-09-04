import type { LimitsInfo, SessionInfo, UsageWindow } from "@nexo/shared";
import { contextWindowOf } from "./engines/parse-claude.ts";
import { getProfile } from "./profiles.ts";
import { getLive, limitsOf } from "./session.ts";
import { activeProfileId, readThread, threadUsage, type ThreadUsage } from "./threads.ts";

/** Janela do modelo quando nenhum turno rodou ainda e não há nome de modelo. */
const CONTEXT_FALLBACK = 200_000;

export type ThreadReport = {
  profileId: string;
  model: string;
  effort: string;
  permissionMode: string;
  totals: ThreadUsage;
  session: SessionInfo;
  limits: LimitsInfo | null;
};

/**
 * Foto de consumo da thread: total do JSONL + o que o motor vivo já contou.
 * Só lê disco e memória — nunca spawna motor, nunca gasta token.
 */
export function threadReport(id: string, home: string): ThreadReport {
  const totals = threadUsage(id, home);
  const profileId = activeProfileId(readThread(id, home));
  const profile = getProfile(profileId, home);
  const live = getLive(id);
  const session: SessionInfo = live?.session ?? {
    contextWindow: totals.model ? contextWindowOf(totals.model) : CONTEXT_FALLBACK,
    ...(totals.model ? { model: totals.model } : {}),
  };
  return {
    profileId,
    model: profile?.model ?? "",
    effort: profile?.effort ?? "",
    permissionMode: profile?.permissionMode ?? "",
    totals,
    session,
    limits: live?.limits ?? limitsOf(profileId) ?? null,
  };
}

export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** Igual ao painel: contagem curta pra hoje, dia da semana pra depois. */
export function fmtReset(unixSeconds: number, now = Date.now()): string {
  const ms = Number(unixSeconds) * 1000;
  if (!ms || Number.isNaN(ms)) return "";
  const diff = ms - now;
  if (diff <= 0) return "reinicia agora";
  if (diff < 24 * 3600_000) {
    const h = Math.floor(diff / 3600_000);
    const m = Math.round((diff % 3600_000) / 60_000);
    return h ? `reinicia em ${h} h ${m} min` : `reinicia em ${m} min`;
  }
  const d = new Date(ms);
  const dia = d.toLocaleDateString("pt-BR", { weekday: "short" });
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `reinicia ${dia} ${hora}`;
}

function row(label: string, value: string): string {
  return `${label.padEnd(13)}${value}`;
}

/** `/cost`: total acumulado da conversa. */
export function costLines(totals: ThreadUsage): string[] {
  if (totals.turns === 0) return ["sem turno nesta conversa ainda"];
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheCreate;
  const lines = [
    row("turnos", String(totals.turns)),
    row("entrada", fmtTokens(totals.input)),
    row("saída", fmtTokens(totals.output)),
    row("cache lido", fmtTokens(totals.cacheRead)),
    row("cache criado", fmtTokens(totals.cacheCreate)),
  ];
  if (totals.thinking > 0) lines.push(row("raciocínio", fmtTokens(totals.thinking)));
  lines.push(row("total", fmtTokens(total)));
  lines.push(row("custo", totals.costUsd ? `US$ ${totals.costUsd.toFixed(4)}` : "— (motor não reporta)"));
  return lines;
}

/** `/context`: quanto da janela o último turno ocupou. */
export function contextLines(totals: ThreadUsage, session: SessionInfo): string[] {
  const win = session.contextWindow || CONTEXT_FALLBACK;
  const used = totals.contextTokens;
  const pct = win > 0 ? Math.min(1, used / win) : 0;
  return [
    row("modelo", session.model ?? totals.model ?? "(padrão do CLI)"),
    row("janela", fmtTokens(win)),
    row("em uso", used ? `${fmtTokens(used)} (${Math.round(pct * 100)}%)` : "— (sem turno ainda)"),
  ];
}

function windowLine(label: string, w: UsageWindow | undefined): string {
  if (!w) return row(label, "sem dado ainda");
  const reset = fmtReset(w.resetsAt);
  return row(label, `${Math.round(w.utilization * 100)}%${reset ? ` · ${reset}` : ""}`);
}

/** `/usage`: cota do plano por janela, como o motor reportou no último turno. */
export function limitsLines(limits: LimitsInfo | null): string[] {
  if (!limits || (!limits.fiveHour && !limits.sevenDay)) {
    return ["cota: sem dado ainda — o motor só reporta depois de um turno"];
  }
  const lines = [windowLine("5 h", limits.fiveHour), windowLine("semana", limits.sevenDay)];
  if (limits.status) lines.push(row("status", limits.status));
  return lines;
}
