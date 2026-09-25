import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectKey } from "./home.ts";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";

/**
 * Tela de Planejamento: um plano por pasta, com roteiro (etapas em ordem) e cards (requisito,
 * decisão, sugestão, ambiguidade, nota) que a pessoa e o Agent Manager editam juntos.
 * Plano: docs/superpowers/plans/2026-09-24-planejamento.md. Base: o "Agent Manager" do
 * agent-code (src/main/planning/), adaptado ao daemon.
 *
 * Storage: `projectDir/planejamento/<slug>/` — `roteiro.md`, `canvas.json`, `cards/<id>.md` e
 * `handoff/AAAA-MM-DD-NN.md`. Os `.md` seguem o esquema de `tarefas.ts`: bloco ```json``` (fonte
 * da verdade) + markdown legível embaixo, nunca reinterpretado.
 *
 * Concorrência: toda escrita leva o `rev` que a pessoa (ou o modelo) leu; se o arquivo mudou
 * nesse meio-tempo, recusa com 409 e devolve a versão atual pra refazer em cima dela. As funções
 * são síncronas, então dentro do daemon duas escritas no mesmo arquivo nunca se intercalam.
 *
 * Toda escrita emite em `planejamentoBus` (canal por projeto): é o que alimenta o SSE da tela.
 */

/** `tela`: spec completa de uma tela; a implementação gera o mock no DS e anexa ao card. */
export const TIPOS_CARD = ["etapa", "requisito", "decisao", "sugestao", "ambiguidade", "tela", "nota"] as const;
export type TipoCard = (typeof TIPOS_CARD)[number];
export const STATUS_ETAPA = ["pendente", "em_andamento", "concluida"] as const;
export type StatusEtapa = (typeof STATUS_ETAPA)[number];
export const STATUS_AMBIGUIDADE = ["aberta", "resolvida"] as const;
export type StatusAmbiguidade = (typeof STATUS_AMBIGUIDADE)[number];

/**
 * Andamento da IMPLEMENTAÇÃO da etapa, separado do `status` (que é de especificação: planejando →
 * especificada). Quem marca é a conversa de implementação; ausente = ainda não começou.
 */
export const ESTADOS_IMPLEMENTACAO = ["pendente", "em_andamento", "feita"] as const;
export type EstadoImplementacao = (typeof ESTADOS_IMPLEMENTACAO)[number];

/** `tarefaId`: tarefa do Quadro criada pra esta etapa no envio (ver planejamento-integracao.ts). */
export type Etapa = {
  id: string;
  titulo: string;
  status: StatusEtapa;
  tarefaId?: string;
  implementacao?: Exclude<EstadoImplementacao, "pendente">;
};
/**
 * O que um card aponta fora do plano: uma tela do Design System (sistema + id do card do DS) ou
 * uma tarefa do Quadro. Só o endereço mora aqui; título/estado são resolvidos na leitura, então
 * alvo que sumiu aparece riscado em vez de quebrar o plano.
 */
/** `referencia`: tela do DS só como modelo de layout — não é o mock desta tela, não pede aprovação. */
export type Anexo = { tipo: "ds"; sistema: string; card: string; referencia?: true } | { tipo: "tarefa"; id: string };
export type Design = { veredito: "aprovado" | "reprovado"; motivo?: string; mock: string; hash?: string; em: string };
export type Roteiro = {
  titulo: string;
  rev: number;
  etapas: Etapa[];
  /** Conversa do Agent Manager deste plano — reabrir o plano volta pra ela. */
  threadId?: string;
  /** Última conversa de implementação aberta pelo envio: é quem recebe o veredito do design. */
  implementacaoThreadId?: string;
  criadoEm: string;
};
export type Card = {
  id: string;
  tipo: TipoCard;
  titulo: string;
  etapa?: string;
  status?: StatusAmbiguidade;
  links: string[];
  anexos: Anexo[];
  /** Já implementado (a conversa de implementação marca requisito por requisito). */
  feito?: boolean;
  /**
   * Card de tela: o veredito da pessoa sobre o mock. `mock` é a chave do anexo avaliado e `hash`
   * o conteúdo dele naquele momento — mock trocado ou editado volta a aguardar avaliação.
   */
  design?: Design;
  fonte?: string;
  rev: number;
  corpo: string;
  /** Quando o card nasceu: é a ordem dele na coluna (card novo entra no fim, os outros não pulam). */
  criadoEm?: string;
};
export type Layout = {
  posicoes: Record<string, { x: number; y: number }>;
  vista?: { x: number; y: number; escala: number };
};
export type CardInvalido = { arquivo: string; erro: string };
export type Plano = {
  slug: string;
  dir: string;
  roteiro: Roteiro;
  cards: Card[];
  layout: Layout;
  invalidos: CardInvalido[];
};
export type ResumoPlano = { slug: string; titulo: string; etapas: number; concluidas: number; atualizadoEm: string };
export type Handoff = { nome: string; criadoEm: string; texto: string };
export type Origem = "tela" | "agente";
export type EventoPlano = { type: "mudou"; slug: string; origem: Origem; alvo: "roteiro" | "card" | "layout" | "handoff" | "plano"; id?: string };

