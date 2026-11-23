/**
 * Monta o prompt do PO: regras da fase + digest do turno (pedido, quadro, ações, devolvidos,
 * mensagens, resposta) + placar do plano + git + próximo da fila. Função pura: quem lê o quadro, o
 * plano e o git é o orquestrador (index.ts), e o `limpar` (tira segredo) vem injetado.
 *
 * Segredo sai de todo TEXTO LIVRE (pedido, ações, mensagens, respostas, títulos); id de card nunca
 * passa pelo `limpar` — ele tem formato fixo e o veredito precisa dele intacto.
 */
import type { StatusFonte } from "../tarefas.ts";
import { juntarPedidos, MAX_CHAMADAS_PO, type LotePO } from "./fila.ts";
import {
  PO_ETAPA_RULES,
  PO_ETAPA_SECTION,
  PO_FOREIGN_MARK,
  PO_HOLD_RULE,
  PO_MESSAGES_SECTION,
  PO_NEXT_SECTION,
  PO_PREVIOUS_REPLY_SECTION,
  PO_REPLY_SECTION,
  PO_RESUMED_MARK,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE,
  PO_SYSTEM_PROMPT_OPEN,
  PO_USER_SECTION,
} from "./texto.ts";
import { clamp, type FasePO } from "./veredito.ts";

export const MAX_CARDS_PO = 30;
export const MAX_DEVOLVIDOS_PO = 8;
export const MAX_ETAPAS_PO = 20;
const PROXIMO_MAX = 400;

export type CardDoDigest = {
  id: string;
  status: StatusFonte;
  titulo: string;
  /** Card "a fazer" de outra conversa do mesmo projeto. */
  outraConversa?: boolean;
};

export type EtapaDoDigest = {
  etapaId: string;
  titulo: string;
  /** Status real da etapa no plano (pendente | em_andamento | feita). */
  placar: string;
  cartao?: { id: string; status: StatusFonte };
};

export type EntradaDoDigest = {
  fase: FasePO;
  lote: LotePO;
  cards: readonly CardDoDigest[];
  /** Fechamento: cards que o turno devolveu; `retomado` = voltou a andar na abertura deste turno. */
  devolvidos?: ReadonlyArray<{ id: string; retomado?: boolean }>;
  etapas?: readonly EtapaDoDigest[];
  /** Bloco GIT já pronto (`evidenciaDoGit`), ou "". */
  git?: string;
  limpar?: (s: string) => string;
};

export type PromptDoPO = {
  prompt: string;
  /** Ids listados no QUADRO ATUAL (o parser só aceita estes). */
  ids: Set<string>;
  /** Placar: etapa → card dela. */
  etapas: Map<string, string | undefined>;
  temProximo: boolean;
};

const ROTULO: Record<StatusFonte, string> = {
  pending: "a fazer",
  in_progress: "em andamento",
  completed: "concluída",
};

function rotulo(s: StatusFonte): string {
  return ROTULO[s] ?? String(s);
}

/** Só o digest (sem regras, placar, git nem próximo). */
export function montarDigest(e: EntradaDoDigest): string {
  const limpar = e.limpar ?? ((s: string) => s);
  const partes: string[] = [];
  const pedido = limpar(juntarPedidos(e.lote.textos));
  partes.push(`${PO_USER_SECTION}\n${pedido || "(sem texto)"}`);

  const cards = e.cards.slice(0, MAX_CARDS_PO);
  const linhas = cards.map((c) =>
    clamp(`${c.id} [${rotulo(c.status)}]${c.outraConversa ? ` ${PO_FOREIGN_MARK}` : ""} ${clamp(limpar(c.titulo), 90)}`, 140),
  );
  partes.push(`QUADRO ATUAL:\n${linhas.length ? linhas.join("\n") : "(vazio)"}`);

  if (e.fase === "fechamento") {
    const chamadas = e.lote.chamadas
      .slice(-MAX_CHAMADAS_PO)
      .map((c) => `- ${clamp(limpar(`${c.ferramenta}: ${c.detalhe}`), 200)}`);
    partes.push(`AÇÕES DESTE TURNO:\n${chamadas.length ? chamadas.join("\n") : "(nenhuma)"}`);
    const devolvidos = (e.devolvidos ?? []).slice(0, MAX_DEVOLVIDOS_PO);
    if (devolvidos.length) {
      partes.push(
        `${PO_RETURNED_SECTION}\n${devolvidos.map((d) => `- ${d.id}${d.retomado ? ` ${PO_RESUMED_MARK}` : ""}`).join("\n")}`,
      );
    }
    const mensagens = e.lote.mensagens.map((m) => limpar(m).trim()).filter(Boolean);
    if (mensagens.length) partes.push(`${PO_MESSAGES_SECTION}\n${mensagens.map((m) => `- ${m}`).join("\n")}`);
    const resposta = limpar(e.lote.resposta ?? "").trim();
    if (resposta) partes.push(`${PO_REPLY_SECTION}\n${resposta}`);
  } else {
    const anterior = limpar(e.lote.respostaAnterior ?? "").trim();
    if (anterior) partes.push(`${PO_PREVIOUS_REPLY_SECTION}\n${anterior}`);
  }
  return partes.join("\n\n");
}

function placar(e: EntradaDoDigest, limpar: (s: string) => string): string {
  const etapas = (e.etapas ?? []).slice(0, MAX_ETAPAS_PO);
  if (e.fase !== "fechamento" || !etapas.length) return "";
  const linhas = etapas.map(
    (x) =>
      `- [${x.etapaId}] ${clamp(limpar(x.titulo), 90)} — placar: ${x.placar}` +
      (x.cartao ? ` — cartão ${x.cartao.id}: ${rotulo(x.cartao.status)}` : ""),
  );
  return `\n\n${PO_ETAPA_SECTION}\n${linhas.join("\n")}\n\n${PO_ETAPA_RULES}`;
}

export function montarPromptPO(e: EntradaDoDigest): PromptDoPO {
  const limpar = e.limpar ?? ((s: string) => s);
  const regras = e.fase === "abertura" ? PO_SYSTEM_PROMPT_OPEN : PO_SYSTEM_PROMPT_CLOSE;
  const ids = new Set(e.cards.slice(0, MAX_CARDS_PO).map((c) => c.id));
  // Card devolvido sempre pode ser julgado, mesmo que o quadro tenha passado de 30.
  for (const d of (e.devolvidos ?? []).slice(0, MAX_DEVOLVIDOS_PO)) ids.add(d.id);
  const etapas = new Map<string, string | undefined>();
  if (e.fase === "fechamento") {
    for (const x of (e.etapas ?? []).slice(0, MAX_ETAPAS_PO)) {
      etapas.set(x.etapaId, x.cartao?.id);
      if (x.cartao) ids.add(x.cartao.id);
    }
  }
  const proximo = e.fase === "fechamento" ? limpar(e.lote.proximo ?? "").trim() : "";
  let prompt = `${regras}\n\n---\n\n${montarDigest(e)}${placar(e, limpar)}${e.git ?? ""}`;
  if (proximo) prompt += `\n\n${PO_NEXT_SECTION}\n${clamp(proximo.replace(/\s+/g, " "), PROXIMO_MAX)}\n\n${PO_HOLD_RULE}`;
  return { prompt, ids, etapas, temProximo: !!proximo };
}
