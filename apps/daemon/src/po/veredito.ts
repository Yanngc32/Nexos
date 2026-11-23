/**
 * Lê o veredito do PO — o texto que o modelo devolveu — e vira uma lista de operações.
 *
 * Falha fechado: linha com id que não está no quadro, operação da fase errada, motivo faltando
 * ou formato estranho é DESCARTADA (nunca "adivinhada"). Porte do parser do Agent Code
 * (poPrompt.ts/poVerdict), no vocabulário do Nexos.
 */
import { PO_AWAITING_AUTHORIZATION_REASON, PO_MAX_OPS } from "./texto.ts";

export type FasePO = "abertura" | "fechamento";
export type TipoResposta = "botao" | "responder";

export type OpPO =
  /** ANDAMENTO (abertura): card "a fazer" que o pedido retoma. */
  | { tipo: "iniciar"; id: string; motivo: string }
  /** NOVA (as duas fases) e FEITA (fechamento). */
  | {
      tipo: "criar";
      titulo: string;
      motivo: string;
      status: "in_progress" | "pending" | "completed";
      resumo?: string;
      acaoVoce?: string;
      tipoResposta?: TipoResposta;
      parentId?: string;
    }
  /** CONCLUIR, ou ETAPA … CONCLUÍDA (aí `etapa` diz de qual). */
  | { tipo: "concluir"; id: string; motivo: string; etapa?: string }
  /** TITULO. */
  | { tipo: "renomear"; id: string; titulo: string; motivo: string; resumo?: string }
  /** PENDENTE: o card fica "a fazer" com o que faltou (e o que a pessoa precisa fazer). */
  | { tipo: "justificar"; id: string; motivo: string; acaoVoce?: string; tipoResposta?: TipoResposta }
  /** ETAPA … PENDENTE: o card concluído volta, porque a evidência diz que não foi feito. */
  | { tipo: "contestar"; id: string; motivo: string; etapa: string }
  /** SEGURAR: a próxima mensagem da fila contradiz o que a resposta disse. */
  | { tipo: "segurar"; motivo: string };

export type ContextoDoVeredito = {
  fase: FasePO;
  /** Ids dos cards listados no QUADRO ATUAL. */
  ids: ReadonlySet<string>;
  /** Placar: etapa → id do card dela (só no fechamento, só com plano ligado). */
  etapas?: ReadonlyMap<string, string | undefined>;
  /** Existe próxima mensagem na fila (só então SEGURAR vale). */
  temProximo?: boolean;
};

export type Veredito = {
  ops: OpPO[];
  /** A resposta tem cara de veredito (alguma linha de operação, ou exatamente OK). Sem isso, o
   *  padrão do fim do turno NÃO roda: resposta ilegível não pode concluir card nenhum. */
  legivel: boolean;
};

export const TITULO_MAX_PO = 60;
export const RESUMO_MAX_PO = 160;
export const MOTIVO_MAX_PO = 160;
export const ACAO_MAX_PO = 120;

const PALAVRAS = ["ANDAMENTO", "NOVA", "CONCLUIR", "TITULO", "PENDENTE", "FEITA", "ETAPA", "SEGURAR"];

