import type { ThreadEvent } from "@nexos/shared";
import { catalogoDoCerebro, type Capacidade } from "./cerebro-catalogo.ts";
import { registrarDisparo, tipoDaConversa, type TipoDeConversa } from "./cerebro-uso.ts";
import { log } from "./log.ts";

/**
 * Cérebro — o que lembra o modelo das capacidades no momento certo. Duas peças, as duas sem LLM:
 *
 * 1. `blocoDoCerebro`: o bloco `# Cérebro` do pack de regras (session.ts), teto `BLOCO_MAX`. Uma
 *    linha por capacidade (`quando <gatilhos> → <comoUsar>`), priorizando o que a pessoa editou, o
 *    que é subagente/skill (os menos usados) e o que tem uso recente. Substitui os lembretes soltos
 *    de antes ("Perguntar com opções", "Quadro de tarefas", "Mock vai pro Canvas", "Símbolos sob
 *    demanda"): eles viraram `comoUsar` das capacidades correspondentes (`REGRAS_CURTAS`), que a
 *    pessoa edita na aba Cérebro.
 *
 * 2. `lembreteDoCerebro`: a cada mensagem, confere os gatilhos do catálogo contra o texto (e o
 *    estado do turno anterior) e prefixa `[Cérebro] …` com até `LEMBRETES_POR_MENSAGEM`
 *    capacidades. A mesma capacidade não repete na conversa antes de `MENSAGENS_ENTRE_REPETICOES`
 *    mensagens. Cada disparo vai pro contador (cerebro-uso.ts) pra medir "disparou × usou".
 */

export const BLOCO_MAX = 1500;
export const LEMBRETES_POR_MENSAGEM = 3;
export const MENSAGENS_ENTRE_REPETICOES = 10;
/** Leituras/buscas no turno anterior sem nenhum subagente a partir das quais vale lembrar o explorador. */
export const LEITURAS_SEM_SUBAGENTE = 8;
const COMO_USAR_NO_LEMBRETE = 110;

export const TITULO_DO_BLOCO = "# Cérebro";

/**
 * Regras que antes eram blocos inteiros do pack, condensadas no `comoUsar` da capacidade. Ficam
 * aqui (e não em `GATILHOS_CURADOS`) porque dependem de contexto que só o pack sabe (módulo
 * ligado, projeto aberto) e porque a pessoa pode reescrevê-las por cima no catálogo.
 */
export const REGRAS_CURTAS: Record<string, string> = {
  "ferramenta:nexo_perguntar":
    "a pessoa precisa ESCOLHER: `nexo_perguntar` com `opcoes` (nunca \"A) B) C)\" em texto); " +
    "várias perguntas = uma chamada por vez; `multiSelect` se mais de uma vale",
  "ferramenta:nexo_tarefa_listar":
    "mensagem com MAIS DE UM pedido: antes de começar, `nexo_tarefa_listar` + um card por pedido " +
    "(`nexo_tarefa_salvar`), atualize o card da vez e mova pra coluna final ao concluir; pedido único = aja direto",
  "ferramenta:nexo_mock_salvar":
    "card no Canvas via `nexo_mock_salvar` (painel de mocks do DS oficial), confira com `nexo_ds_print`; " +
    "NUNCA arquivo no repo nem dev server — só vira código se pedirem \"implementa\"",
  "ferramenta:nexo_mapa_simbolos":
    "`nexo_mapa_simbolos` no arquivo/pasta ANTES do Read (assinaturas top-level por fração do custo); " +
    "só abra o arquivo se os símbolos confirmarem",
};

/** Ferramentas que uma conversa de run/passo de time NÃO tem (espelho do `POST /v1/mcp`). */
const FORA_DO_RUN = new Set([
  "nexo_delegar",
  "nexo_abrir_painel",
  "nexo_arquivo_entregar",
  "nexo_planejar",
  "nexo_servico_subir",
  "nexo_servico_parar",
  "nexo_servico_listar",
]);
const PREFIXOS_FORA_DO_RUN = ["nexo_navegador_", "nexo_chrome_", "nexo_ds_", "nexo_mock_", "nexo_video_", "nexo_windows_"];
/** O Agent Manager só vê isto (planejamento): nada de autoria, tarefas, delegar, navegador. */
const DO_MANAGER = new Set(["nexo_perguntar", "nexo_mapa_simbolos", "nexo_ds_print", "nexo_abrir_painel", "nexo_cerebro"]);

