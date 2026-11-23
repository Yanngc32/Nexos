/**
 * Memorista de fim de turno: ao fim de cada turno de uma conversa, um modelo lateral lê o que o
 * usuário disse e o que o agente respondeu e decide se nasceu ali um fato duradouro. Porta do
 * memorista do Agent Code.
 *
 * - Desligado (`ligado()` falso) ou turno sem fala do usuário: não roda.
 * - Cooldown de `COOLDOWN_MEMORISTA_MS` por conversa: o turno que cai dentro da janela fica
 *   adiado e entra junto na próxima análise, que roda sozinha ao fim da janela (timer `unref`) —
 *   nada se perde, só se junta.
 * - Falha do modelo: o lote volta para a fila da conversa e vai na próxima.
 * - Escrita SÓ por `proporMemoria`, com `origem: "memorista"`. Segredo no texto é redigido para o
 *   cofre pelo próprio núcleo (varredura automática de título/gancho/corpo).
 * - `fimDeTurno` nunca lança: memória é acessório, não derruba turno.
 */
import { lerMemoria, listarMemorias, proporMemoria } from "./nucleo.ts";
import type { OrigemMemoria } from "./tipos.ts";
import type { EventoMemoriaSalva, RodarModelo } from "./motor.ts";
import {
  COOLDOWN_MEMORISTA_MS,
  MAX_RESPOSTA,
  MAX_USADAS,
  TETO_MEMORISTA_MS,
  anexarFato,
  interpretarVeredito,
  montarPromptMemorista,
  type ItemIndice,
  type OperacaoMemoria,
} from "./memorista-prompt.ts";

/** Quantos turnos adiados uma conversa guarda; acima disso sai o mais antigo. */
const MAX_ADIADOS = 20;

export type DepsMemorista = {
  home: string;
  rodar: RodarModelo;
  modelo: () => string;
  ligado: () => boolean;
  agora?: () => number;
  aoSalvar?: (ev: EventoMemoriaSalva) => void;
};

export type Memorista = {
  observarUsuario(threadId: string, texto: string): void;
  fimDeTurno(threadId: string, ctx: { threadProfileId?: string; resumoDoTurno: string; memoriasUsadas: string[] }): Promise<void>;
};

type Turno = { falas: string[]; resposta: string; usadas: string[] };

/**
 * Aplica as operações lidas do modelo, uma por uma, via `proporMemoria`. Devolve quantas
 * gravaram. COMPLEMENTA relê a memória na hora (revisão fresca) e pula se o fato já está no corpo.
 */
export function aplicarOperacoes(
  home: string,
  ops: readonly OperacaoMemoria[],
  origem: Extract<OrigemMemoria, "memorista" | "curador">,
  threadId?: string,
  aoSalvar?: (ev: EventoMemoriaSalva) => void,
): number {
  let gravadas = 0;
  for (const op of ops) {
    try {
      if (op.op === "create") {
        const r = proporMemoria(home, {
          op: "create",
          relPath: op.relPath,
          tipo: op.tipo,
          titulo: op.titulo,
          gancho: op.gancho,
          corpo: op.fato,
          origem,
        });
        if (!r.ok) continue;
        gravadas++;
        avisar(aoSalvar, { relPath: r.memoria.relPath, titulo: r.memoria.titulo, op: "create", origem, ...(threadId ? { threadId } : {}) });
        continue;
      }
      const atual = lerMemoria(home, op.relPath);
      if (!atual || atual.status !== "ativa") continue;
      const corpo = anexarFato(atual.corpo, op.fato);
      if (corpo === null) continue;
      const r = proporMemoria(home, {
        op: "update",
        relPath: atual.relPath,
        tipo: atual.tipo,
        titulo: atual.titulo,
        gancho: atual.gancho,
        corpo,
        revisaoEsperada: atual.revisao,
        origem,
      });
      if (!r.ok) continue;
      gravadas++;
      avisar(aoSalvar, { relPath: r.memoria.relPath, titulo: r.memoria.titulo, op: "update", origem, ...(threadId ? { threadId } : {}) });
    } catch {
      // proporMemoria não lança; isto é só cinto de segurança para o aviso do chamador.
    }
  }
  return gravadas;
}

function avisar(aoSalvar: ((ev: EventoMemoriaSalva) => void) | undefined, ev: EventoMemoriaSalva): void {
  try {
    aoSalvar?.(ev);
  } catch {
    // aviso que falha não desfaz a memória gravada
  }
}