/** Junta espaço e corta com "…". */
export function clamp(texto: string, max: number): string {
  const t = texto.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Título para comparar duplicata: sem acento, minúsculo, espaço único. */
export function normalizarTitulo(s: string): string {
  return semAcento(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Título que passa de 60 corta na última palavra inteira; o texto inteiro vai pro resumo. */
export function caberTitulo(titulo: string, resumo?: string): { titulo: string; resumo?: string } {
  const t = titulo.replace(/\s+/g, " ").trim();
  if (t.length <= TITULO_MAX_PO) return { titulo: t, ...(resumo ? { resumo } : {}) };
  const corte = t.slice(0, TITULO_MAX_PO - 1);
  const espaco = corte.lastIndexOf(" ");
  const curto = (espaco > 20 ? corte.slice(0, espaco) : corte).replace(/[\s,;:.–—-]+$/, "") + "…";
  return { titulo: curto, resumo: resumo ?? clamp(t, RESUMO_MAX_PO) };
}

/** Tira o "| RESUMO: …" (até o "| VOCÊ:", se vier depois) e devolve o resto da linha. */
function separarResumo(linha: string): { linha: string; resumo?: string } {
  const m = /\|\s*RESUMO\s*:/i.exec(linha);
  if (!m) return { linha };
  const antes = linha.slice(0, m.index);
  const depois = linha.slice(m.index + m[0].length);
  const v = /\|\s*VOC[EÊ]\s*:/i.exec(depois);
  const resumo = clamp(v ? depois.slice(0, v.index) : depois, RESUMO_MAX_PO);
  const resto = v ? depois.slice(v.index) : "";
  return { linha: `${antes.trimEnd()} ${resto}`.trim(), ...(resumo ? { resumo } : {}) };
}

/** Tira o "| VOCÊ: ação [| BOTÃO|RESPONDER]". */
function separarAcao(linha: string): { linha: string; acaoVoce?: string; tipoResposta?: TipoResposta } {
  const m = /\|\s*VOC[EÊ]\s*:/i.exec(linha);
  if (!m) return { linha };
  const antes = linha.slice(0, m.index).trimEnd();
  let acao = linha.slice(m.index + m[0].length);
  let tipoResposta: TipoResposta | undefined;
  const sufixo = /\|\s*([^|]*?)\s*$/.exec(acao);
  if (sufixo) {
    const s = semAcento(sufixo[1] ?? "").toUpperCase();
    if (s === "BOTAO") tipoResposta = "botao";
    else if (s === "RESPONDER") tipoResposta = "responder";
    if (tipoResposta) acao = acao.slice(0, sufixo.index);
  }
  const acaoVoce = clamp(acao.replace(/\|/g, " "), ACAO_MAX_PO);
  return { linha: antes, ...(acaoVoce ? { acaoVoce } : {}), ...(tipoResposta ? { tipoResposta } : {}) };
}

/** "[abc]" / "abc," → "abc". */
function limparId(s: string | undefined): string {
  return (s ?? "").replace(/^\[|\]$/g, "").replace(/[.,;:]+$/, "").trim();
}

function motivoDe(s: string | undefined): string | undefined {
  // medido com haiku: o modelo às vezes escreve "motivo: …" — o rótulo não entra no card
  const m = clamp((s ?? "").replace(/^\s*motivo\s*:\s*/i, ""), MOTIVO_MAX_PO);
  return m || undefined;
}

/**
 * Texto do modelo → operações. Nunca lança. A ordem das linhas é preservada; o teto de
 * operações (`PO_MAX_OPS`) não conta as linhas ETAPA.
 */
export function lerVeredito(texto: string, ctx: ContextoDoVeredito): Veredito {
  const ops: OpPO[] = [];
  const vistos = new Set<string>();
  const temPlacar = !!ctx.etapas && ctx.etapas.size > 0;
  let isentas = 0;
  let legivel = /^\s*OK\s*\.?\s*$/i.test(texto);
  const fechamento = ctx.fase === "fechamento";

  for (const bruta of texto.split(/\r?\n/)) {
    if (ops.length - isentas >= PO_MAX_OPS && !temPlacar) break;
    const limpa = bruta.replace(/^[`\s>*-]+/, "").trim();
    if (!limpa || /^OK\b/i.test(limpa)) continue;

    const r = separarResumo(limpa);
    const a = separarAcao(r.linha);
    const campos = a.linha.split("|").map((c) => c.trim());
    const cabeca = (campos[0] ?? "").split(/\s+/);
    const palavra = semAcento(cabeca[0] ?? "").toUpperCase().replace(/[:]+$/, "");
    if (!PALAVRAS.includes(palavra)) continue;
    legivel = true;
    const idCabeca = limparId(cabeca[1]);
    const cheio = ops.length - isentas >= PO_MAX_OPS;
    if (cheio && palavra !== "ETAPA") continue;

    switch (palavra) {
      case "ANDAMENTO": {
        const motivo = motivoDe(campos[1]);
        if (fechamento || !idCabeca || !ctx.ids.has(idCabeca) || !motivo || vistos.has(`a:${idCabeca}`)) break;
        vistos.add(`a:${idCabeca}`);
        ops.push({ tipo: "iniciar", id: idCabeca, motivo });
        break;
      }
      case "NOVA":
      case "FEITA": {
        if (palavra === "FEITA" && !fechamento) break;
        const bruto = (campos[1] ?? "").trim();
        const motivo = motivoDe(campos[2]);
        if (!bruto || !motivo) break;
        const { titulo, resumo } = caberTitulo(bruto, r.resumo);
        const chave = `n:${normalizarTitulo(titulo)}`;
        if (vistos.has(chave)) break;
        vistos.add(chave);
        const status = palavra === "FEITA" ? "completed" : fechamento ? "pending" : "in_progress";
        const op: Extract<OpPO, { tipo: "criar" }> = { tipo: "criar", titulo, motivo, status, ...(resumo ? { resumo } : {}) };
        if (status === "pending") {
          if (idCabeca && ctx.ids.has(idCabeca)) op.parentId = idCabeca;
          if (a.acaoVoce) {
            op.acaoVoce = a.acaoVoce;
            if (a.tipoResposta) op.tipoResposta = a.tipoResposta;
          } else if (motivo.toLowerCase().startsWith(PO_AWAITING_AUTHORIZATION_REASON)) {
            // Passo proposto sem o VOCÊ: o que a pessoa faz é autorizar — o card mostra o botão.
            op.acaoVoce = clamp(`Autorizar: ${titulo}`, ACAO_MAX_PO);
            op.tipoResposta = "botao";
          }
        }
        ops.push(op);
        break;
      }
      case "CONCLUIR": {
        const motivo = motivoDe(campos[1]);
        if (!fechamento || !idCabeca || !ctx.ids.has(idCabeca) || !motivo || vistos.has(`c:${idCabeca}`)) break;
        vistos.add(`c:${idCabeca}`);
        ops.push({ tipo: "concluir", id: idCabeca, motivo });
        break;
      }
      case "TITULO": {
        const bruto = (campos[1] ?? "").trim();
        const motivo = motivoDe(campos[2]);
        if (!fechamento || !idCabeca || !ctx.ids.has(idCabeca) || !bruto || !motivo || vistos.has(`t:${idCabeca}`)) break;
        vistos.add(`t:${idCabeca}`);
        const { titulo, resumo } = caberTitulo(bruto, r.resumo);
        ops.push({ tipo: "renomear", id: idCabeca, titulo, motivo, ...(resumo ? { resumo } : {}) });
        break;
      }
      case "PENDENTE": {
        const motivo = motivoDe(campos[1]);
        if (!fechamento || !idCabeca || !ctx.ids.has(idCabeca) || !motivo || vistos.has(`p:${idCabeca}`)) break;
        vistos.add(`p:${idCabeca}`);
        ops.push({
          tipo: "justificar",
          id: idCabeca,
          motivo,
          ...(a.acaoVoce ? { acaoVoce: a.acaoVoce } : {}),
          ...(a.acaoVoce && a.tipoResposta ? { tipoResposta: a.tipoResposta } : {}),
        });
        break;
      }
      case "ETAPA": {
        if (!fechamento || !temPlacar || !idCabeca || !ctx.etapas?.has(idCabeca) || vistos.has(`pl:${idCabeca}`)) break;
        const cardId = ctx.etapas.get(idCabeca);
        const veredito = semAcento(campos[1] ?? "").toUpperCase();
        const motivo = motivoDe(campos[2]);
        if (!cardId || !ctx.ids.has(cardId) || !motivo) break;
        if (veredito !== "CONCLUIDA" && veredito !== "PENDENTE") break;
        vistos.add(`pl:${idCabeca}`);
        isentas++;
        if (veredito === "CONCLUIDA") {
          if (vistos.has(`c:${cardId}`)) break;
          vistos.add(`c:${cardId}`);
          ops.push({ tipo: "concluir", id: cardId, motivo, etapa: idCabeca });
        } else {
          ops.push({ tipo: "contestar", id: cardId, motivo, etapa: idCabeca });
        }
        break;
      }
      case "SEGURAR": {
        const motivo = motivoDe(campos[1]);
        if (!fechamento || !ctx.temProximo || !motivo || vistos.has("x:")) break;
        vistos.add("x:");
        ops.push({ tipo: "segurar", motivo });
        break;
      }
    }
  }
  return { ops, legivel };
}
