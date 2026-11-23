/**
 * Quem roda o modelo do memorista e do curador: um turno lateral num motor descartável
 * (`turnoDeResumo`), só leitura, sem contexto da conversa e com cwd = home (o turno não carrega
 * CLAUDE.md/skills de projeto — só o digest importa). Mesma escolha de conta do PO: conta claude
 * pronta e longe do limite, a parada primeiro; sem nenhuma, a conta da própria conversa.
 *
 * Imports dinâmicos de propósito: `session.ts` vai chamar o memorista, e importar `session.ts` no
 * topo fecharia um ciclo — além de os testes da memória carregarem o motor inteiro à toa.
 */
import type { Profile } from "@nexos/shared";

export type RodarModelo = (
  prompt: string,
  ctx: { home: string; modelo: string; tetoMs: number; threadProfileId?: string },
) => Promise<string>;

/** Aviso de que o memorista/curador gravou uma memória (o chamador mostra ou registra). */
export type EventoMemoriaSalva = {
  relPath: string;
  titulo: string;
  op: "create" | "update" | "retire";
  origem: "memorista" | "curador";
  threadId?: string;
};

export const rodarModeloLateral: RodarModelo = async (prompt, { home, modelo, tetoMs, threadProfileId }) => {
  const { limitsOf, perfilEmUso, turnoDeResumo } = await import("../session.ts");
  const { applyLoginResult, getProfile, listProfiles } = await import("../profiles.ts");

  // "Perto do limite": status recusado ou janela alta — a mesma régua do PO.
  const pertoDoLimite = (profileId: string): boolean => {
    const l = limitsOf(profileId);
    if (!l) return false;
    if (l.status && l.status !== "allowed" && l.status !== "allowed_warning") return true;
    const uso = (w?: { utilization: number }) => (!w ? 0 : w.utilization > 1 ? w.utilization / 100 : w.utilization);
    return uso(l.fiveHour) >= 0.85 || uso(l.sevenDay) >= 0.95;
  };

  const claude = listProfiles(home)
    .filter((p) => p.engine === "claude")
    .map((p) => (p.status === "ready" ? p : applyLoginResult(p.id, home)))
    .filter((p) => p.status === "ready" && !pertoDoLimite(p.id))
    // conta parada primeiro: a memória não disputa a quota de quem está trabalhando agora
    .sort((a, b) => Number(perfilEmUso(a.id)) - Number(perfilEmUso(b.id)))[0];
  if (claude) {
    return turnoDeResumo(claude, home, home, prompt, { overrides: { model: modelo }, tetoMs, somenteLeitura: true });
  }
  const daConversa: Profile | undefined = threadProfileId ? getProfile(threadProfileId, home) : undefined;
  if (!daConversa || daConversa.status !== "ready") throw new Error("nenhuma conta pronta para a memória");
  // Outro motor: o nome do modelo do claude não vale lá — vai o padrão da conta.
  return turnoDeResumo(daConversa, home, home, prompt, {
    ...(daConversa.engine === "claude" ? { overrides: { model: modelo } } : {}),
    tetoMs,
    somenteLeitura: true,
  });
};