export const TITULO_SEM_NOME = "Sem nome";
const ID_RE = /^[a-z0-9-]{1,64}$/;
const TITULO_MAX = 140;
const TITULO_PLANO_MAX = 120;
const CORPO_MAX = 20_000;
const ETAPAS_MAX = 40;
const CARDS_MAX = 500;
const LINKS_MAX = 50;
const ANEXOS_MAX = 20;
/** Ids de fora (DS, Quadro): mais largos que os do plano (`tk-…`, maiúsculas no DS antigo). */
const ID_EXTERNO_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HANDOFF_MAX = 200_000;

/* ---------------------------------------------------------------------------
 * Erros
 * ------------------------------------------------------------------------- */

type ErroHttp = Error & { status: number; atual?: unknown };

function erro(message: string, status = 400, atual?: unknown): ErroHttp {
  const e = new Error(message) as ErroHttp;
  e.status = status;
  if (atual !== undefined) e.atual = atual;
  return e;
}

/* ---------------------------------------------------------------------------
 * Eventos
 * ------------------------------------------------------------------------- */

export const planejamentoBus = new EventEmitter();
planejamentoBus.setMaxListeners(0);

export function canalPlanejamento(projectPath: string): string {
  return `plano:${projectKey(projectPath)}`;
}

function emitir(projectPath: string, ev: EventoPlano): void {
  planejamentoBus.emit(canalPlanejamento(projectPath), ev);
}

/* ---------------------------------------------------------------------------
 * Regras puras
 * ------------------------------------------------------------------------- */

export function validarId(id: unknown, oque = "id"): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw erro(`${oque} inválido: use a-z, 0-9 e '-' (até 64)`);
  return id;
}

/**
 * Fonte de uma sugestão: URL http/https, ou arquivo do projeto como caminho relativo com
 * `:linha` opcional (`src/a.ts:12`) — sem `..`, sem raiz absoluta. Mesma regra de
 * `planningFonte.ts` do agent-code.
 */
export function fonteValida(fonte: unknown): boolean {
  if (typeof fonte !== "string") return false;
  const f = fonte.trim();
  if (!f || f.length > 500) return false;
  if (/^https?:\/\//i.test(f)) {
    try {
      const u = new URL(f);
      return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
    } catch {
      return false;
    }
  }
  if (/^[a-z]+:/i.test(f) && !/^[a-z]:[\\/]/i.test(f)) return false; // outro esquema (javascript:, file:…)
  if (/^([a-z]:)?[\\/]/i.test(f)) return false; // absoluto
  const caminho = f.replace(/:\d+(-\d+)?$/, "");
  if (!caminho || caminho.split(/[\\/]/).some((p) => p === "..")) return false;
  return /^[^<>"|?*\s][^<>"|?*]*$/.test(caminho);
}