export type ContextoDoBloco = { tipo: TipoDeConversa; planejamento?: boolean; quadroTarefas?: boolean };

/** Capacidades que fazem sentido nesta conversa (ligadas, com gatilho, disponíveis no tipo dela). */
export function capacidadesVisiveis(itens: Capacidade[], ctx: ContextoDoBloco): Capacidade[] {
  return itens.filter((c) => {
    if (!c.ligada) return false;
    if (c.tipo === "ferramenta") {
      if (c.nome === "ToolSearch") return false;
      if (ctx.planejamento) return DO_MANAGER.has(c.nome);
      if (ctx.quadroTarefas === false && c.nome.startsWith("nexo_tarefa_")) return false;
      if (ctx.tipo === "run" || ctx.tipo === "time") {
        if (FORA_DO_RUN.has(c.nome)) return false;
        if (PREFIXOS_FORA_DO_RUN.some((p) => c.nome.startsWith(p))) return false;
      }
    }
    if (ctx.planejamento && c.tipo !== "ferramenta") return false;
    return true;
  });
}

function pesoNoBloco(c: Capacidade): number {
  let p = 0;
  if (c.origem === "pessoa") p += 100;
  if (REGRAS_CURTAS[c.id]) p += 90;
  if (c.tipo === "agente") p += 40;
  if (c.tipo === "skill") p += 30;
  if (c.tipo === "time") p += 20;
  if (c.gatilhos.length) p += 10;
  if (c.usos7d > 0) p += 5;
  return p;
}

function comoUsarDe(c: Capacidade): string {
  return c.origem === "pessoa" ? c.comoUsar : (REGRAS_CURTAS[c.id] ?? c.comoUsar);
}

/** Uma linha do índice: `quando <gatilhos> → <comoUsar>` (capacidade sem gatilho usa a descrição). */
function linhaDoBloco(c: Capacidade): string {
  const quando = c.gatilhos.length ? c.gatilhos.slice(0, 4).join(" / ") : c.descricao;
  return `- ${quando} → ${comoUsarDe(c)}`;
}

/**
 * O bloco `# Cérebro` do pack. Sem projeto/catálogo útil devolve "" (nada entra). Conversa oculta
 * (trabalho interno do Nexos) nunca recebe.
 */
export function montarBlocoDoCerebro(itens: Capacidade[], ctx: ContextoDoBloco, opts: { nexoCerebro?: boolean } = {}): string {
  return medirBlocoDoCerebro(itens, ctx, opts).texto;
}

export type MedidaDoBloco = { texto: string; caracteres: number; max: number; dentro: string[]; fora: string[] };

/** O bloco e o que coube nele: `fora` = capacidades com gatilho que o teto deixou de fora. */
export function medirBlocoDoCerebro(itens: Capacidade[], ctx: ContextoDoBloco, opts: { nexoCerebro?: boolean } = {}): MedidaDoBloco {
  const vazio: MedidaDoBloco = { texto: "", caracteres: 0, max: BLOCO_MAX, dentro: [], fora: [] };
  if (ctx.tipo === "oculta") return vazio;
  const visiveis = capacidadesVisiveis(itens, ctx)
    .filter((c) => c.gatilhos.length || REGRAS_CURTAS[c.id])
    .sort((a, b) => pesoNoBloco(b) - pesoNoBloco(a) || b.usos30d - a.usos30d || a.nome.localeCompare(b.nome, "pt-BR"));
  const cabecalho = [
    TITULO_DO_BLOCO,
    (opts.nexoCerebro !== false
      ? "Não sabe que ferramenta/skill/agente usar? `nexo_cerebro consultar(situacao)` devolve as capacidades certas sem adivinhar. "
      : "") +
      "Lembretes do que você sabe usar, no formato `quando → como`. Vale em toda a conversa:",
  ].join("\n");
  const linhas: string[] = [];
  const dentro: string[] = [];
  const fora: string[] = [];
  let tamanho = cabecalho.length;
  for (const c of visiveis) {
    const l = linhaDoBloco(c);
    if (tamanho + l.length + 1 > BLOCO_MAX) {
      fora.push(c.id);
      continue;
    }
    linhas.push(l);
    dentro.push(c.id);
    tamanho += l.length + 1;
  }
  if (!linhas.length) return { ...vazio, fora };
  const texto = `${cabecalho}\n${linhas.join("\n")}`;
  return { texto, caracteres: texto.length, max: BLOCO_MAX, dentro, fora };
}

