/**
 * Auditor PO: um juiz (Sonnet, turno lateral só leitura) que olha cada turno da conversa e mantém
 * o quadro honesto.
 *
 * - Abertura (mensagem nova da pessoa): o pedido vira card "em andamento" — ou retoma o que já
 *   existe (ANDAMENTO), sem duplicar. Corre solto: o turno não espera.
 * - Fechamento (`done` do turno): julga o que o agente devolveu — CONCLUIR, PENDENTE (com o que a
 *   pessoa precisa fazer), FEITA, NOVA — e o que não for julgado é concluído com o motivo padrão.
 *   O fim do turno espera por ele até 30 s (`fecharTurno({ aguardar })`); depois disso, roda solto.
 *
 * Nada aqui quebra o chat: toda falha vira aviso no log e linha no diário (`po-decisions.log`).
 * Desligado com `modulos.auditorPO` ou com o Quadro desligado; conversa fora do Quadro (plano,
 * passo de time/run, oculta) nem chega aqui — quem filtra é `session.ts` (`entraNoQuadro`).
 */
import type { ThreadEvent } from "@nexos/shared";
import { loadConfig } from "../config.ts";
import { log } from "../log.ts";
import { roteiroDoPlano } from "../planejamento.ts";
import { MARCA_FIM_DE_TURNO } from "../tarefas-agente.ts";
import { canalTarefas, getQuadro, getTarefa, listarTarefas, statusEfetivo, tarefasBus, type Tarefa } from "../tarefas.ts";
import { readThread } from "../threads.ts";
import { aplicarVeredito } from "./aplicar.ts";
import { registrarDecisaoPO } from "./decisoes.ts";
import { MAX_CARDS_PO, MAX_DEVOLVIDOS_PO, montarPromptPO, type CardDoDigest, type EtapaDoDigest } from "./digest.ts";
import { FilaPO, MAX_CHAMADAS_PO, type LotePO, type OpcoesDaFila } from "./fila.ts";
import { evidenciaDoGit, rodarGitPadrao, type RodarGit } from "./git.ts";
import { rodarPOPadrao, type RodarPO } from "./motor.ts";
import { lerVeredito, type FasePO } from "./veredito.ts";

export type ResultadoPO = "ok" | "erro" | "sem-mudanca";
export type UltimaRodadaPO = { fase: FasePO; resultado: ResultadoPO; cards: string[]; em: string; segurar?: string };
export type StatusDoPO = { ligado: boolean; ultima?: UltimaRodadaPO };
/** Evento no canal SSE do quadro (`/v1/tarefas/eventos`). */
export type EventoPO = { tipo: "po.rodada"; projectPath: string; threadId: string; ligado: true; ultima: UltimaRodadaPO };

type Limpar = (s: string) => string;
type Deps = { rodar: RodarPO; git: RodarGit; limpar?: Limpar; fila?: OpcoesDaFila };

let deps: Deps = { rodar: rodarPOPadrao, git: rodarGitPadrao };
let fila: FilaPO | null = null;
const ultimaPorProjeto = new Map<string, UltimaRodadaPO>();
/** Conversa → de onde ela é (a fila só guarda o lote). */
const contextos = new Map<string, { projectPath: string; home: string; profileId?: string }>();
/** Cards que a abertura deste turno retomou — o fechamento marca "(retomado)". */
const retomadosPorConversa = new Map<string, Set<string>>();
/** Mensagens esperando a vez da conversa (a 1ª é o "próximo da fila" do fechamento). */
const esperando = new Map<string, Array<{ texto: string }>>();

function msg(e: unknown): string {
  return (e as Error)?.message || String(e);
}

export function poLigado(home: string): boolean {
  try {
    const m = loadConfig(home).modulos;
    return m.auditorPO !== false && m.quadroTarefas !== false;
  } catch {
    return false;
  }
}

export function statusDoPO(projectPath: string | undefined, home: string): StatusDoPO {
  const ultima = projectPath ? ultimaPorProjeto.get(projectPath) : undefined;
  return { ligado: poLigado(home), ...(ultima ? { ultima } : {}) };
}