/** Índice (caminho, título, gancho) das memórias que o agente já tinha no turno. */
function indiceDasUsadas(home: string, relPaths: readonly string[]): ItemIndice[] {
  const vistos = new Set<string>();
  const itens: ItemIndice[] = [];
  for (const rel of relPaths) {
    if (itens.length >= MAX_USADAS || vistos.has(rel)) continue;
    vistos.add(rel);
    const m = lerMemoria(home, rel);
    itens.push(m ? { relPath: m.relPath, titulo: m.titulo, gancho: m.gancho } : { relPath: rel, titulo: rel, gancho: "" });
  }
  return itens;
}

export function criarMemorista(deps: DepsMemorista): Memorista {
  const agora = deps.agora ?? Date.now;
  /** Falas do usuário no turno em curso, por conversa. */
  const falasDoTurno = new Map<string, string[]>();
  /** Estado por conversa: última análise, turnos à espera dela e o timer que os despeja. */
  const estado = new Map<string, { ultimaEm: number; adiados: Turno[]; perfil?: string; timer?: ReturnType<typeof setTimeout> }>();

  const estadoDe = (threadId: string) => {
    let e = estado.get(threadId);
    if (!e) estado.set(threadId, (e = { ultimaEm: Number.NEGATIVE_INFINITY, adiados: [] }));
    return e;
  };

  /** Analisa de uma vez tudo o que a conversa tem adiado. Nunca lança. */
  const analisar = async (threadId: string): Promise<void> => {
    const e = estadoDe(threadId);
    if (e.timer) clearTimeout(e.timer);
    e.timer = undefined;
    if (!e.adiados.length || !deps.ligado()) return;
    e.ultimaEm = agora();
    const lote = e.adiados.splice(0);

    const memorias = listarMemorias(deps.home);
    const prompt = montarPromptMemorista({
      memorias,
      usadas: indiceDasUsadas(deps.home, lote.flatMap((l) => l.usadas)),
      falasUsuario: lote.flatMap((l) => l.falas),
      // a resposta mais recente é a que conta; as anteriores entram só se couberem
      resposta: lote
        .map((l) => l.resposta.trim())
        .filter(Boolean)
        .join("\n---\n")
        .slice(-MAX_RESPOSTA),
    });

    let resposta: string;
    try {
      resposta = await deps.rodar(prompt, {
        home: deps.home,
        modelo: deps.modelo(),
        tetoMs: TETO_MEMORISTA_MS,
        ...(e.perfil ? { threadProfileId: e.perfil } : {}),
      });
    } catch {
      // devolve o lote à frente da fila: vai junto na próxima análise
      e.adiados.unshift(...lote);
      if (e.adiados.length > MAX_ADIADOS) e.adiados.splice(0, e.adiados.length - MAX_ADIADOS);
      return;
    }

    // CRIA também não pode cair em caminho aposentado (proporMemoria recusaria de qualquer jeito);
    // COMPLEMENTA só em memória ativa — a lista que o modelo viu.
    const ativas = new Set(memorias.map((m) => m.relPath));
    const conhecidas = listarMemorias(deps.home, { incluirAposentadas: true }).map((m) => m.relPath);
    const ops = interpretarVeredito(resposta, conhecidas).filter((op) => op.op === "create" || ativas.has(op.relPath));
    if (ops.length) aplicarOperacoes(deps.home, ops, "memorista", threadId, deps.aoSalvar);
  };

  /** Turno adiado não espera a próxima fala para sempre: ao fim da janela, roda sozinho. */
  const agendar = (threadId: string, esperaMs: number) => {
    const e = estadoDe(threadId);
    if (e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      void analisar(threadId).catch(() => {});
    }, Math.max(0, esperaMs));
    (e.timer as { unref?: () => void }).unref?.();
  };

  return {
    observarUsuario(threadId, texto) {
      const t = typeof texto === "string" ? texto.trim() : "";
      if (!threadId || !t) return;
      const lista = falasDoTurno.get(threadId) ?? [];
      lista.push(t);
      falasDoTurno.set(threadId, lista);
    },

    async fimDeTurno(threadId, ctx) {
      try {
        const falas = falasDoTurno.get(threadId) ?? [];
        falasDoTurno.delete(threadId);
        if (!deps.ligado()) return;
        if (!falas.length) return;

        const e = estadoDe(threadId);
        e.adiados.push({ falas, resposta: String(ctx?.resumoDoTurno ?? ""), usadas: [...(ctx?.memoriasUsadas ?? [])] });
        if (e.adiados.length > MAX_ADIADOS) e.adiados.splice(0, e.adiados.length - MAX_ADIADOS);
        if (ctx?.threadProfileId) e.perfil = ctx.threadProfileId;

        const desde = agora() - e.ultimaEm;
        if (desde < COOLDOWN_MEMORISTA_MS) {
          agendar(threadId, COOLDOWN_MEMORISTA_MS - desde); // entra junto na próxima análise
          return;
        }
        await analisar(threadId);
      } catch {
        // nunca lança
      }
    },
  };
}
