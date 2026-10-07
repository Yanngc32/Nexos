import type { ThreadEvent } from "@nexos/shared";
import type { IncomingFile } from "./attachments.ts";
import { sessionBus } from "./bus.ts";
import { log } from "./log.ts";
import { responderPergunta, temPerguntaPendente } from "./perguntas.ts";
import { injetarMensagem, postMessage, turnoEmCurso } from "./session.ts";
import { aoGravarEvento, appendEvent, threadHead } from "./threads.ts";

/**
 * Ponte entre o chat que abriu um plano e o Agent Manager dele: com ela ligada, o que a pessoa
 * escreve no chat de origem vai pro Manager (responde a pergunta pendente dele, entra no turno em
 * voo ou abre turno novo) e cada fala do Manager volta pro chat de origem como `ponte`. Assim a
 * conversa com o Manager segue de qualquer um dos dois lados.
 */

function nowIso(): string {
  return new Date().toISOString();
}

function gravar(ev: ThreadEvent, home: string): void {
  appendEvent(ev, home);
  sessionBus.emit(ev.threadId, ev);
}

/** Ponte ligada desta conversa (origem de um plano), ou null. */
export function ponteLigada(threadId: string, home: string): { slug: string; managerThreadId: string } | null {
  const p = threadHead(threadId, home)?.planoLigado;
  return p?.ligada ? { slug: p.slug, managerThreadId: p.managerThreadId } : null;
}

/** Marca o chat de origem como ligado ao plano recém-criado (card "Abrir planejamento" + ponte). */
export function ligarPlano(origem: string, slug: string, managerThreadId: string, titulo: string, home: string): void {
  gravar({ ts: nowIso(), type: "plano_ligado", threadId: origem, slug, managerThreadId, titulo }, home);
}

/** Liga/desliga a ponte. `false` se a conversa nunca abriu plano. */
export function alternarPonte(origem: string, ligada: boolean, home: string): boolean {
  const p = threadHead(origem, home)?.planoLigado;
  if (!p) return false;
  if (p.ligada !== ligada) gravar({ ts: nowIso(), type: "plano_ponte", threadId: origem, ligada }, home);
  return true;
}

/**
 * Mensagem da pessoa no chat de origem com a ponte ligada: grava a `ida` aqui e entrega ao Manager.
 * Não espera o turno do Manager — a fala dele volta sozinha pelo ouvinte abaixo.
 *
 * Manager ocupado e inject recusado: a mensagem entra na fila da ponte e vai no turno seguinte
 * (antes ia direto pro `postMessage`, que desistia com "thread locked" depois de 10 s e a mensagem
 * sumia). O chat do Manager só mostra a mensagem quando ela foi aceita (respondeu, injetou ou
 * entrou na fila); falha definitiva volta pro chat de origem como `ponte` `falhou`.
 */
export function mandarPelaPonte(origem: string, texto: string, images: IncomingFile[], home: string): void {
  const p = ponteLigada(origem, home);
  if (!p) throw new Error("esta conversa não tem ponte ligada com o Manager");
  gravar({ ts: nowIso(), type: "ponte", threadId: origem, direcao: "ida", texto, managerThreadId: p.managerThreadId }, home);
  const manager = p.managerThreadId;
  // Manager parado numa pergunta: a mensagem É a resposta
  if (images.length === 0 && temPerguntaPendente(manager) && responderPergunta(manager, texto)) return;
  if (dep.injetar(manager, texto, home, images)) {
    mostrarNoManager(manager, texto);
    return;
  }
  enfileirar(manager, { origem, texto, images, desde: Date.now() }, home);
}

/** Chat do Manager aberto na tela: o pedido aparece lá na hora (o evento `user` gravado não vai por SSE). */
function mostrarNoManager(manager: string, texto: string): void {
  sessionBus.emit(manager, { ts: nowIso(), type: "user", threadId: manager, text: texto, viaPonte: true });
}

interface NaFila {
  origem: string;
  texto: string;
  images: IncomingFile[];
  desde: number;
}

