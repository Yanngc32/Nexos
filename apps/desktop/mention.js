/**
 * Parser de `@menção` do composer — função pura, sem DOM: testa no node.
 *
 * O id casado espelha `AGENT_ID_RE`/`TEAM_ID_RE` de `packages/shared`: minúsculo, começa em
 * letra ou número, até 40 caracteres de letra/número/`-`/`_`. A regra é duplicada aqui de
 * propósito — o desktop não depende do pacote `shared` — e não por descuido: mudar o formato
 * do id lá exige lembrar de mudar aqui também.
 */
const MENCAO_RE = /(^|\s)@([a-z0-9][a-z0-9_-]{0,39})(?=\s|$)/g;

/**
 * Ids citados, na ordem em que apareceram e sem repetir, e o texto que sobra pra virar o
 * `goal` do Run — menções removidas, espaço colapsado.
 *
 * Mensagem só com menção, sem sobrar texto nenhum, cai de volta na mensagem inteira: um Run
 * sem pedido nenhum não ajuda o agente citado a saber o que fazer.
 */
export function extrairMencoes(texto) {
  const bruto = String(texto ?? "");
  const ids = [];
  const vistos = new Set();
  for (const m of bruto.matchAll(MENCAO_RE)) {
    const id = m[2];
    if (vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  const semMencoes = bruto.replace(MENCAO_RE, " ").replace(/\s+/g, " ").trim();
  return { ids, goal: semMencoes || bruto.trim() };
}