/**
 * A mensagem entrou na espera da conversa (o turno anterior ainda corre). Devolve quem tira ela
 * da espera — chame quando o turno dela começar (ou falhar antes).
 */
export function entrarNaEsperaDoPO(threadId: string, texto: string): () => void {
  const item = { texto };
  const lista = esperando.get(threadId) ?? [];
  lista.push(item);
  esperando.set(threadId, lista);
  let saiu = false;
  return () => {
    if (saiu) return;
    saiu = true;
    const l = esperando.get(threadId);
    if (!l) return;
    const i = l.indexOf(item);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) esperando.delete(threadId);
  };
}

// ---------------------------------------------------------------------------------------------
// Lote do turno a partir do JSONL da conversa.

function depoisDoUltimoPedido(eventos: readonly ThreadEvent[]): { pedido?: string; antes: ThreadEvent[]; depois: ThreadEvent[] } {
  let i = eventos.length - 1;
  while (i >= 0 && eventos[i]!.type !== "user") i--;
  if (i < 0) return { antes: [], depois: [...eventos] };
  const u = eventos[i]!;
  return { pedido: u.type === "user" ? u.text : undefined, antes: eventos.slice(0, i), depois: eventos.slice(i + 1) };
}

/** Fechamento: pedido + ferramentas + mensagens do meio + resposta final (a última fala). */
export function loteDoFechamento(eventos: readonly ThreadEvent[], proximo?: string): LotePO {
  const { pedido, depois } = depoisDoUltimoPedido(eventos);
  const chamadas: LotePO["chamadas"] = [];
  const falas: string[] = [];
  for (const e of depois) {
    if (e.type === "tool") chamadas.push({ ferramenta: e.name, detalhe: e.summary ?? "" });
    else if (e.type === "assistant" && e.text.trim()) falas.push(e.text);
  }
  const resposta = falas.pop();
  return {
    textos: pedido ? [pedido] : [],
    chamadas: chamadas.slice(-MAX_CHAMADAS_PO),
    mensagens: falas,
    ...(resposta ? { resposta } : {}),
    ...(proximo?.trim() ? { proximo: proximo.trim() } : {}),
    turnos: 1,
  };
}

/** Abertura: o pedido novo + a resposta final do turno anterior (o que ficou combinado). */
export function loteDaAbertura(eventos: readonly ThreadEvent[]): LotePO {
  const { pedido, antes } = depoisDoUltimoPedido(eventos);
  let anterior: string | undefined;
  for (let i = antes.length - 1; i >= 0; i--) {
    const e = antes[i]!;
    if (e.type === "assistant" && e.text.trim()) {
      anterior = e.text;
      break;
    }
    if (e.type === "user") break;
  }
  return { textos: pedido ? [pedido] : [], chamadas: [], mensagens: [], ...(anterior ? { respostaAnterior: anterior } : {}), turnos: 1 };
}

// ---------------------------------------------------------------------------------------------
// Quadro e plano vistos pelo PO.

function tituloDe(t: Tarefa): string {
  return t.po?.titulo || t.titulo;
}

/** O card está "em jogo" pro fechamento: em andamento, ou devolvido pelo fim do turno. */
function devolvido(t: Tarefa, quadro: ReturnType<typeof getQuadro>): boolean {
  const s = statusEfetivo(t, quadro);
  return s === "in_progress" || (s === "pending" && !!t.po?.motivo?.startsWith(MARCA_FIM_DE_TURNO));
}

/**
 * QUADRO ATUAL: os cards desta conversa (abertos primeiro, depois os concluídos mais novos) e os
 * "a fazer" das outras conversas do projeto, marcados — até 30.
 */
export function cardsDoDigest(tarefas: readonly Tarefa[], threadId: string, quadro: ReturnType<typeof getQuadro>): CardDoDigest[] {
  const recentes = [...tarefas].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const daqui = recentes.filter((t) => t.threadId === threadId);
  const abertos = daqui.filter((t) => statusEfetivo(t, quadro) !== "completed");
  const feitos = daqui.filter((t) => statusEfetivo(t, quadro) === "completed");
  const deFora = recentes.filter((t) => t.threadId !== threadId && statusEfetivo(t, quadro) === "pending");
  return [...abertos, ...deFora, ...feitos].slice(0, MAX_CARDS_PO).map((t) => ({
    id: t.id,
    status: statusEfetivo(t, quadro),
    titulo: tituloDe(t),
    ...(t.threadId !== threadId ? { outraConversa: true } : {}),
  }));
}

