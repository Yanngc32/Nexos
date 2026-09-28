/**
 * Ponte entre o chat que abriu um plano e o Agent Manager dele (daemon: `ponte-plano.ts`).
 * Aqui só o estado que a tela precisa, derivado dos eventos da conversa: qual plano ela abriu
 * e se o que a pessoa escreve vai pro Manager (`ligada`).
 */

/** Aplica um evento no estado da ponte; devolve o estado novo (ou o mesmo, se não mexe). */
export function aplicarEventoNaPonte(ponte, ev) {
  if (ev?.type === "plano_ligado") return { slug: ev.slug, managerThreadId: ev.managerThreadId, titulo: ev.titulo || ev.slug, ligada: true };
  if (ev?.type === "plano_ponte" && ponte) return { ...ponte, ligada: Boolean(ev.ligada) };
  return ponte ?? null;
}

/** Estado da ponte depois de todos os eventos (histórico da conversa). */
export function ponteDosEventos(eventos) {
  let ponte = null;
  for (const ev of eventos ?? []) ponte = aplicarEventoNaPonte(ponte, ev);
  return ponte;
}

/** Texto da barra acima do composer. */
export function textoDaPonte(ponte) {
  if (!ponte) return "";
  return ponte.ligada
    ? `Conversando com o Agent Manager de “${ponte.titulo}” — o que você escrever aqui vai pra ele.`
    : `Esta conversa abriu o plano “${ponte.titulo}”.`;
}
