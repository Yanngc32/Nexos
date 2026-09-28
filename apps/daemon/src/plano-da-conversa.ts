import { log } from "./log.ts";
import { abrirPlano, criarPlano, vincularThread } from "./planejamento.ts";
import { conversaDeOrigem, pedidoDeConversa } from "./planejamento-integracao.ts";
import { ligarPlano } from "./ponte-plano.ts";
import { postMessage } from "./session.ts";
import { createThread, threadHead } from "./threads.ts";

/**
 * A conversa do Agent Manager do plano: a que já está ligada a ele, ou uma nova (com
 * `thread_meta.planejamento`) se não houver ou se ela sumiu do disco.
 */
export function conversaDoManager(
  projectPath: string,
  slug: string,
  profileId: unknown,
  home: string,
  origemThreadId?: string,
): string {
  const atual = abrirPlano(projectPath, home, slug).roteiro.threadId;
  if (atual && threadHead(atual, home)?.planejamento?.slug === slug) return atual;
  if (typeof profileId !== "string" || !profileId) {
    throw Object.assign(new Error("profileId obrigatório pra abrir a conversa do Manager"), { status: 400 });
  }
  // `origemThreadId`: plano nascido de conversa — o botão "voltar" do chat leva pra ela
  // título = nome do plano: sem isso a barra e o cabeçalho mostravam o pedido automático ("Monte o plano…")
  const titulo = abrirPlano(projectPath, home, slug).roteiro.titulo;
  const { id } = createThread(
    { projectPath, profileId, title: `Plano · ${titulo}`, planejamento: { slug }, ...(origemThreadId ? { origemThreadId } : {}) },
    home,
  );
  vincularThread(projectPath, home, slug, id);
  return id;
}

export type PlanoDaConversa = { slug: string; projectPath: string; threadId: string; titulo: string; reaproveitado: boolean };

/**
 * Plano nascido de uma conversa: cria no projeto dela, abre o Manager (conta = `profileId` ou a da
 * própria conversa), liga a ponte e manda a transcrição pro Manager SEM esperar o turno.
 *
 * `reusar`: se a conversa já abriu um plano que ainda existe, devolve ele em vez de criar outro —
 * o agente que chama `nexo_plano_iniciar` duas vezes no mesmo pedido não duplica o plano.
 */
export function planejarConversa(
  deThreadId: string,
  home: string,
  opts: { profileId?: unknown; titulo?: unknown; reusar?: boolean } = {},
): PlanoDaConversa {
  const origem = conversaDeOrigem(deThreadId, home);
  const ligado = opts.reusar ? threadHead(deThreadId, home)?.planoLigado : undefined;
  if (ligado) {
    try {
      const plano = abrirPlano(origem.projectPath, home, ligado.slug);
      return { slug: plano.slug, projectPath: origem.projectPath, threadId: ligado.managerThreadId, titulo: plano.roteiro.titulo, reaproveitado: true };
    } catch {
      // plano apagado: cria outro abaixo
    }
  }
  const profileId = typeof opts.profileId === "string" && opts.profileId ? opts.profileId : threadHead(deThreadId, home)?.profileId;
  const plano = criarPlano(origem.projectPath, home, { titulo: opts.titulo || origem.titulo });
  const threadId = conversaDoManager(origem.projectPath, plano.slug, profileId, home, deThreadId);
  const titulo = plano.roteiro?.titulo || origem.titulo || plano.slug;
  ligarPlano(deThreadId, plano.slug, threadId, titulo, home);
  void postMessage(threadId, pedidoDeConversa(origem), home, [], { automatico: true }).catch((err) =>
    log.erro("turno", `plano a partir da conversa ${deThreadId} falhou`, { threadId, erro: (err as Error).message }),
  );
  return { slug: plano.slug, projectPath: origem.projectPath, threadId, titulo, reaproveitado: false };
}
