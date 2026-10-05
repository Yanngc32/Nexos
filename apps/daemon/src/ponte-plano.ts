import type { ThreadEvent } from "@nexos/shared";
import type { IncomingFile } from "./attachments.ts";
import { sessionBus } from "./bus.ts";
import { log } from "./log.ts";
import { responderPergunta, temPerguntaPendente } from "./perguntas.ts";
import { injetarMensagem, postMessage } from "./session.ts";
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
 */
export function mandarPelaPonte(origem: string, texto: string, images: IncomingFile[], home: string): void {
  const p = ponteLigada(origem, home);
  if (!p) throw new Error("esta conversa não tem ponte ligada com o Manager");
  gravar({ ts: nowIso(), type: "ponte", threadId: origem, direcao: "ida", texto, managerThreadId: p.managerThreadId }, home);
  const manager = p.managerThreadId;
  // Manager parado numa pergunta: a mensagem É a resposta
  if (images.length === 0 && temPerguntaPendente(manager) && responderPergunta(manager, texto)) return;
  // chat do Manager aberto na tela: o pedido aparece lá na hora (o evento `user` gravado não vai por SSE)
  sessionBus.emit(manager, { ts: nowIso(), type: "user", threadId: manager, text: texto, viaPonte: true });
  if (injetarMensagem(manager, texto, home, images)) return;
  void postMessage(manager, texto, home, images).catch((e) =>
    log.erro("turno", "ponte: mensagem pro Manager falhou", { origem, manager, erro: (e as Error).message }),
  );
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
}