function etapasDoPlano(projectPath: string, home: string, daqui: readonly Tarefa[]): EtapaDoDigest[] {
  const planos = [...new Set(daqui.map((t) => t.origem?.plano).filter((x): x is string => !!x))];
  const quadro = getQuadro(projectPath, home);
  const out: EtapaDoDigest[] = [];
  for (const slug of planos) {
    try {
      for (const e of roteiroDoPlano(projectPath, home, slug).etapas) {
        const card = e.tarefaId ? getTarefa(projectPath, home, e.tarefaId) : undefined;
        out.push({
          etapaId: e.id,
          titulo: e.titulo,
          placar: e.implementacao ?? "pendente",
          ...(card ? { cartao: { id: card.id, status: statusEfetivo(card, quadro) } } : {}),
        });
      }
    } catch (e) {
      log.avisoUmaVez(`po:plano:${slug}`, "turno", "o PO não leu o plano do card", { plano: slug, erro: msg(e) });
    }
  }
  return out;
}

async function limparPadrao(): Promise<Limpar> {
  if (deps.limpar) return deps.limpar;
  const { limparSegredos } = await import("../aprendizado-analise.ts");
  return limparSegredos;
}

// ---------------------------------------------------------------------------------------------
// A rodada.

function publicar(projectPath: string, threadId: string, ultima: UltimaRodadaPO): void {
  ultimaPorProjeto.set(projectPath, ultima);
  try {
    const ev: EventoPO = { tipo: "po.rodada", projectPath, threadId, ligado: true, ultima };
    tarefasBus.emit(canalTarefas(projectPath), ev);
  } catch {
    // ninguém ouvindo não é erro
  }
}

async function executar({ threadId, fase }: { threadId: string; fase: FasePO }, lote: LotePO): Promise<void> {
  const c = contextos.get(threadId);
  if (!c) return;
  const { projectPath, home, profileId } = c;
  const inicio = Date.now();
  const diario = (outcome: string, route: string, cards: string[], detalhe?: string) =>
    registrarDecisaoPO(home, {
      conversationId: threadId,
      phase: fase,
      outcome,
      route,
      durationMs: Date.now() - inicio,
      cards,
      ...(detalhe ? { detalhe } : {}),
    });
  if (!poLigado(home)) {
    diario("pulado:desligado", "-", []);
    return;
  }

  const limpar = await limparPadrao();
  const quadro = getQuadro(projectPath, home);
  const tarefas = listarTarefas(projectPath, home);
  const daqui = tarefas.filter((t) => t.threadId === threadId);
  const retomados = retomadosPorConversa.get(threadId) ?? new Set<string>();
  const devolvidos =
    fase === "fechamento"
      ? daqui
          .filter((t) => devolvido(t, quadro))
          .slice(0, MAX_DEVOLVIDOS_PO)
          .map((t) => ({ id: t.id, ...(retomados.has(t.id) ? { retomado: true } : {}) }))
      : [];
  const etapas = fase === "fechamento" ? etapasDoPlano(projectPath, home, daqui) : [];
  // Commits desde o card aberto mais antigo desta conversa.
  const desde = daqui
    .filter((t) => devolvidos.some((d) => d.id === t.id))
    .map((t) => t.createdAt)
    .sort()[0];
  const git = fase === "fechamento" ? await evidenciaDoGit(projectPath, desde, deps.git) : "";
  const montado = montarPromptPO({
    fase,
    lote,
    cards: cardsDoDigest(tarefas, threadId, quadro),
    devolvidos,
    etapas,
    git,
    limpar,
  });

  let texto: string;
  let rota = "-";
  try {
    const r = await deps.rodar(montado.prompt, {
      home,
      projectPath,
      ...(profileId ? { threadProfileId: profileId } : {}),
      modelo: loadConfig(home).poModelo || "sonnet",
    });
    texto = r.texto;
    rota = r.rota;
  } catch (e) {
    diario("erro", rota, [], msg(e));
    publicar(projectPath, threadId, { fase, resultado: "erro", cards: [], em: new Date().toISOString() });
    // A fila tenta de novo (até 2 vezes, 60 s depois).
    throw e;
  }

  const veredito = lerVeredito(texto, { fase, ids: montado.ids, etapas: montado.etapas, temProximo: montado.temProximo });
  if (!veredito.legivel) {
    // Fail closed: resposta sem cara de veredito não mexe em nada (nem no padrão do fechamento).
    diario("ilegivel", rota, [], texto.slice(0, 200));
    publicar(projectPath, threadId, { fase, resultado: "erro", cards: [], em: new Date().toISOString() });
    return;
  }
  const r = aplicarVeredito(veredito, { projectPath, home, threadId, fase, devolvidos: devolvidos.map((d) => d.id) });
  if (fase === "fechamento") retomadosPorConversa.delete(threadId);
  if (r.segurar) {
    // Agent Code segura a fila; aqui o Nexos ainda não tem como — fica no diário e no SSE.
    diario("segurar", rota, r.cards, r.segurar);
  }
  const resultado: ResultadoPO = r.cards.length ? "ok" : "sem-mudanca";
  if (!r.segurar) diario(resultado, rota, r.cards);
  publicar(projectPath, threadId, {
    fase,
    resultado,
    cards: r.cards,
    em: new Date().toISOString(),
    ...(r.segurar ? { segurar: r.segurar } : {}),
  });
}

