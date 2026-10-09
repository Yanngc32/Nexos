/**
 * Torre de magia — camada 4: os EVENTOS (o que mudou entre dois retratos do modelo).
 *
 * `retratoDaTorre(modelo, agora)` resume cada personagem; `torreEventos(antes, depois)` compara
 * dois resumos. O PRIMEIRO retrato não gera evento nenhum (abrir a aba não dispara oito
 * comemorações) — e quem volta de aba oculta também começa de novo do zero, aplicando o estado
 * direto, sem reencenar o que perdeu.
 *
 * Tipos: `pedido` (turno começou), `ferramenta`, `delegou` (explorador desceu), `voltou` (ok/erro,
 * no pai), `erro`, `terminou`, `pergunta`, `travou`, `plano-enviado` (astrônomo desce pro Salão),
 * `entrou`/`saiu` (mago chegou ou deixou o Salão).
 */

/** Resumo comparável de cada personagem, por torre. */
export function retratoDaTorre(modelo, agora) {
  const personagens = new Map();
  const estrelas = new Map();
  for (const t of modelo?.torres ?? []) {
    // estrelas acesas no mapa estelar (etapas feitas de todos os planos da torre)
    estrelas.set(t.chave, (t.planos ?? []).reduce((n, p) => n + (p.estrelas ?? []).filter((e) => e === "feita").length, 0));
    for (const m of t.magos) {
      personagens.set(m.chave, {
        torre: t.chave,
        tipo: "mago",
        estado: m.estado,
        ferramenta: m.ferramenta,
        travado: m.travado,
        sinalEm: m.sinalEm ?? 0,
        pedidoEm: m.pedidoEm,
        herdouDe: m.herdouDe ?? "",
      });
    }
    for (const a of t.astronomos) personagens.set(a.chave, { torre: t.chave, tipo: "astro", estado: a.estado, threadId: a.threadId });
    for (const e of t.exploradores) {
      personagens.set(e.chave, { torre: t.chave, tipo: "exp", pai: e.pai, aberto: !e.fim, erro: Boolean(e.fim?.erro), descricao: e.descricao ?? "" });
    }
  }
  return { em: agora, personagens, estrelas };
}

const TRABALHANDO = new Set(["trabalhando", "pensando"]);

/** "2 min", "1 h 5 min" — quanto tempo o mago está sem sinal. */
function tempoParado(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/**
 * Eventos entre dois retratos. `antes` nulo = primeiro retrato: nada.
 */
export function torreEventos(antes, depois) {
  if (!antes || !depois) return [];
  const out = [];
  const de = antes.personagens;
  for (const [chave, p] of depois.personagens) {
    const era = de.get(chave);
    if (p.tipo === "exp") {
      if (!era) out.push({ tipo: "delegou", chave: p.pai, explorador: chave, descricao: p.descricao, torre: p.torre });
      else if (era.aberto && !p.aberto) out.push({ tipo: "voltou", chave: p.pai, explorador: chave, ok: !p.erro, torre: p.torre });
      continue;
    }
    if (p.tipo === "mago" && !era) {
      out.push({ tipo: "entrou", chave, torre: p.torre });
      if (p.herdouDe) out.push({ tipo: "plano-enviado", chave, manager: p.herdouDe, torre: p.torre });
      // turno que começou depois do retrato anterior: o mago chega já pedindo
      if (TRABALHANDO.has(p.estado) && p.pedidoEm > antes.em) out.push({ tipo: "pedido", chave, torre: p.torre });
      if (p.estado === "esperando") out.push({ tipo: "pergunta", chave, torre: p.torre });
      continue;
    }
    if (!era) continue;
    if (TRABALHANDO.has(p.estado) && !TRABALHANDO.has(era.estado) && era.estado !== "segundo-plano") {
      out.push({ tipo: "pedido", chave, torre: p.torre });
    }
    if (p.estado === "esperando" && era.estado !== "esperando") out.push({ tipo: "pergunta", chave, torre: p.torre });
    if (p.estado === "erro" && era.estado !== "erro") out.push({ tipo: "erro", chave, torre: p.torre });
    if (p.estado === "terminou" && era.estado !== "terminou" && era.estado !== "ocioso") out.push({ tipo: "terminou", chave, torre: p.torre });
    if (p.estado === "trabalhando" && p.ferramenta && p.ferramenta !== era.ferramenta) {
      out.push({ tipo: "ferramenta", chave, nome: p.ferramenta, torre: p.torre });
    }
    if (p.travado && !era.travado) out.push({ tipo: "travou", chave, tempo: tempoParado(depois.em - p.sinalEm), torre: p.torre });
  }
  for (const [chave, era] of de) {
    if (era.tipo === "mago" && !depois.personagens.has(chave)) out.push({ tipo: "saiu", chave, torre: era.torre });
  }
  // uma estrela acendeu no mapa estelar: todo mundo da torre olha pra cima
  for (const [torre, n] of depois.estrelas ?? []) if (n > (antes.estrelas?.get(torre) ?? n)) out.push({ tipo: "estrela", torre });
  return out;
}
