/**
 * Textos e listas da seção "Nas conversas" da tela do agente (agent-studio.js): agente usado como
 * subagente nativo do `claude` (`--agents`). Puro, sem DOM — o studio só pinta o que sai daqui.
 */

/** Mesmo teto do daemon (`SUBAGENTES_MAX` em @nexos/shared). */
export const SUBAGENTES_MAX = 6;

/** Mesma pasta escrita de jeitos diferentes (barra, caixa, barra no fim) é a mesma pasta. */
export function chaveDePasta(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Último trecho do caminho: é o que a pessoa reconhece numa lista de projetos. */
export function nomeDaPasta(p) {
  const partes = String(p || "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/);
  return partes[partes.length - 1] || String(p || "");
}

/**
 * Projetos que a lista mostra: os conhecidos + os já marcados que não estão entre eles (escopo
 * salvo em outra máquina). Sem isso, salvar o agente aqui apagaria o escopo de lá.
 */
export function opcoesDeProjeto(repos, marcados) {
  const vistos = new Set();
  const out = [];
  const marcadosSet = new Set((marcados || []).map(chaveDePasta));
  for (const p of [...(repos || []), ...(marcados || [])]) {
    const k = chaveDePasta(p);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    out.push({ caminho: p, nome: nomeDaPasta(p), marcado: marcadosSet.has(k) });
  }
  return out;
}

/**
 * "3 de 6 ligados" — conta este agente pelo estado do formulário, não pelo salvo. `cheio` = os
 * OUTROS já ocupam todas as vagas: ligar este aqui seria recusado ao salvar.
 */
export function textoDaVaga(defs, idEditando, ligadoAqui) {
  const outros = (defs || []).filter((d) => d.subagente && d.id !== idEditando).length;
  const total = Math.min(SUBAGENTES_MAX, outros + (ligadoAqui ? 1 : 0));
  return { texto: `${total} de ${SUBAGENTES_MAX} ligados`, cheio: outros >= SUBAGENTES_MAX };
}

function dataCurta(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/**
 * O que a seção diz sobre o uso real. Ligado e nunca chamado é o caso que importa: é o sinal de
 * que a descrição não diz quando usar (ou de que o agente não serve como subagente).
 */
export function textoDoUso(uso, ligado) {
  const usos = uso?.usos ?? 0;
  if (usos > 0) {
    const quando = dataCurta(uso.ultimoUso);
    return `Chamado ${usos}× pelas conversas${quando ? ` · último em ${quando}` : ""}.`;
  }
  if (!ligado) return "";
  return "Ainda não foi chamado por nenhuma conversa. Se continuar assim, a descrição provavelmente não diz quando usar.";
}