/** Mensagens da ponte esperando o Manager terminar o turno, por conversa do Manager (só em memória). */
const filas = new Map<string, NaFila[]>();
const drenando = new Set<string>();

/** Teto de espera na fila: turno com tarefa em background dura até 2 h; passou disso, desiste avisando. */
const FILA_TETO_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;

const depPadrao = {
  injetar: injetarMensagem,
  postar: postMessage,
  ocupado: turnoEmCurso,
  esperaMs: 1000,
  tetoMs: FILA_TETO_MS,
};
let dep = { ...depPadrao };

function enfileirar(manager: string, item: NaFila, home: string): void {
  const fila = filas.get(manager) ?? [];
  // a mesma mensagem (reenvio, clique duplo) não chega duas vezes
  if (item.images.length === 0 && fila.some((x) => x.origem === item.origem && x.texto === item.texto && x.images.length === 0)) return;
  fila.push(item);
  filas.set(manager, fila);
  mostrarNoManager(manager, item.texto);
  void drenar(manager, home);
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Manda a fila pro Manager, uma mensagem por turno, quando ele fica livre. */
async function drenar(manager: string, home: string): Promise<void> {
  if (drenando.has(manager)) return;
  drenando.add(manager);
  try {
    for (;;) {
      const fila = filas.get(manager);
      const item = fila?.[0];
      if (!fila || !item) break;
      if (Date.now() - item.desde > dep.tetoMs) {
        fila.shift();
        falhou(item, manager, "o Manager ficou ocupado tempo demais", home);
        continue;
      }
      if (dep.ocupado(manager)) {
        await dormir(dep.esperaMs);
        continue;
      }
      fila.shift();
      try {
        await dep.postar(manager, item.texto, home, item.images);
      } catch (e) {
        // outro turno pegou a trava antes: volta pro começo da fila e espera de novo
        if ((e as Error & { status?: number }).status === 409) {
          fila.unshift(item);
          await dormir(dep.esperaMs);
          continue;
        }
        falhou(item, manager, (e as Error).message, home);
      }
    }
  } finally {
    drenando.delete(manager);
    if (!filas.get(manager)?.length) filas.delete(manager);
  }
}

function falhou(item: NaFila, manager: string, motivo: string, home: string): void {
  log.erro("turno", "ponte: mensagem pro Manager falhou", { origem: item.origem, manager, erro: motivo });
  gravar(
    { ts: nowIso(), type: "ponte", threadId: item.origem, direcao: "falhou", texto: item.texto, managerThreadId: manager, motivo },
    home,
  );
}

/** Quantas mensagens da ponte esperam o Manager (teste e diagnóstico). */
export function naFilaDaPonte(manager: string): number {
  return filas.get(manager)?.length ?? 0;
}

export function definirDependenciasDaPonteParaTeste(d: Partial<typeof depPadrao>): void {
  dep = { ...depPadrao, ...d };
}

/** Fala gravada do Manager → `ponte` volta no chat de origem, se a ponte dele estiver ligada. */
function espelharFalaDoManager(ev: ThreadEvent, home: string): void {
  if (ev.type !== "assistant" || !ev.text.trim()) return;
  const head = threadHead(ev.threadId, home);
  const origem = head?.planejamento && head.origemThreadId;
  if (!origem) return;
  const p = ponteLigada(origem, home);
  if (p?.managerThreadId !== ev.threadId) return;
  gravar({ ts: nowIso(), type: "ponte", threadId: origem, direcao: "volta", texto: ev.text, managerThreadId: ev.threadId }, home);
}

let desligar: (() => void) | null = null;

/** Liga o espelho da fala do Manager (uma vez por processo; `createApp` chama). */
export function iniciarPontePlano(): void {
  if (!desligar) desligar = aoGravarEvento(espelharFalaDoManager);
}

export function resetPontePlanoForTest(): void {
  desligar?.();
  desligar = null;
  filas.clear();
  drenando.clear();
  dep = { ...depPadrao };
}