function aFila(): FilaPO {
  fila ??= new FilaPO(executar, deps.fila);
  return fila;
}

function pedir(
  fase: FasePO,
  threadId: string,
  projectPath: string | undefined,
  home: string,
  profileId: string | undefined,
  lote: () => LotePO,
): Promise<void> {
  try {
    if (!projectPath || !poLigado(home)) return Promise.resolve();
    contextos.set(threadId, { projectPath, home, ...(profileId ? { profileId } : {}) });
    return aFila()
      .pedir(threadId, fase, lote())
      .catch(() => undefined);
  } catch (e) {
    log.avisoUmaVez(`po:${fase}:${threadId}`, "turno", "o PO não entrou na rodada", { threadId, fase, erro: msg(e) });
    return Promise.resolve();
  }
}

/** Mensagem nova da pessoa (já gravada no JSONL). `retomados` = o que `retomarTurno` voltou a andar. Nunca rejeita. */
export function abrirRodadaPO(
  threadId: string,
  projectPath: string | undefined,
  home: string,
  profileId: string | undefined,
  retomados: readonly string[] = [],
): Promise<void> {
  if (retomados.length) {
    const s = retomadosPorConversa.get(threadId) ?? new Set<string>();
    for (const id of retomados) s.add(id);
    retomadosPorConversa.set(threadId, s);
  }
  return pedir("abertura", threadId, projectPath, home, profileId, () => loteDaAbertura(readThread(threadId, home)));
}

/** `done` do turno. A promessa é o que `fecharTurno({ aguardar })` espera (até 30 s). Nunca rejeita. */
export function fecharRodadaPO(
  threadId: string,
  projectPath: string | undefined,
  home: string,
  profileId: string | undefined,
): Promise<void> {
  return pedir("fechamento", threadId, projectPath, home, profileId, () =>
    loteDoFechamento(readThread(threadId, home), esperando.get(threadId)?.[0]?.texto),
  );
}

// ---------------------------------------------------------------------------------------------
// Testes.

export function definirDepsDoPOParaTeste(d: Partial<Deps>): void {
  deps = { rodar: d.rodar ?? rodarPOPadrao, git: d.git ?? rodarGitPadrao, ...(d.limpar ? { limpar: d.limpar } : {}), ...(d.fila ? { fila: d.fila } : {}) };
  fila = null;
}

export async function resetPOParaTeste(): Promise<void> {
  const f = fila;
  fila = null;
  deps = { rodar: rodarPOPadrao, git: rodarGitPadrao };
  ultimaPorProjeto.clear();
  contextos.clear();
  retomadosPorConversa.clear();
  esperando.clear();
  if (f) await f.esvaziar().catch(() => undefined);
}
