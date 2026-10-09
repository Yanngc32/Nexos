/**
 * Torre de magia — as CONTAS como cristais de mana (camada pura).
 *
 * `GET /v1/accounts/limits` → uma célula por conta: brilho = mana restante da janela de 5 h
 * (`1 - fiveHour.utilization`), anel fino = semana, "volta às HH:MM" no limite. Conta sem leitura
 * fica com `semDado` (cristal cinza "sem leitura", nunca "sobrando mana").
 */

/** Hora local `HH:MM` de um instante em segundos (o `resetsAt` do motor). */
export function horaDoReset(resetsAtSegundos) {
  const n = Number(resetsAtSegundos);
  if (!(n > 0)) return "";
  const d = new Date(n * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Janela ainda vale? (o `resetsAt` já passou = a leitura é da janela anterior.) */
function viva(w, agora) {
  if (typeof w?.utilization !== "number") return false;
  const reset = Number(w.resetsAt) * 1000 || 0;
  return !(reset > 0 && reset <= agora);
}

/**
 * @param contas resposta de `/v1/accounts/limits`
 * @returns `[{ id, nome, uso, semana, bloqueada, semDado, resetHora }]` na ordem das contas
 */
export function contasDaTorre(contas, agora = Date.now()) {
  const out = [];
  for (const c of Array.isArray(contas) ? contas : []) {
    if (!c?.id) continue;
    const l = c.limits;
    const bloqueada = l?.status === "blocked" || c.status === "unauthenticated";
    const cinco = viva(l?.fiveHour, agora) ? l.fiveHour : null;
    const sete = viva(l?.sevenDay, agora) ? l.sevenDay : null;
    const semDado = !cinco && !sete && !bloqueada;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    out.push({
      id: c.id,
      nome: c.nickname || c.id,
      uso: bloqueada ? 1 : clamp(cinco?.utilization ?? 0),
      semana: clamp(sete?.utilization ?? 0),
      bloqueada,
      semDado,
      resetHora: horaDoReset(cinco?.resetsAt ?? l?.fiveHour?.resetsAt),
    });
  }
  return out;
}

/** Texto sob o cristal: "62% livre", "volta às 16:40", "sem leitura". */
export function textoDoCristal(c) {
  if (!c || c.semDado) return "sem leitura";
  if (c.bloqueada || c.uso >= 1) return c.resetHora ? `volta às ${c.resetHora}` : "esgotado";
  return `${Math.round((1 - c.uso) * 100)}% livre`;
}