/** Título normalizado pra casar `[[Nome]]` com o card: sem caixa, sem acento, espaço colapsado. */
export function normalizarTitulo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Conteúdo de cada `[[...]]` do corpo, na ordem, sem repetição. */
export function extrairRefs(corpo: string): string[] {
  const out: string[] = [];
  for (const m of String(corpo || "").matchAll(/\[\[([^\[\]\n]{1,140})\]\]/g)) {
    const r = m[1]!.trim();
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * Resolve uma referência pro id do card: primeiro por id exato, depois pelo título normalizado.
 * Ambígua (dois títulos iguais) ou sem par = null — melhor sem seta que seta errada.
 */
export function resolverRef(ref: string, cards: Pick<Card, "id" | "titulo">[]): string | null {
  if (cards.some((c) => c.id === ref)) return ref;
  const alvo = normalizarTitulo(ref);
  const achados = cards.filter((c) => normalizarTitulo(c.titulo) === alvo);
  return achados.length === 1 ? achados[0]!.id : null;
}

/** Id de card a partir do título: slug ascii, único entre os existentes. */
export function idDeCard(titulo: string, existentes: Iterable<string>): string {
  const usados = new Set(existentes);
  const base =
    normalizarTitulo(titulo)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "card";
  if (!usados.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}-${i}`;
    if (!usados.has(id)) return id;
  }
}

/** Slug de plano novo: `plano-AAAAMMDD-HHMM`, com sufixo se já existir. */
export function slugNovo(agora: Date, existentes: Iterable<string>): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const base = `plano-${agora.getFullYear()}${p(agora.getMonth() + 1)}${p(agora.getDate())}-${p(agora.getHours())}${p(agora.getMinutes())}`;
  const usados = new Set(existentes);
  if (!usados.has(base)) return base;
  for (let i = 2; ; i++) if (!usados.has(`${base}-${i}`)) return `${base}-${i}`;
}

function texto(v: unknown, oque: string, max: number, obrigatorio = true): string {
  if (v === undefined || v === null) {
    if (obrigatorio) throw erro(`${oque} obrigatório`);
    return "";
  }
  if (typeof v !== "string") throw erro(`${oque} precisa ser texto`);
  const t = v.trim();
  if (obrigatorio && !t) throw erro(`${oque} obrigatório`);
  if (t.length > max) throw erro(`${oque} passa de ${max} caracteres`);
  return t;
}

/** Valida as etapas de um roteiro (ids únicos, status conhecido). */
export function validarEtapas(v: unknown): Etapa[] {
  if (!Array.isArray(v)) throw erro("etapas precisa ser lista");
  if (v.length > ETAPAS_MAX) throw erro(`no máximo ${ETAPAS_MAX} etapas`);
  const vistos = new Set<string>();
  return v.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const id = validarId(o.id, `id da etapa ${i + 1}`);
    if (vistos.has(id)) throw erro(`etapa repetida: ${id}`);
    vistos.add(id);
    const status = (o.status ?? "pendente") as StatusEtapa;
    if (!STATUS_ETAPA.includes(status)) throw erro(`status inválido na etapa ${id}: ${String(o.status)}`);
    const etapa: Etapa = { id, titulo: texto(o.titulo, `título da etapa ${id}`, TITULO_MAX), status };
    if (typeof o.tarefaId === "string" && ID_EXTERNO_RE.test(o.tarefaId)) etapa.tarefaId = o.tarefaId;
    if (o.implementacao === "em_andamento" || o.implementacao === "feita") etapa.implementacao = o.implementacao;
    return etapa;
  });
}

/** Chave estável de um anexo (dedup e mapa de resolvidos na tela). */
export function chaveDoAnexo(a: Anexo): string {
  return a.tipo === "ds" ? `ds:${a.sistema}/${a.card}` : `tarefa:${a.id}`;
}

export function validarAnexos(v: unknown): Anexo[] {
  if (!Array.isArray(v)) throw erro("anexos precisa ser lista");
  const out: Anexo[] = [];
  const vistos = new Set<string>();
  for (const bruto of v) {
    const o = (bruto ?? {}) as Record<string, unknown>;
    const idOk = (x: unknown, oque: string): string => {
      if (typeof x !== "string" || !ID_EXTERNO_RE.test(x)) throw erro(`${oque} inválido no anexo`);
      return x;
    };
    let a: Anexo;
    if (o.tipo === "ds") {
      a = { tipo: "ds", sistema: idOk(o.sistema, "sistema"), card: idOk(o.card, "card do DS") };
      if (o.referencia === true) a.referencia = true;
    }
    else if (o.tipo === "tarefa") a = { tipo: "tarefa", id: idOk(o.id, "id da tarefa") };
    else throw erro(`tipo de anexo inválido: ${String(o.tipo)} (use ds ou tarefa)`);
    const k = chaveDoAnexo(a);
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(a);
  }
  if (out.length > ANEXOS_MAX) throw erro(`no máximo ${ANEXOS_MAX} anexos por card`);
  return out;
}

/** Veredito gravado (vem do disco ou da rota de avaliação); forma errada = sem veredito. */
function validarDesign(v: unknown): Design | undefined {
  const o = v as Partial<Design> | null | undefined;
  if (!o || (o.veredito !== "aprovado" && o.veredito !== "reprovado")) return undefined;
  if (typeof o.mock !== "string" || typeof o.em !== "string") return undefined;
  return {
    veredito: o.veredito,
    mock: o.mock,
    em: o.em,
    ...(typeof o.motivo === "string" && o.motivo.trim() ? { motivo: o.motivo.trim().slice(0, 4000) } : {}),
    ...(typeof o.hash === "string" ? { hash: o.hash } : {}),
  };
}

export type CardInput = {
  id?: unknown;
  tipo?: unknown;
  titulo?: unknown;
  etapa?: unknown;
  status?: unknown;
  links?: unknown;
  anexos?: unknown;
  feito?: unknown;
  design?: unknown;
  fonte?: unknown;
  corpo?: unknown;
  criadoEm?: unknown;
};

/**
 * Card validado contra o plano: etapa precisa estar no roteiro, links precisam apontar pra cards
 * que existem (e não pro próprio), sugestão exige fonte, ambiguidade exige status.
 */
export function validarCard(
  input: CardInput,
  ctx: { etapas: Etapa[]; idsDeCards: Set<string>; etapaLivre?: boolean },
  rev: number,
): Card {
  const id = validarId(input.id, "id do card");
  const tipo = input.tipo as TipoCard;
  if (!TIPOS_CARD.includes(tipo)) throw erro(`tipo inválido: ${String(input.tipo)} (use ${TIPOS_CARD.join(", ")})`);
  const titulo = texto(input.titulo, "título", TITULO_MAX);
  const corpo = typeof input.corpo === "string" ? input.corpo.replace(/\r\n/g, "\n") : "";
  if (corpo.length > CORPO_MAX) throw erro(`corpo passa de ${CORPO_MAX} caracteres`);

  const card: Card = { id, tipo, titulo, links: [], anexos: [], rev, corpo };
  if (input.anexos !== undefined && input.anexos !== null) card.anexos = validarAnexos(input.anexos);
  if (input.feito === true) card.feito = true;
  const design = validarDesign(input.design);
  if (design && tipo === "tela") card.design = design;
  if (typeof input.criadoEm === "string" && !Number.isNaN(Date.parse(input.criadoEm))) card.criadoEm = input.criadoEm;

  if (input.etapa !== undefined && input.etapa !== null && input.etapa !== "") {
    const etapa = validarId(input.etapa, "etapa");
    if (!ctx.etapaLivre && !ctx.etapas.some((e) => e.id === etapa)) throw erro(`etapa ${etapa} não está no roteiro`);
    card.etapa = etapa;
  }

  if (tipo === "ambiguidade") {
    const status = (input.status ?? "aberta") as StatusAmbiguidade;
    if (!STATUS_AMBIGUIDADE.includes(status)) throw erro(`status de ambiguidade inválido: ${String(input.status)}`);
    card.status = status;
  }

  const fonte = typeof input.fonte === "string" ? input.fonte.trim() : "";
  if (fonte) {
    if (!fonteValida(fonte)) throw erro("fonte inválida: use URL http/https ou arquivo do projeto (ex.: src/a.ts:12)");
    card.fonte = fonte;
  } else if (tipo === "sugestao") {
    throw erro("sugestão precisa de fonte (URL ou arquivo do projeto) — sem fonte, registre como decisão ou nota");
  }

  if (input.links !== undefined) {
    if (!Array.isArray(input.links)) throw erro("links precisa ser lista");
    const links: string[] = [];
    for (const l of input.links) {
      const alvo = validarId(l, "link");
      if (alvo === id) throw erro("card não pode ligar em si mesmo");
      if (!ctx.idsDeCards.has(alvo)) throw erro(`link para card que não existe: ${alvo}`);
      if (!links.includes(alvo)) links.push(alvo);
    }
    if (links.length > LINKS_MAX) throw erro(`no máximo ${LINKS_MAX} links por card`);
    card.links = links;
  }
  return card;
}

/* ---------------------------------------------------------------------------
 * Disco
 * ------------------------------------------------------------------------- */

const ABRE_BLOCO = "```json\n";
const FECHA_BLOCO = "\n```\n";

function escreverMd(dados: unknown, corpo: string): string {
  return `${ABRE_BLOCO}${JSON.stringify(dados, null, 2)}${FECHA_BLOCO}\n${corpo}`;
}

function lerBloco<T>(conteudo: string): T | null {
  const m = /^```json\r?\n([\s\S]*?)\r?\n```/.exec(conteudo);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return null;
  }
}

/** Temporário + rename: quem lê nunca vê arquivo pela metade (mesmo de design-system.ts). */
function escreverAtomico(caminho: string, conteudo: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = `${caminho}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, conteudo, "utf8");
  renameSync(tmp, caminho);
}

function raiz(projectPath: string, home: string, criar: boolean): string {
  return join(criar ? projectDir(projectPath, home) : projectDirSemCriar(projectPath, home), "planejamento");
}

export function pastaDoPlano(projectPath: string, home: string, slug: string, criar = false): string {
  return join(raiz(projectPath, home, criar), validarId(slug, "slug"));
}

const roteiroPath = (dir: string) => join(dir, "roteiro.md");
const layoutPath = (dir: string) => join(dir, "canvas.json");
const cardsDir = (dir: string) => join(dir, "cards");
const cardPath = (dir: string, id: string) => join(cardsDir(dir), `${id}.md`);
const handoffDir = (dir: string) => join(dir, "handoff");

function corpoDoRoteiro(r: Roteiro): string {
  const marca: Record<StatusEtapa, string> = { pendente: " ", em_andamento: "~", concluida: "x" };
  const impl = (e: Etapa) => (e.implementacao === "feita" ? " — implementada" : e.implementacao === "em_andamento" ? " — implementando" : "");
  const linhas = [`# ${r.titulo}`, "", "## Roteiro"];
  linhas.push(...(r.etapas.length ? r.etapas.map((e, i) => `${i + 1}. [${marca[e.status]}] ${e.titulo}${impl(e)}`) : ["- nenhuma etapa ainda"]));
  return `${linhas.join("\n")}\n`;
}

function corpoDoCard(c: Card, etapas: Etapa[]): string {
  const linhas = [`# ${c.titulo}`, "", `- Tipo: ${c.tipo}`];
  if (c.etapa) linhas.push(`- Etapa: ${etapas.find((e) => e.id === c.etapa)?.titulo ?? c.etapa}`);
  if (c.status) linhas.push(`- Situação: ${c.status}`);
  if (c.feito) linhas.push("- Implementado: sim");
  if (c.design) linhas.push(`- Design: ${c.design.veredito}${c.design.motivo ? ` — ${c.design.motivo}` : ""}`);
  if (c.fonte) linhas.push(`- Fonte: ${c.fonte}`);
  if (c.links.length) linhas.push(`- Ligado a: ${c.links.join(", ")}`);
  for (const a of c.anexos) {
    linhas.push(a.tipo === "ds" ? `- Tela do Design System${a.referencia ? " (referência de layout)" : ""}: ${a.sistema}/${a.card}` : `- Tarefa do Quadro: ${a.id}`);
  }
  linhas.push("");
  if (c.corpo) linhas.push(c.corpo, "");
  return `${linhas.join("\n")}\n`;
}

function lerRoteiro(dir: string): Roteiro | null {
  if (!existsSync(roteiroPath(dir))) return null;
  const d = lerBloco<Partial<Roteiro>>(readFileSync(roteiroPath(dir), "utf8"));
  if (!d) return null;
  let etapas: Etapa[] = [];
  try {
    etapas = validarEtapas(d.etapas ?? []);
  } catch {
    etapas = [];
  }
  return {
    titulo: typeof d.titulo === "string" && d.titulo.trim() ? d.titulo : TITULO_SEM_NOME,
    rev: typeof d.rev === "number" ? d.rev : 0,
    etapas,
    ...(typeof d.threadId === "string" && d.threadId ? { threadId: d.threadId } : {}),
    ...(typeof d.implementacaoThreadId === "string" && d.implementacaoThreadId ? { implementacaoThreadId: d.implementacaoThreadId } : {}),
    criadoEm: typeof d.criadoEm === "string" ? d.criadoEm : new Date(0).toISOString(),
  };
}

function escreverRoteiro(dir: string, r: Roteiro): void {
  escreverAtomico(roteiroPath(dir), escreverMd(r, corpoDoRoteiro(r)));
}

function roteiroOuErro(dir: string, slug: string): Roteiro {
  const r = lerRoteiro(dir);
  if (!r) throw erro(`plano não encontrado: ${slug}`, 404);
  return r;
}

/** Cards válidos + os arquivos que não deu pra ler (não derrubam o plano). */
function lerCards(dir: string, etapas: Etapa[]): { cards: Card[]; invalidos: CardInvalido[] } {
  const pasta = cardsDir(dir);
  const cards: Card[] = [];
  const invalidos: CardInvalido[] = [];
  if (!existsSync(pasta)) return { cards, invalidos };
  const brutos: { arquivo: string; dados: CardInput & { rev?: unknown } }[] = [];
  for (const arquivo of readdirSync(pasta).sort()) {
    if (!arquivo.endsWith(".md")) continue;
    const dados = lerBloco<CardInput & { rev?: unknown }>(readFileSync(join(pasta, arquivo), "utf8"));
    if (!dados) invalidos.push({ arquivo, erro: "sem bloco json legível" });
    else if (dados.id !== arquivo.slice(0, -3)) invalidos.push({ arquivo, erro: "id não bate com o nome do arquivo" });
    else {
      // card antigo (antes do criadoEm) usa a data do arquivo: a ordem fica estável do mesmo jeito
      if (typeof dados.criadoEm !== "string") dados.criadoEm = statSync(join(pasta, arquivo)).birthtime.toISOString();
      brutos.push({ arquivo, dados });
    }
  }
  brutos.sort((a, b) => String(a.dados.criadoEm).localeCompare(String(b.dados.criadoEm)) || a.arquivo.localeCompare(b.arquivo));
  const ids = new Set(brutos.map((b) => String(b.dados.id)));
  // Etapa que saiu do roteiro não invalida o card (ele vai pra "Sem etapa" na tela), e link pra
  // card que sumiu do disco também não (só some a seta).
  const ctx = { etapas, idsDeCards: ids, etapaLivre: true };
  for (const { arquivo, dados } of brutos) {
    try {
      const links = Array.isArray(dados.links) ? dados.links.filter((l) => typeof l === "string" && ids.has(l)) : [];
      cards.push(validarCard({ ...dados, links }, ctx, typeof dados.rev === "number" ? dados.rev : 0));
    } catch (e) {
      invalidos.push({ arquivo, erro: (e as Error).message });
    }
  }
  return { cards, invalidos };
}

function escreverCard(dir: string, c: Card, etapas: Etapa[]): void {
  escreverAtomico(cardPath(dir, c.id), escreverMd(c, corpoDoCard(c, etapas)));
}

function lerLayout(dir: string): Layout {
  try {
    const d = JSON.parse(readFileSync(layoutPath(dir), "utf8")) as Partial<Layout>;
    return validarLayout(d);
  } catch {
    return { posicoes: {} };
  }
}

function numero(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function validarLayout(v: unknown): Layout {
  const o = (v ?? {}) as Record<string, unknown>;
  const posicoes: Layout["posicoes"] = {};
  const entrada = o.posicoes && typeof o.posicoes === "object" ? (o.posicoes as Record<string, unknown>) : {};
  for (const [id, p] of Object.entries(entrada)) {
    const q = (p ?? {}) as Record<string, unknown>;
    if (ID_RE.test(id) && numero(q.x) && numero(q.y)) posicoes[id] = { x: q.x, y: q.y };
  }
  const layout: Layout = { posicoes };
  const vi = o.vista as Record<string, unknown> | undefined;
  if (vi && numero(vi.x) && numero(vi.y) && numero(vi.escala) && vi.escala > 0) layout.vista = { x: vi.x, y: vi.y, escala: vi.escala };
  return layout;
}

/* ---------------------------------------------------------------------------
 * API do store
 * ------------------------------------------------------------------------- */

export function listarPlanos(projectPath: string, home: string): ResumoPlano[] {
  const r = raiz(projectPath, home, false);
  if (!existsSync(r)) return [];
  const out: ResumoPlano[] = [];
  for (const slug of readdirSync(r)) {
    if (!ID_RE.test(slug)) continue;
    const dir = join(r, slug);
    const roteiro = lerRoteiro(dir);
    if (!roteiro) continue;
    out.push({
      slug,
      titulo: roteiro.titulo,
      etapas: roteiro.etapas.length,
      concluidas: roteiro.etapas.filter((e) => e.status === "concluida").length,
      atualizadoEm: statSync(roteiroPath(dir)).mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
}

export function criarPlano(projectPath: string, home: string, opts: { titulo?: unknown; agora?: Date } = {}): Plano {
  const r = raiz(projectPath, home, true);
  const existentes = existsSync(r) ? readdirSync(r) : [];
  const slug = slugNovo(opts.agora ?? new Date(), existentes);
  const titulo = texto(opts.titulo, "título", TITULO_PLANO_MAX, false) || TITULO_SEM_NOME;
  const dir = join(r, slug);
  escreverRoteiro(dir, { titulo, rev: 1, etapas: [], criadoEm: (opts.agora ?? new Date()).toISOString() });
  mkdirSync(cardsDir(dir), { recursive: true });
  emitir(projectPath, { type: "mudou", slug, origem: "tela", alvo: "plano" });
  return abrirPlano(projectPath, home, slug);
}

export function abrirPlano(projectPath: string, home: string, slug: string): Plano {
  const dir = pastaDoPlano(projectPath, home, slug);
  const roteiro = roteiroOuErro(dir, slug);
  const { cards, invalidos } = lerCards(dir, roteiro.etapas);
  return { slug, dir, roteiro, cards, layout: lerLayout(dir), invalidos };
}

/**
 * O vínculo etapa → tarefa do Quadro e o andamento da implementação não são editados pelo
 * roteiro (a tela e as ferramentas mandam só id/título/status): etapa que continua no roteiro
 * mantém os dois.
 */
function manterTarefas(novas: Etapa[], atuais: Etapa[]): Etapa[] {
  return novas.map((e) => {
    const antes = atuais.find((a) => a.id === e.id);
    if (!antes) return e;
    return {
      ...e,
      ...(!e.tarefaId && antes.tarefaId ? { tarefaId: antes.tarefaId } : {}),
      ...(!e.implementacao && antes.implementacao ? { implementacao: antes.implementacao } : {}),
    };
  });
}

/** Marca o andamento da implementação de UMA etapa (`pendente` apaga a marca). */
export function marcarImplementacao(
  projectPath: string,
  home: string,
  slug: string,
  input: { etapa: unknown; estado: unknown; expectedRev: unknown },
  origem: Origem = "tela",
): Roteiro {
  const dir = pastaDoPlano(projectPath, home, slug);
  const atual = roteiroOuErro(dir, slug);
  if (input.expectedRev !== atual.rev) throw erro("o roteiro mudou desde a leitura", 409, atual);
  const estado = input.estado as EstadoImplementacao;
  if (!ESTADOS_IMPLEMENTACAO.includes(estado)) throw erro(`estado inválido: ${String(input.estado)} (use ${ESTADOS_IMPLEMENTACAO.join(", ")})`);
  if (!atual.etapas.some((e) => e.id === input.etapa)) throw erro(`etapa ${String(input.etapa)} não está no roteiro`);
  const novo: Roteiro = {
    ...atual,
    etapas: atual.etapas.map((e) => {
      if (e.id !== input.etapa) return e;
      const { implementacao: _, ...resto } = e;
      return estado === "pendente" ? resto : { ...resto, implementacao: estado };
    }),
    rev: atual.rev + 1,
  };
  escreverRoteiro(dir, novo);
  emitir(projectPath, { type: "mudou", slug, origem, alvo: "roteiro" });
  return novo;
}

/** Grava o vínculo etapa → tarefa do Quadro (só o envio pro Quadro chama). */
export function vincularTarefas(projectPath: string, home: string, slug: string, porEtapa: Record<string, string>): Roteiro {
  const dir = pastaDoPlano(projectPath, home, slug);
  const atual = roteiroOuErro(dir, slug);
  const novo: Roteiro = {
    ...atual,
    etapas: atual.etapas.map((e) => (porEtapa[e.id] ? { ...e, tarefaId: porEtapa[e.id] } : e)),
    rev: atual.rev + 1,
  };
  escreverRoteiro(dir, novo);
  emitir(projectPath, { type: "mudou", slug, origem: "tela", alvo: "roteiro" });
  return novo;
}

/**
 * Troca as etapas do roteiro (e, se vier, o título). `expectedRev` é o rev que quem chama leu.
 * Etapa removida não apaga cards: eles vão pra "Sem etapa" na tela.
 */
export function salvarRoteiro(
  projectPath: string,
  home: string,
  slug: string,
  input: { etapas?: unknown; titulo?: unknown; expectedRev: unknown },
  origem: Origem = "tela",
): Roteiro {
  const dir = pastaDoPlano(projectPath, home, slug);
  const atual = roteiroOuErro(dir, slug);
  if (input.expectedRev !== atual.rev) throw erro("o roteiro mudou desde a leitura", 409, atual);
  const novo: Roteiro = {
    ...atual,
    titulo: input.titulo === undefined ? atual.titulo : texto(input.titulo, "título", TITULO_PLANO_MAX, false) || TITULO_SEM_NOME,
    etapas: input.etapas === undefined ? atual.etapas : manterTarefas(validarEtapas(input.etapas), atual.etapas),
    rev: atual.rev + 1,
  };
  escreverRoteiro(dir, novo);
  emitir(projectPath, { type: "mudou", slug, origem, alvo: "roteiro" });
  return novo;
}

/** Muda o status de UMA etapa (o clique no roteiro, `plan_etapa_marcar`). */
export function marcarEtapa(
  projectPath: string,
  home: string,
  slug: string,
  input: { etapa: unknown; status: unknown; expectedRev: unknown },
  origem: Origem = "tela",
): Roteiro {
  const dir = pastaDoPlano(projectPath, home, slug);
  const atual = roteiroOuErro(dir, slug);
  const status = input.status as StatusEtapa;
  if (!STATUS_ETAPA.includes(status)) throw erro(`status inválido: ${String(input.status)}`);
  if (!atual.etapas.some((e) => e.id === input.etapa)) throw erro(`etapa ${String(input.etapa)} não está no roteiro`);
  const etapas = atual.etapas.map((e) => (e.id === input.etapa ? { ...e, status } : e));
  return salvarRoteiro(projectPath, home, slug, { etapas, expectedRev: input.expectedRev }, origem);
}

/** Liga a conversa de implementação ao plano (sem mexer no rev: não é conteúdo). */
export function vincularImplementacao(projectPath: string, home: string, slug: string, threadId: string): void {
  const dir = pastaDoPlano(projectPath, home, slug);
  const atual = roteiroOuErro(dir, slug);
  escreverRoteiro(dir, { ...atual, implementacaoThreadId: threadId });
}

/** Liga a conversa do Agent Manager ao plano (sem mexer no rev: não é conteúdo). */
export function vincularThread(projectPath: string, home: string, slug: string, threadId: string): void {
  const dir = pastaDoPlano(projectPath, home, slug);
  const atual = roteiroOuErro(dir, slug);
  escreverRoteiro(dir, { ...atual, threadId });
}

/**
 * Cria (expectedRev 0, id livre) ou atualiza (expectedRev = rev lido) um card. Sem `id`, gera um
 * a partir do título. Devolve o card gravado, com o rev novo.
 */
export function salvarCard(
  projectPath: string,
  home: string,
  slug: string,
  input: CardInput & { expectedRev: unknown },
  origem: Origem = "tela",
): Card {
  const dir = pastaDoPlano(projectPath, home, slug);
  const roteiro = roteiroOuErro(dir, slug);
  const { cards } = lerCards(dir, roteiro.etapas);
  const ids = new Set(cards.map((c) => c.id));
  const id = input.id === undefined || input.id === "" ? idDeCard(String(input.titulo ?? ""), ids) : validarId(input.id, "id do card");
  const atual = cards.find((c) => c.id === id);
  const revAtual = atual?.rev ?? (existsSync(cardPath(dir, id)) ? -1 : 0);
  if (input.expectedRev !== revAtual) {
    throw erro(atual ? "o card mudou desde a leitura" : revAtual === -1 ? "já existe um arquivo inválido com esse id" : `card ${id} não existe`, 409, atual ?? null);
  }
  if (!atual && cards.length >= CARDS_MAX) throw erro(`no máximo ${CARDS_MAX} cards por plano`);
  // etapa que saiu do roteiro não trava a edição de outro campo: o card só fica "Sem etapa"
  const base = atual?.etapa && !roteiro.etapas.some((e) => e.id === atual.etapa) ? { ...atual, etapa: undefined } : atual;
  if (atual && Array.isArray(input.anexos)) input = { ...input, anexos: herdarReferencia(input.anexos, atual.anexos) };
  const card = validarCard(
    { ...base, ...input, id, criadoEm: atual?.criadoEm ?? new Date().toISOString() },
    { etapas: roteiro.etapas, idsDeCards: ids },
    revAtual + 1,
  );
  escreverCard(dir, card, roteiro.etapas);
  emitir(projectPath, { type: "mudou", slug, origem, alvo: "card", id });
  return card;
}

/**
 * Quem reenvia a lista de anexos (a tela, a implementação "mantendo os que já estavam") nem
 * sempre manda o `referencia`: anexo de tela sem a marca herda a do mesmo anexo já gravado.
 * `referencia: false` explícito tira a marca.
 */
function herdarReferencia(novos: unknown[], atuais: Anexo[]): unknown[] {
  const refs = new Set(atuais.filter((a) => a.tipo === "ds" && a.referencia).map(chaveDoAnexo));
  return novos.map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    if (o.tipo !== "ds" || "referencia" in o) return b;
    return refs.has(`ds:${String(o.sistema)}/${String(o.card)}`) ? { ...o, referencia: true } : b;
  });
}

/** Apaga o card e tira o id dele dos links de quem apontava (esses ganham rev novo). */
export function apagarCard(
  projectPath: string,
  home: string,
  slug: string,
  input: { id: unknown; expectedRev: unknown },
  origem: Origem = "tela",
): void {
  const dir = pastaDoPlano(projectPath, home, slug);
  const roteiro = roteiroOuErro(dir, slug);
  const id = validarId(input.id, "id do card");
  const { cards } = lerCards(dir, roteiro.etapas);
  const atual = cards.find((c) => c.id === id);
  if (!atual) {
    if (existsSync(cardPath(dir, id))) {
      rmSync(cardPath(dir, id)); // arquivo inválido: apagar é o jeito de sair dele pela tela
      emitir(projectPath, { type: "mudou", slug, origem, alvo: "card", id });
      return;
    }
    throw erro(`card ${id} não existe`, 404);
  }
  if (input.expectedRev !== atual.rev) throw erro("o card mudou desde a leitura", 409, atual);
  for (const c of cards) {
    if (c.id !== id && c.links.includes(id)) escreverCard(dir, { ...c, links: c.links.filter((l) => l !== id), rev: c.rev + 1 }, roteiro.etapas);
  }
  rmSync(cardPath(dir, id));
  const layout = lerLayout(dir);
  if (layout.posicoes[id]) {
    delete layout.posicoes[id];
    escreverAtomico(layoutPath(dir), JSON.stringify(layout, null, 2));
  }
  emitir(projectPath, { type: "mudou", slug, origem, alvo: "card", id });
}

/** Posições e vista do canvas: só visual, última escrita vence (sem rev). */
export function salvarLayout(projectPath: string, home: string, slug: string, input: unknown): Layout {
  const dir = pastaDoPlano(projectPath, home, slug);
  roteiroOuErro(dir, slug);
  const layout = validarLayout(input);
  escreverAtomico(layoutPath(dir), JSON.stringify(layout, null, 2));
  emitir(projectPath, { type: "mudou", slug, origem: "tela", alvo: "layout" });
  return layout;
}

export function listarHandoffs(projectPath: string, home: string, slug: string): Handoff[] {
  const dir = pastaDoPlano(projectPath, home, slug);
  roteiroOuErro(dir, slug);
  const pasta = handoffDir(dir);
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta)
    .filter((n) => /^\d{4}-\d{2}-\d{2}-\d{2,}\.md$/.test(n))
    .sort()
    .map((nome) => ({
      nome,
      criadoEm: statSync(join(pasta, nome)).birthtime.toISOString(),
      texto: readFileSync(join(pasta, nome), "utf8"),
    }));
}

/** Grava um prompt de handoff em arquivo NOVO (`wx`): nunca sobrescreve um enviado. */
export function escreverHandoff(
  projectPath: string,
  home: string,
  slug: string,
  conteudo: unknown,
  origem: Origem = "tela",
  agora = new Date(),
): Handoff {
  const dir = pastaDoPlano(projectPath, home, slug);
  roteiroOuErro(dir, slug);
  const t = texto(conteudo, "texto do handoff", HANDOFF_MAX);
  const pasta = handoffDir(dir);
  mkdirSync(pasta, { recursive: true });
  const p = (n: number) => String(n).padStart(2, "0");
  const dia = `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}`;
  for (let n = 1; n < 1000; n++) {
    const nome = `${dia}-${p(n)}.md`;
    try {
      writeFileSync(join(pasta, nome), `${t}\n`, { encoding: "utf8", flag: "wx" });
      emitir(projectPath, { type: "mudou", slug, origem, alvo: "handoff", id: nome });
      return { nome, criadoEm: agora.toISOString(), texto: `${t}\n` };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw erro("handoffs demais neste dia", 500);
}
