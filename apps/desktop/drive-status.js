/** Acima disto uma rodada de sync em voo vira aviso em destaque (algo está pesado demais). */
export const SYNC_LONGO_MS = 10 * 60_000;

/**
 * Texto da rodada de sync em voo, a partir de `GET /v1/drive` (`emAndamentoDesde`, `pendentes`).
 * Antes era só "Sincronizando…" pra sempre — a rodada que nunca terminava ficava invisível.
 */
export function textoSyncEmAndamento(drive, agora = Date.now()) {
  const desde = Date.parse(drive?.emAndamentoDesde ?? "");
  if (!Number.isFinite(desde)) return { texto: "Sincronizando…", longo: false };
  const ms = Math.max(0, agora - desde);
  const min = Math.floor(ms / 60_000);
  const quanto = min < 1 ? "há menos de 1 min" : `há ${min} min`;
  const n = Number(drive.pendentes) || 0;
  const pend = n ? `, ${n} arquivo${n === 1 ? "" : "s"} pendente${n === 1 ? "" : "s"}` : "";
  const longo = ms > SYNC_LONGO_MS;
  return {
    texto: `Sincronizando ${quanto}${pend}.${longo ? " Está demorando mais que o normal — veja o daemon.log." : ""}`,
    longo,
  };
}
