/**
 * Quem roda o PO: um turno lateral num motor descartável (`turnoDeResumo`), só leitura e sem
 * contexto da conversa, no modelo `poModelo` (Sonnet por padrão). Mesma escolha de conta da análise
 * do aprendizado: conta claude pronta e longe do limite, a parada primeiro; sem nenhuma, a conta da
 * própria conversa (com o motor dela).
 *
 * Imports dinâmicos de propósito: `session.ts` importa o PO, e o PO importar `session.ts` no topo
 * fecharia um ciclo — além de deixar os testes do PO carregarem o motor inteiro à toa.
 */
import type { Profile } from "@nexos/shared";

/** Teto de uma rodada do PO (o fim do turno espera no máximo 30 s; o resto corre solto). */
export const TETO_RODADA_PO_MS = 120_000;

export type RodarPO = (
  prompt: string,
  ctx: { home: string; projectPath: string; threadProfileId?: string; modelo: string },
) => Promise<{ texto: string; rota: string }>;

export const rodarPOPadrao: RodarPO = async (prompt, { home, threadProfileId, modelo }) => {
  const { limitsOf, perfilEmUso, turnoDeResumo } = await import("../session.ts");
  const { applyLoginResult, getProfile, listProfiles } = await import("../profiles.ts");

  // "Perto do limite": a mesma régua da análise do aprendizado (status recusado ou janela alta).
  const pertoDoLimite = (profileId: string): boolean => {
    const l = limitsOf(profileId);
    if (!l) return false;
    if (l.status && l.status !== "allowed" && l.status !== "allowed_warning") return true;
    const uso = (w?: { utilization: number }) => (!w ? 0 : w.utilization > 1 ? w.utilization / 100 : w.utilization);
    return uso(l.fiveHour) >= 0.85 || uso(l.sevenDay) >= 0.95;
  };

  const claudes = listProfiles(home)
    .filter((p) => p.engine === "claude")
    .map((p) => (p.status === "ready" ? p : applyLoginResult(p.id, home)))
    .filter((p) => p.status === "ready" && !pertoDoLimite(p.id))
    // conta parada primeiro: o PO não disputa a quota de quem está trabalhando agora
    .sort((a, b) => Number(perfilEmUso(a.id)) - Number(perfilEmUso(b.id)));
  const claude = claudes[0];
  // cwd = home: o turno do PO não carrega CLAUDE.md/skills do projeto (só o digest importa).
  if (claude) {
    const texto = await turnoDeResumo(claude, home, home, prompt, {
      overrides: { model: modelo },
      tetoMs: TETO_RODADA_PO_MS,
      somenteLeitura: true,
    });
    return { texto, rota: `${claude.id}:${modelo}` };
  }
  const daConversa: Profile | undefined = threadProfileId ? getProfile(threadProfileId, home) : undefined;
  if (!daConversa || daConversa.status !== "ready") throw new Error("nenhuma conta pronta pro PO");
  // Outro motor: o nome do modelo do claude não vale lá — vai o padrão da conta.
  const texto = await turnoDeResumo(daConversa, home, home, prompt, {
    ...(daConversa.engine === "claude" ? { overrides: { model: modelo } } : {}),
    tetoMs: TETO_RODADA_PO_MS,
    somenteLeitura: true,
  });
  return { texto, rota: `${daConversa.id}:${daConversa.engine === "claude" ? modelo : "padrão"}` };
};
