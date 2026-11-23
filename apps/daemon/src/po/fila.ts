/**
 * Fila do PO: uma rodada por (conversa, fase) a cada 60 s no máximo. Turno que chega dentro da
 * espera não é perdido — junta no lote pendente e roda quando a espera acaba (um lote só, com os
 * pedidos e as ações de todos). Rodada que falha tenta de novo 60 s depois, até 2 vezes.
 */
import { log } from "../log.ts";
import type { FasePO } from "./veredito.ts";

export type ChamadaPO = { ferramenta: string; detalhe: string };

/** O que um (ou mais, juntados) turno(s) entrega ao PO. */
export type LotePO = {
  /** Pedido(s) da pessoa, completos. */
  textos: string[];
  /** Fechamento: ferramentas que o agente usou (as últimas 60). */
  chamadas: ChamadaPO[];
  /** Fechamento: mensagens do agente no meio do turno. */
  mensagens: string[];
  /** Fechamento: resposta final do turno. */
  resposta?: string;
  /** Abertura: a resposta do turno anterior (contexto do que foi combinado). */
  respostaAnterior?: string;
  /** Fechamento: próxima mensagem da fila, se houver. */
  proximo?: string;
  /** Quantos turnos este lote junta. */
  turnos: number;
};

export const ESPERA_PO_MS = 60_000;
export const TENTATIVAS_PO = 2;
export const MAX_CHAMADAS_PO = 60;

/** Junta o lote que esperava com o turno novo: o mais novo ganha na resposta e no "próximo". */
export function juntarLotes(antes: LotePO, depois: LotePO): LotePO {
  const anteriores = [
    ...antes.mensagens.map((m) => `(turno anterior) ${m}`),
    ...(antes.resposta ? [`(turno anterior) ${antes.resposta}`] : []),
  ];
  return {
    textos: [...antes.textos, ...depois.textos],
    chamadas: [...antes.chamadas, ...depois.chamadas].slice(-MAX_CHAMADAS_PO),
    mensagens: [...anteriores, ...depois.mensagens],
    // A resposta do lote é a do turno mais novo; a do anterior já foi pras mensagens.
    ...(depois.resposta ? { resposta: depois.resposta } : {}),
    // Abertura: o "combinado antes" é o do primeiro turno do lote.
    ...((antes.respostaAnterior ?? depois.respostaAnterior)
      ? { respostaAnterior: antes.respostaAnterior ?? depois.respostaAnterior }
      : {}),
    ...(depois.proximo ? { proximo: depois.proximo } : {}),
    turnos: antes.turnos + depois.turnos,
  };
}

/** Vários pedidos juntados: "(1) … (2) …", um por parágrafo. */
export function juntarPedidos(textos: readonly string[]): string {
  const t = textos.map((x) => x.trim()).filter(Boolean);
  if (t.length <= 1) return t[0] ?? "";
  return t.map((x, i) => `(${i + 1}) ${x}`).join("\n\n");
}

export type ExecutorPO = (chave: { threadId: string; fase: FasePO }, lote: LotePO) => Promise<void>;

type Estado = {
  ultimaEm: number;
  pendente?: LotePO;
  timer?: NodeJS.Timeout;
  tentativas: number;
  rodando: boolean;
};

export type OpcoesDaFila = { esperaMs?: number; tentativas?: number; agora?: () => number };

export class FilaPO {
  private readonly estados = new Map<string, Estado>();
  private readonly esperaMs: number;
  private readonly maxTentativas: number;
  private readonly agora: () => number;

  constructor(
    private readonly executar: ExecutorPO,
    opts: OpcoesDaFila = {},
  ) {
    this.esperaMs = opts.esperaMs ?? ESPERA_PO_MS;
    this.maxTentativas = opts.tentativas ?? TENTATIVAS_PO;
    this.agora = opts.agora ?? Date.now;
  }

  /**
   * Turno novo. Fora da espera e sem rodada correndo: roda já e devolve a promessa da rodada
   * (o fim do turno espera por ela). Dentro da espera: junta no lote e devolve na hora.
   * Nunca rejeita.
   */
  pedir(threadId: string, fase: FasePO, lote: LotePO): Promise<void> {
    const chave = `${threadId}:${fase}`;
    const e = this.estados.get(chave) ?? { ultimaEm: 0, tentativas: 0, rodando: false };
    this.estados.set(chave, e);
    e.tentativas = 0;
    const livre = !e.rodando && !e.timer && this.agora() - e.ultimaEm >= this.esperaMs;
    if (livre) {
      const junto = e.pendente ? juntarLotes(e.pendente, lote) : lote;
      delete e.pendente;
      return this.rodar(chave, threadId, fase, junto);
    }
    e.pendente = e.pendente ? juntarLotes(e.pendente, lote) : lote;
    this.agendar(chave, threadId, fase, Math.max(0, this.esperaMs - (this.agora() - e.ultimaEm)));
    return Promise.resolve();
  }

  private agendar(chave: string, threadId: string, fase: FasePO, ms: number): void {
    const e = this.estados.get(chave);
    if (!e || e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = undefined;
      if (e.rodando) {
        // Ainda correndo: tenta de novo quando a espera contar a partir do fim dela.
        this.agendar(chave, threadId, fase, this.esperaMs);
        return;
      }
      const lote = e.pendente;
      delete e.pendente;
      if (lote) void this.rodar(chave, threadId, fase, lote);
    }, ms);
    e.timer.unref?.();
  }

  private async rodar(chave: string, threadId: string, fase: FasePO, lote: LotePO): Promise<void> {
    const e = this.estados.get(chave);
    if (!e) return;
    e.rodando = true;
    e.ultimaEm = this.agora();
    try {
      await this.executar({ threadId, fase }, lote);
      e.tentativas = 0;
    } catch (err) {
      e.tentativas++;
      log.avisoUmaVez(`po:fila:${chave}:${e.tentativas}`, "turno", "rodada do PO falhou", {
        threadId,
        fase,
        tentativa: e.tentativas,
        erro: (err as Error)?.message || String(err),
      });
      if (e.tentativas <= this.maxTentativas) {
        // Tentativa nova junta com o que chegou enquanto isto rodava.
        e.pendente = e.pendente ? juntarLotes(lote, e.pendente) : lote;
      }
    } finally {
      e.rodando = false;
      e.ultimaEm = this.agora();
      if (e.pendente) this.agendar(chave, threadId, fase, this.esperaMs);
    }
  }

  /** Desliga: cancela as esperas e roda o que estava pendente uma última vez (sem tentar de novo). */
  async esvaziar(): Promise<void> {
    const rodadas: Promise<void>[] = [];
    for (const [chave, e] of this.estados) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = undefined;
      const lote = e.pendente;
      delete e.pendente;
      if (!lote || e.rodando) continue;
      const [threadId, fase] = separarChave(chave);
      rodadas.push(this.executar({ threadId, fase }, lote).catch(() => undefined));
    }
    this.estados.clear();
    await Promise.all(rodadas);
  }

  /** Só pra teste/inspeção. */
  pendenteDe(threadId: string, fase: FasePO): LotePO | undefined {
    return this.estados.get(`${threadId}:${fase}`)?.pendente;
  }
}

function separarChave(chave: string): [string, FasePO] {
  const i = chave.lastIndexOf(":");
  return [chave.slice(0, i), chave.slice(i + 1) as FasePO];
}
