/**
 * Agrupa as conversas de um projeto pra lista lateral.
 *
 * O problema: um run de time cria uma conversa por passo, e o supervisor cria
 * quantas ele quiser. Soltas na lista, elas afogam as conversas de verdade —
 * dez linhas do mesmo run empurrando pra baixo o que a pessoa estava fazendo.
 *
 * A regra é uma só: conversa carimbada com `runId` entra no grupo daquele run;
 * o resto fica solto, como sempre esteve. Nada aqui consulta o daemon — o
 * carimbo vem no `thread_meta` justamente pra isso.
 */

/** Um run com uma conversa só não vira grupo: a pasta a mais só esconderia. */
const MINIMO_PRO_GRUPO = 2;

/**
 * @returns lista de entradas na ordem em que devem aparecer. Cada entrada é
 * `{tipo: "conversa", thread}` ou `{tipo: "run", runId, titulo, threads}`.
 */
export function agruparConversas(threads) {
  const lista = Array.isArray(threads) ? threads : [];
  const grupos = new Map();

  for (const t of lista) {
    if (!t?.runId) continue;
    const g = grupos.get(t.runId) ?? { runId: t.runId, titulo: "", threads: [] };
    if (!g.titulo && t.runTitle) g.titulo = t.runTitle;
    g.threads.push(t);
    grupos.set(t.runId, g);
  }
  // run de um passo só não compensa a pasta
  for (const [id, g] of grupos) if (g.threads.length < MINIMO_PRO_GRUPO) grupos.delete(id);

  const saida = [];
  const jaPosto = new Set();
  for (const t of lista) {
    const g = t?.runId ? grupos.get(t.runId) : undefined;
    if (!g) {
      saida.push({ tipo: "conversa", thread: t });
      continue;
    }
    // o grupo entra na posição da conversa MAIS RECENTE dele: a lista já vem
    // ordenada por atualização, então isso mantém o run onde a pessoa espera
    if (jaPosto.has(g.runId)) continue;
    jaPosto.add(g.runId);
    saida.push({
      tipo: "run",
      runId: g.runId,
      titulo: g.titulo || "Execução de time",
      // dentro do grupo a ordem é a do RUN, não a de atualização: passo 1, 2, 3
      threads: [...g.threads].sort((a, b) => (a.runStep ?? 0) - (b.runStep ?? 0)),
    });
  }
  return saida;
}