export function blocoDoCerebro(projectPath: string | undefined, home: string, ctx: ContextoDoBloco): string {
  try {
    return montarBlocoDoCerebro(catalogoDoCerebro(projectPath, home), ctx);
  } catch (e) {
    log.avisoUmaVez("cerebro-pack", "cerebro", "bloco do Cérebro ficou fora do contexto", { erro: (e as Error).message });
    return "";
  }
}

/* ---------------------------------------------------------------------------
 * Gatilhos por mensagem
 * ------------------------------------------------------------------------- */

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/** O gatilho bate como palavra/trecho inteiro (não dentro de outra palavra: "ui" não casa "fluido"). */
export function gatilhoBate(texto: string, gatilho: string): boolean {
  const t = normalizar(texto);
  const g = normalizar(gatilho).trim();
  if (!g) return false;
  let i = t.indexOf(g);
  while (i >= 0) {
    const antes = i === 0 ? " " : t[i - 1]!;
    const depois = i + g.length >= t.length ? " " : t[i + g.length]!;
    if (!/[\p{L}\p{N}_]/u.test(antes) && !/[\p{L}\p{N}_]/u.test(depois)) return true;
    i = t.indexOf(g, i + 1);
  }
  return false;
}

export type Disparo = { id: string; gatilho: string; comoUsar: string };

/** Sinais do estado da conversa (além do texto), vindos de quem conhece o histórico. */
export type SinaisDoTurno = {
  /** Leituras/buscas (Read/Grep/Glob/Bash) no turno anterior sem nenhum `Agent`. */
  leiturasSemSubagente?: number;
  /** Nomes dos anexos/arquivos citados na mensagem. */
  arquivos?: string[];
};

/**
 * Puro: quais capacidades a mensagem (e os sinais) acordam, até `LEMBRETES_POR_MENSAGEM`,
 * ignorando as que dispararam há menos de `MENSAGENS_ENTRE_REPETICOES` mensagens
 * (`ultimoDisparo`: id → índice da mensagem em que disparou; `indice` = índice desta).
 */
export type Candidato = Disparo & { peso: number; bateram: string[]; entra: boolean };

/**
 * Todas as capacidades que a mensagem acorda, com peso e os termos que bateram. As que `entra`
 * são as que vão no lembrete (até `LEMBRETES_POR_MENSAGEM`, sem as que dispararam há pouco).
 */
export function candidatosDosGatilhos(
  texto: string,
  itens: Capacidade[],
  ctx: ContextoDoBloco,
  opts: { indice: number; ultimoDisparo: ReadonlyMap<string, number>; sinais?: SinaisDoTurno } = { indice: 0, ultimoDisparo: new Map() },
): Array<Candidato & { recente: boolean }> {
  const out: Array<Candidato & { recente: boolean }> = [];
  const textoComArquivos = [texto, ...(opts.sinais?.arquivos ?? [])].join(" ");
  for (const c of capacidadesVisiveis(itens, ctx)) {
    const u = opts.ultimoDisparo.get(c.id);
    const recente = u !== undefined && opts.indice - u < MENSAGENS_ENTRE_REPETICOES;
    const bateram = c.gatilhos.filter((g) => gatilhoBate(textoComArquivos, g));
    let peso = bateram.reduce((s, g) => s + g.length, 0);
    let gatilho = bateram[0];
    if (c.id === "agente:explorador" && (opts.sinais?.leiturasSemSubagente ?? 0) >= LEITURAS_SEM_SUBAGENTE) {
      peso += 50;
      gatilho ??= "varredura ampla no turno anterior";
    }
    if (!gatilho) continue;
    if (c.origem === "pessoa") peso += 20;
    if (c.tipo === "agente" || c.tipo === "skill") peso += 10;
    out.push({ id: c.id, gatilho, comoUsar: comoUsarDe(c).slice(0, COMO_USAR_NO_LEMBRETE), peso, bateram, entra: false, recente });
  }
  out.sort((a, b) => Number(a.recente) - Number(b.recente) || b.peso - a.peso || a.id.localeCompare(b.id));
  let n = 0;
  for (const c of out) {
    if (c.recente || n >= LEMBRETES_POR_MENSAGEM) continue;
    c.entra = true;
    n += 1;
  }
  return out;
}

