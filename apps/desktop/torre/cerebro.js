/**
 * Torre de magia — camada 5: o CÉREBRO de cada mago (máquina de estados pura, sorteio injetado).
 *
 * Adaptado do `decide` do escritório do agent-code, na ordem de prioridade da "Rotina dos magos":
 * 1. esperando você → de pé ao lado da mesa segurando "?" (pula de leve de tempos em tempos);
 * 2. tarefa ativa → na mesa, NUNCA lazer nem sono; a ação sai da ferramenta;
 * 3. sem mana → vai pro banco dos cristais;
 * 4. terminou → comemora (15 s, só se viu ao vivo) e fica com a estrela;
 * 5. parado → lê ou cochila na mesa.
 * Reações curtas (1–2 s) vêm dos eventos: pedido = levanta a cabeça, erro = faísca, explorador
 * voltou = joinha/ombros, travou = olha a ampulheta.
 */

import { POSES_DE_OCIO } from "./poses.js";

export const REACAO_MS = 1_600;
/** Bash/PowerShell: mexe no caldeirão, e depois disso tamborila esperando. */
export const CALDEIRAO_MS = 1_500;
/** De quanto em quanto tempo o mago parado reconsidera ler × cochilar. */
export const OCIOSO_TROCA_MS = 20_000;
/** Pulinho do "esperando você": um a cada tantos ms. */
export const PULO_ESPERA_MS = 4_000;

const ESCREVE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite"]);
const LE = new Set(["Read", "Grep", "Glob", "LS"]);
const TERMINAL = new Set(["Bash", "PowerShell", "BashOutput", "KillShell"]);
const WEB = new Set(["WebFetch", "WebSearch"]);
const DELEGA = new Set(["Agent", "Task"]);

/** Ação na mesa a partir da ferramenta em uso. */
export function acaoDaFerramenta(nome, desdeMs) {
  const n = String(nome ?? "");
  if (ESCREVE.has(n)) return "escrevendo";
  if (LE.has(n)) return "folheando";
  if (TERMINAL.has(n)) return desdeMs < CALDEIRAO_MS ? "caldeirao" : "tamborilando";
  if (WEB.has(n)) return "bola-de-cristal";
  if (DELEGA.has(n)) return "despachando";
  return "escrevendo";
}

/** Ícone sobre o personagem (estado nunca só por cor). */
export function iconeDoEstado(estado) {
  return (
    {
      esperando: "pergunta",
      "segundo-plano": "ampulheta",
      erro: "alerta",
      "sem-mana": "sem-mana",
      terminou: "estrela",
    }[estado] ?? ""
  );
}

const REACOES = {
  pedido: "levanta-cabeca",
  erro: "faisca",
  travou: "olha-ampulheta",
};

export function cerebroNovo() {
  return { memoria: new Map() };
}

function memoriaDe(cerebro, chave) {
  let m = cerebro.memoria.get(chave);
  if (!m) {
    m = { reacao: "", reacaoAte: 0, ocioso: "lendo", ociosoAte: 0 };
    cerebro.memoria.set(chave, m);
  }
  return m;
}

/** Eventos da camada 4 viram reações curtas na memória de cada um. */
export function aplicarEventosNoCerebro(cerebro, eventos, agora) {
  for (const ev of eventos ?? []) {
    let reacao = REACOES[ev.tipo];
    if (ev.tipo === "voltou") reacao = ev.ok ? "joinha" : "ombros";
    if (!reacao) continue;
    const m = memoriaDe(cerebro, ev.chave);
    m.reacao = reacao;
    m.reacaoAte = agora + REACAO_MS;
  }
}

/** Esquece quem não está mais na torre. */
export function podarCerebro(cerebro, chavesVivas) {
  for (const k of [...cerebro.memoria.keys()]) if (!chavesVivas.has(k)) cerebro.memoria.delete(k);
}

/**
 * Decide o que o mago faz agora.
 * @returns `{ modo, pose, icone, lugar, reacao }` — `lugar`: "mesa" | "lado-da-mesa" | "cristais".
 *          `pose` é o nome da animação (sprites); `reacao` sobrepõe a pose por ~1,6 s.
 */
export function decidir(cerebro, mago, agora, sorteio = Math.random) {
  const m = memoriaDe(cerebro, mago.chave);
  const reacao = m.reacaoAte > agora ? m.reacao : "";
  const icone = iconeDoEstado(mago.estado);
  switch (mago.estado) {
    case "esperando": {
      const fase = (agora + (mago.semente % PULO_ESPERA_MS)) % PULO_ESPERA_MS;
      return { modo: "esperando", pose: fase < 500 ? "pulinho" : "segurando", icone, lugar: "lado-da-mesa", reacao };
    }
    case "pensando":
      return { modo: "tarefa", pose: "pensando", icone, lugar: "mesa", reacao };
    case "trabalhando":
      return { modo: "tarefa", pose: acaoDaFerramenta(mago.ferramenta, agora - (mago.faseEm || agora)), icone, lugar: "mesa", reacao };
    case "segundo-plano":
      return { modo: "tarefa", pose: "ampulheta", icone, lugar: "mesa", reacao };
    case "sem-mana":
      return { modo: "sem-mana", pose: "sentado-banco", icone, lugar: "cristais", reacao };
    case "terminou":
      if (mago.comemorando) return { modo: "terminou", pose: "comemorando", icone, lugar: "mesa", reacao };
    // fallthrough: depois da festa, fica parado na mesa com a estrela
    default: {
      if (m.ociosoAte <= agora) {
        m.ocioso = POSES_DE_OCIO[Math.floor(sorteio() * POSES_DE_OCIO.length)];
        m.ociosoAte = agora + OCIOSO_TROCA_MS + Math.floor(sorteio() * OCIOSO_TROCA_MS);
      }
      return { modo: "ocioso", pose: m.ocioso, icone, lugar: "mesa", reacao };
    }
  }
}
