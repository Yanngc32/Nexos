/**
 * Aplica as operações do veredito no quadro. Cada operação é independente: uma que falha (card
 * sumiu, quadro desligou no meio) vira aviso no log e as outras seguem.
 *
 * Regras que valem aqui (e não no parser, porque dependem do quadro de AGORA):
 * - card concluído nunca reabre — a única exceção é o ETAPA … PENDENTE do placar do plano;
 * - antes de criar, relê o quadro: título que já existe não duplica (na abertura, se o card que já
 *   existe está "a fazer", vira ANDAMENTO nele);
 * - no fechamento, o card devolvido que o veredito não julgou é concluído com o motivo padrão.
 */
import { log } from "../log.ts";
import { MARCA_FIM_DE_TURNO, aplicarPO, criarTarefaDoPO, type PatchPO } from "../tarefas-agente.ts";
import { getQuadro, getTarefa, listarTarefas, statusEfetivo, type Tarefa } from "../tarefas.ts";
import { normalizarTitulo, type FasePO, type OpPO, type Veredito } from "./veredito.ts";

export const MOTIVO_PADRAO_FECHAMENTO = "entregue: o turno terminou e a resposta não diz que faltou algo";

export type ContextoDeAplicar = {
  projectPath: string;
  home: string;
  threadId: string;
  fase: FasePO;
  /** Fechamento: cards desta conversa que o turno devolveu (em andamento ou rebaixados pelo fim). */
  devolvidos?: readonly string[];
};

export type ResultadoDeAplicar = {
  /** Ids dos cards que mudaram ou nasceram. */
  cards: string[];
  /** Motivo do SEGURAR, quando o veredito pediu. */
  segurar?: string;
};

function msg(e: unknown): string {
  return (e as Error)?.message || String(e);
}

/** O card está "em jogo" pro fechamento: em andamento, ou "a fazer" com a marca do fim do turno. */
function emJogo(t: Tarefa, projectPath: string, home: string): boolean {
  const s = statusEfetivo(t, getQuadro(projectPath, home));
  return s === "in_progress" || (s === "pending" && !!t.po?.motivo?.startsWith(MARCA_FIM_DE_TURNO));
}

export function aplicarVeredito(veredito: Veredito, ctx: ContextoDeAplicar): ResultadoDeAplicar {
  const { projectPath, home, threadId, fase } = ctx;
  const tocados = new Set<string>();
  const julgados = new Set<string>();
  const concluidosAgora = new Set<string>();
  let segurar: string | undefined;

  const tentar = (chave: string, f: () => void): void => {
    try {
      f();
    } catch (e) {
      log.avisoUmaVez(`po:aplicar:${chave}`, "turno", "o PO não aplicou uma operação", { chave, erro: msg(e) });
    }
  };
  const aplicar = (id: string, patch: PatchPO, motivo: string): void => {
    aplicarPO(projectPath, home, id, patch, motivo);
    tocados.add(id);
  };
  const statusDe = (t: Tarefa) => statusEfetivo(t, getQuadro(projectPath, home));

  const justificar = (t: Tarefa, motivo: string, acaoVoce?: string, tipo?: "botao" | "responder"): void => {
    if (!emJogo(t, projectPath, home)) return;
    aplicar(
      t.id,
      { status: "pending", acaoVoce: acaoVoce ?? null, tipoResposta: acaoVoce ? (tipo ?? null) : null },
      `${MARCA_FIM_DE_TURNO} — pendente: ${motivo}`,
    );
  };

  const criacoes: Array<Extract<OpPO, { tipo: "criar" }>> = [];
  for (const op of veredito.ops) {
    if (op.tipo === "criar") {
      criacoes.push(op);
      continue;
    }
    if (op.tipo === "segurar") {
      segurar = op.motivo;
      continue;
    }
    const t = getTarefa(projectPath, home, op.id);
    if (!t) continue;
    tentar(`${op.tipo}:${op.id}`, () => {
      switch (op.tipo) {
        case "renomear": {
          if (normalizarTitulo(op.titulo) === normalizarTitulo(t.titulo)) return;
          aplicar(t.id, { titulo: op.titulo, ...(op.resumo ? { resumo: op.resumo } : {}) }, op.motivo);
          return;
        }
        case "concluir": {
          julgados.add(t.id);
          if (statusDe(t) === "completed") return;
          aplicar(t.id, { status: "completed", acaoVoce: null, tipoResposta: null }, op.motivo);
          concluidosAgora.add(t.id);
          return;
        }
        case "justificar": {
          julgados.add(t.id);
          // A mesma resposta concluiu o card (CONCLUIR e PENDENTE no mesmo): vale o concluído.
          if (concluidosAgora.has(t.id)) return;
          justificar(t, op.motivo, op.acaoVoce, op.tipoResposta);
          return;
        }
        case "contestar": {
          julgados.add(t.id);
          if (concluidosAgora.has(t.id)) return;
          // Exceção documentada ao "nunca reabre": o placar do plano diz que a etapa não foi feita.
          if (statusDe(t) === "completed") aplicar(t.id, { status: "pending" }, op.motivo);
          else justificar(t, op.motivo);
          return;
        }
        case "iniciar": {
          if (fase !== "abertura" || statusDe(t) !== "pending") return;
          aplicar(t.id, { status: "in_progress" }, op.motivo);
          return;
        }
      }
    });
  }

  for (const op of criacoes) {
    tentar(`criar:${normalizarTitulo(op.titulo)}`, () => {
      // Relê o quadro: outra rodada (ou o agente) pode ter criado o mesmo card agora há pouco.
      const alvo = normalizarTitulo(op.titulo);
      const igual = listarTarefas(projectPath, home).find(
        (t) => normalizarTitulo(t.titulo) === alvo || (!!t.po?.titulo && normalizarTitulo(t.po.titulo) === alvo),
      );
      if (igual) {
        if (fase === "abertura" && statusDe(igual) === "pending") aplicar(igual.id, { status: "in_progress" }, op.motivo);
        return;
      }
      const nova = criarTarefaDoPO(projectPath, home, {
        titulo: op.titulo,
        ...(op.resumo ? { resumo: op.resumo } : {}),
        status: op.status,
        motivo: op.motivo,
        ...(op.acaoVoce ? { acaoVoce: op.acaoVoce } : {}),
        ...(op.tipoResposta ? { tipoResposta: op.tipoResposta } : {}),
        ...(op.parentId ? { parentId: op.parentId } : {}),
        threadId,
      });
      tocados.add(nova.id);
    });
  }

  // Padrão do fechamento: o que voltou e o veredito não julgou foi entregue. Só com resposta
  // legível — texto quebrado não conclui nada.
  if (fase === "fechamento" && veredito.legivel) {
    for (const id of ctx.devolvidos ?? []) {
      if (julgados.has(id)) continue;
      tentar(`padrao:${id}`, () => {
        const t = getTarefa(projectPath, home, id);
        if (!t || !emJogo(t, projectPath, home)) return;
        aplicar(id, { status: "completed", acaoVoce: null, tipoResposta: null }, MOTIVO_PADRAO_FECHAMENTO);
      });
    }
  }

  return { cards: [...tocados], ...(segurar ? { segurar } : {}) };
}
