/**
 * Torre de magia — camada 3: os LUGARES (mesa de cada mago no Salão).
 *
 * Regra do escritório do agent-code, que é o que impede "mago trocou de mesa sozinho":
 * - quem já tem mesa FICA nela (ninguém é empurrado pra arrumar a fila);
 * - mesa livre vai pra quem chegou, na ordem de prioridade (esperando você > trabalhando > parado
 *   mais recente), sempre a de menor número;
 * - Salão cheio: cede o PARADO com atividade mais antiga, e só pra quem tem pendência ou é mais
 *   recente que ele; quem não coube vira "+N" na porta;
 * - conversa esperando você nunca cede a mesa.
 */
import { ESTADOS_PENDENTES } from "./modelo.js";

export const MESAS_TETO = 8;

function prioridade(m) {
  if (m.estado === "esperando") return 0;
  if (ESTADOS_PENDENTES.has(m.estado)) return 1;
  return 2;
}

/** Ordem de quem escolhe mesa primeiro: pendência antes, depois o mais recente. */
function ordemDeChegada(a, b) {
  return prioridade(a) - prioridade(b) || b.fimEm - a.fimEm || a.chave.localeCompare(b.chave);
}

/** Pode tirar `sentado` da mesa pra dar a `chegou`? */
function podeCeder(sentado, chegou) {
  if (prioridade(sentado) < 2) return false;
  return prioridade(chegou) < 2 || chegou.fimEm > sentado.fimEm;
}

/**
 * @param magos   personagens do Salão (do modelo), com `chave`, `estado`, `fimEm`
 * @param anterior resultado anterior (ou null no primeiro)
 * @returns `{ mesas: Map<chave, índice>, escondidos: chave[] }`
 */
export function torreLugares(magos, anterior, teto = MESAS_TETO) {
  const mesas = new Map();
  const ocupadas = new Map(); // índice → mago
  const lista = Array.isArray(magos) ? magos : [];
  const presentes = new Map(lista.map((m) => [m.chave, m]));

  // 1. quem já tinha mesa (e continua aqui) fica nela
  for (const [chave, i] of anterior?.mesas ?? []) {
    const m = presentes.get(chave);
    if (!m || i >= teto || ocupadas.has(i)) continue;
    mesas.set(chave, i);
    ocupadas.set(i, m);
  }

  // 2. quem chegou escolhe, por prioridade
  const semMesa = lista.filter((m) => !mesas.has(m.chave)).sort(ordemDeChegada);
  const escondidos = [];
  for (const m of semMesa) {
    let livre = -1;
    for (let i = 0; i < teto; i++) {
      if (!ocupadas.has(i)) {
        livre = i;
        break;
      }
    }
    if (livre < 0) {
      // cheio: o parado mais antigo cede, se for o caso
      let alvo = -1;
      for (const [i, s] of ocupadas) {
        if (!podeCeder(s, m)) continue;
        if (alvo < 0 || s.fimEm < ocupadas.get(alvo).fimEm) alvo = i;
      }
      if (alvo >= 0) {
        const saiu = ocupadas.get(alvo);
        mesas.delete(saiu.chave);
        escondidos.push(saiu.chave);
        livre = alvo;
      }
    }
    if (livre < 0) {
      escondidos.push(m.chave);
      continue;
    }
    mesas.set(m.chave, livre);
    ocupadas.set(livre, m);
  }
  return { mesas, escondidos };
}
