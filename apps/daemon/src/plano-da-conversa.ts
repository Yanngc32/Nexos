import { log } from "./log.ts";
import { criarPlano, roteiroDoPlano, vincularThread } from "./planejamento.ts";
import { conversaDeOrigem } from "./planejamento-integracao.ts";
import { postMessage, turnoEmCurso } from "./session.ts";
import { appendEvent, createThread, threadHead } from "./threads.ts";

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
  // só o roteiro: abrir o plano inteiro leria todos os cards pra pegar um id
  const roteiro = roteiroDoPlano(projectPath, home, slug);
  const atual = roteiro.threadId;
  if (atual && threadHead(atual, home)?.planejamento?.slug === slug) return atual;
  if (typeof profileId !== "string" || !profileId) {
    throw Object.assign(new Error("profileId obrigatório pra abrir a conversa do Manager"), { status: 400 });
  }
  // `origemThreadId`: plano nascido de conversa — o botão "voltar" do chat leva pra ela
  // título = nome do plano: sem isso a barra e o cabeçalho mostravam o pedido automático ("Monte o plano…")
  const titulo = roteiro.titulo;
  const { id } = createThread(
    { projectPath, profileId, title: `Plano · ${titulo}`, planejamento: { slug }, ...(origemThreadId ? { origemThreadId } : {}) },
    home,
  );
  vincularThread(projectPath, home, slug, id);
  return id;
}

export type PlanoDaConversa = { slug: string; projectPath: string; threadId: string; titulo: string; reaproveitado: boolean };

/**
 * Plano nascido de uma conversa: cria no projeto dela e a PRÓPRIA conversa vira o Agent Manager
 * (`thread_planejamento`): o histórico já está nela, então não há Manager separado, transcrição
 * nem ponte. Ela passa a só ler o projeto e mexer no plano (como todo Manager) e recebe um pedido
 * automático pra montar o plano — no turno seguinte, se esta chamada veio do meio de um turno
 * (`nexo_plano_iniciar`).
 *
 * `reusar`: se a conversa já é Manager (ou já abriu um plano, no jeito antigo com ponte) de um
 * plano que ainda existe, devolve ele em vez de criar outro — o agente que chama
 * `nexo_plano_iniciar` duas vezes no mesmo pedido não duplica o plano.
 */
export function planejarConversa(
  deThreadId: string,
  home: string,
  opts: { profileId?: unknown; titulo?: unknown; reusar?: boolean } = {},
): PlanoDaConversa {
  const head = threadHead(deThreadId, home);
  if (opts.reusar && head?.planejamento && head.projectPath) {
    try {
      const roteiro = roteiroDoPlano(head.projectPath, home, head.planejamento.slug);
      return { slug: head.planejamento.slug, projectPath: head.projectPath, threadId: deThreadId, titulo: roteiro.titulo, reaproveitado: true };
    } catch {
      // plano apagado: segue e cria outro abaixo (conversaDeOrigem recusa conversa já Manager)
    }
  }
  const ligado = opts.reusar ? head?.planoLigado : undefined;
  if (ligado && head?.projectPath) {
    try {
      const roteiro = roteiroDoPlano(head.projectPath, home, ligado.slug);
      return { slug: ligado.slug, projectPath: head.projectPath, threadId: ligado.managerThreadId, titulo: roteiro.titulo, reaproveitado: true };
    } catch {
      // plano apagado: cria outro abaixo
    }
  }
  const origem = conversaDeOrigem(deThreadId, home);
  const plano = criarPlano(origem.projectPath, home, { titulo: opts.titulo || origem.titulo });
  const titulo = plano.roteiro?.titulo || origem.titulo || plano.slug;
  appendEvent({ ts: new Date().toISOString(), type: "thread_planejamento", threadId: deThreadId, slug: plano.slug, titulo }, home);
  vincularThread(origem.projectPath, home, plano.slug, deThreadId);
  void postarQuandoLivre(deThreadId, pedidoDeVirarManager(titulo), home).catch((err) =>
    log.erro("turno", `plano a partir da conversa ${deThreadId} falhou`, { slug: plano.slug, erro: (err as Error).message }),
  );
  return { slug: plano.slug, projectPath: origem.projectPath, threadId: deThreadId, titulo, reaproveitado: false };
}

/** Primeiro pedido da conversa que virou Manager: o contexto já é o histórico dela. */
export function pedidoDeVirarManager(titulo: string): string {
  return (
    `A partir daqui esta conversa é o Agent Manager do plano "${titulo}". Monte o plano com o que já conversamos: ` +
    "separe o pedido em etapas (nexo_plano_roteiro) e registre como cards os requisitos, as decisões (com o porquê) e as " +
    "ambiguidades que ficaram em aberto. O que já foi decidido aqui é decisão; o que ficou vago é ambiguidade — pergunte antes de supor."
  );
}

const FILA_TETO_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;
const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Manda a mensagem quando a conversa estiver livre: `nexo_plano_iniciar` roda no meio do turno
 * dela, e mandar já esbarraria na trava da conversa ("thread locked").
 */
async function postarQuandoLivre(threadId: string, texto: string, home: string, dep = { ocupado: turnoEmCurso, postar: postMessage, esperaMs: 1000 }): Promise<void> {
  const desde = Date.now();
  for (;;) {
    if (Date.now() - desde > FILA_TETO_MS) throw new Error("a conversa ficou ocupada tempo demais");
    if (dep.ocupado(threadId)) {
      await dormir(dep.esperaMs);
      continue;
    }
    try {
      await dep.postar(threadId, texto, home, [], { automatico: true });
      return;
    } catch (e) {
      if ((e as Error & { status?: number }).status !== 409) throw e;
      await dormir(dep.esperaMs);
    }
  }
}