/**
 * "Testar gatilhos" da aba Cérebro: o que esta mensagem acordaria, sem registrar disparo nem
 * mexer em conversa nenhuma. `linha` é exatamente o prefixo que iria pro modelo.
 */
export function testarGatilhos(texto: string, itens: Capacidade[], ctx: ContextoDoBloco): { candidatos: Candidato[]; linha: string } {
  const candidatos = candidatosDosGatilhos(texto, itens, ctx).map(({ recente: _recente, ...c }) => c);
  return { candidatos, linha: textoDoLembrete(candidatos.filter((c) => c.entra)) };
}

export function casarGatilhos(
  texto: string,
  itens: Capacidade[],
  ctx: ContextoDoBloco,
  opts: { indice: number; ultimoDisparo: ReadonlyMap<string, number>; sinais?: SinaisDoTurno } = { indice: 0, ultimoDisparo: new Map() },
): Disparo[] {
  return candidatosDosGatilhos(texto, itens, ctx, opts)
    .filter((c) => c.entra)
    .map(({ id, gatilho, comoUsar }) => ({ id, gatilho, comoUsar }));
}

/** A linha que vai na frente da mensagem. */
export function textoDoLembrete(disparos: Disparo[]): string {
  if (!disparos.length) return "";
  return `[Cérebro] ${disparos.map((d) => `${d.gatilho} → ${d.comoUsar}`).join("; ")}`;
}

/** Leituras/buscas desde a última mensagem da pessoa e se houve subagente — pro sinal do explorador. */
export function sinaisDoHistorico(eventos: ThreadEvent[]): SinaisDoTurno {
  let leituras = 0;
  let subagente = false;
  for (let i = eventos.length - 1; i >= 0; i--) {
    const e = eventos[i]!;
    if (e.type === "user") break;
    if (e.type !== "tool") continue;
    if (e.name === "Agent" || e.name === "Task") subagente = true;
    else if (e.name === "Read" || e.name === "Grep" || e.name === "Glob" || e.name === "Bash") leituras += 1;
  }
  return { leiturasSemSubagente: subagente ? 0 : leituras };
}

/** id → índice da mensagem em que disparou por último, por conversa (vive só nesta execução). */
const disparosPorConversa = new Map<string, Map<string, number>>();

export function esquecerDisparosForTest(): void {
  disparosPorConversa.clear();
}

/**
 * Confere os gatilhos pra esta mensagem, registra os disparos no contador e devolve o prefixo
 * (`""` quando nada bate). `eventos` é o histórico ANTES de esta mensagem ser gravada... ou depois:
 * só a contagem de mensagens e o turno anterior importam.
 */
export function lembreteDoCerebro(
  threadId: string,
  texto: string,
  eventos: ThreadEvent[],
  home: string,
  opts: { quadroTarefas?: boolean; arquivos?: string[] } = {},
): string {
  const meta = eventos.find((e) => e.type === "thread_meta");
  if (!meta || meta.type !== "thread_meta") return "";
  const tipo = tipoDaConversa(meta);
  if (tipo === "oculta") return "";
  const ctx: ContextoDoBloco = { tipo, ...(meta.planejamento ? { planejamento: true } : {}), ...(opts.quadroTarefas === false ? { quadroTarefas: false } : {}) };
  let disparos: Disparo[];
  try {
    const indice = eventos.filter((e) => e.type === "user").length;
    let ultimo = disparosPorConversa.get(threadId);
    if (!ultimo) disparosPorConversa.set(threadId, (ultimo = new Map()));
    const sinais = { ...sinaisDoHistorico(eventos), ...(opts.arquivos?.length ? { arquivos: opts.arquivos } : {}) };
    disparos = casarGatilhos(texto, catalogoDoCerebro(meta.projectPath, home), ctx, { indice, ultimoDisparo: ultimo, sinais });
    for (const d of disparos) {
      ultimo.set(d.id, indice);
      const sep = d.id.indexOf(":");
      registrarDisparo(threadId, { tipo: d.id.slice(0, sep) as never, nome: d.id.slice(sep + 1) }, home);
    }
  } catch (e) {
    log.avisoUmaVez("cerebro-gatilhos", "cerebro", "gatilhos do Cérebro falharam nesta mensagem", { erro: (e as Error).message });
    return "";
  }
  if (!disparos.length) return "";
  log.info("cerebro", "gatilho disparou", { threadId, capacidades: disparos.map((d) => d.id) });
  return `${textoDoLembrete(disparos)}\n\n`;
}
