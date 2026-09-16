import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { projectKey, tarefasPath as legadoPath } from "./home.ts";
import { fireHook } from "./hooks.ts";
import { newChecklistItemId, newColunaId, newComentarioId, newEtiquetaId, newMarcoId, newTarefaId } from "./ids.ts";
import type { Conjunto, Ferramenta, Saida } from "./mcp.ts";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";
import { commitsRelacionados } from "./tarefas-git.ts";

/**
 * Quadro Kanban por projeto: colunas customizáveis, marcos (milestones), etiquetas e tarefas —
 * cada uma com checklist e comentários. Ver docs/superpowers/specs (planejamento de projeto).
 *
 * Storage: uma PASTA por projeto (não mais um `tarefas.json` global), mesmo esquema de
 * `memoria.ts`/`repo-map-indice.ts` — raiz configurável (`tarefasDir`, pra apontar numa pasta já
 * sincronizada entre máquinas) + hash sha1 de `projectKey` como nome de subpasta. Dentro dela:
 * `quadro.md` (colunas/marcos/etiquetas) e `itens/<id>.md` (uma tarefa por arquivo). Cada `.md` é
 * um bloco ```json``` (fonte da verdade, é o que este arquivo lê de volta) seguido de uma
 * renderização em markdown legível pra quem abre o arquivo direto (Obsidian, editor de texto,
 * etc.) — essa parte de baixo NUNCA é reinterpretada, é só pra leitura humana.
 *
 * Migra sozinho, uma vez, do `tarefas.json` antigo (arquivo único, todos os projetos) na primeira
 * vez que o quadro de um projeto é lido — ver `migrarLegado`.
 */

export type Coluna = { id: string; nome: string; ordem: number };
export type Marco = { id: string; nome: string; inicio?: string; prazo?: string };
export type Etiqueta = { id: string; nome: string; cor: string };
export type Quadro = { projectPath: string; colunas: Coluna[]; marcos: Marco[]; etiquetas: Etiqueta[] };

export type ChecklistItem = { id: string; texto: string; feito: boolean };
export type Comentario = { id: string; texto: string; autor?: string; criadoEm: string };
export const PRIORIDADES = ["baixa", "media", "alta", "urgente"] as const;
export type Prioridade = (typeof PRIORIDADES)[number];
export const TIPOS_TAREFA = ["bug", "feature", "chore", "spike"] as const;
export type TipoTarefa = (typeof TIPOS_TAREFA)[number];

export type Tarefa = {
  id: string;
  projectPath: string;
  titulo: string;
  descricao?: string;
  colunaId: string;
  marcoId?: string;
  etiquetaIds: string[];
  prioridade?: Prioridade;
  /** Nome livre de uma pessoa. Mutuamente exclusivo com `agentId` só por convenção da UI. */
  responsavel?: string;
  /** Um agente do projeto (id de `agents.json`) — não validado contra a lista, mesmo espírito de `threadId`. */
  agentId?: string;
  checklist: ChecklistItem[];
  comentarios: Comentario[];
  prazo?: string;
  ordem: number;
  threadId?: string;
  /** Ausente = pessoa. Só um badge visual — não muda validação nem permissão. */
  criadoPor?: "agente";
  tipo?: TipoTarefa;
  /** Tarefa-mãe, se esta for uma subtarefa. Precisa existir no MESMO projeto (ver `salvarTarefa`). */
  parentId?: string;
  /**
   * Ids de tarefas que bloqueiam esta. Informativo pra qualquer coluna, EXCETO a última do
   * quadro (maior `ordem`): mover pra lá com dependência ainda fora dela é recusado.
   */
  dependeDe?: string[];
  createdAt: string;
  updatedAt: string;
};

function badRequest(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 400;
  return err;
}

function notFound(message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = 404;
  return err;
}

const TITULO_MAX = 140;
const DESCRICAO_MAX = 2000;
const NOME_COLUNA_MAX = 40;
const NOME_MARCO_MAX = 60;
const NOME_ETIQUETA_MAX = 30;
const TEXTO_ITEM_MAX = 200;
const TEXTO_COMENTARIO_MAX = 2000;
const COLUNAS_MAX = 12;
const MARCOS_MAX = 50;
const ETIQUETAS_MAX = 30;
const CHECKLIST_MAX = 100;
const COMENTARIOS_MAX = 300;
const TAREFAS_MAX_POR_PROJETO = 1000;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const COR_RE = /^#[0-9a-fA-F]{6}$/;

/** Colunas de um quadro novo — "A fazer/Fazendo/Feito" é o ponto de partida mais comum de Kanban. */
function colunasPadrao(): Coluna[] {
  return [
    { id: newColunaId(), nome: "A fazer", ordem: 0 },
    { id: newColunaId(), nome: "Fazendo", ordem: 1 },
    { id: newColunaId(), nome: "Feito", ordem: 2 },
  ];
}

/** Raiz LEGADA de tarefas (layout por-tipo, um hash por projeto) — só usada quando `tarefasDir` está configurado. */
export function tarefasRoot(home: string): string {
  const cfg = loadConfig(home);
  return cfg.tarefasDir || join(home, "tarefas");
}

function tarefasHash(projectPath: string): string {
  return createHash("sha1").update(projectKey(projectPath)).digest("hex");
}

/** Mesma escolha de layout (novo `projectDir/tarefas` vs. legado `tarefasRoot/<hash>`), sem criar nada. */
function pastaTarefasSemCriar(projectPath: string, home: string): string {
  return loadConfig(home).tarefasDir
    ? join(tarefasRoot(home), tarefasHash(projectPath))
    : join(projectDirSemCriar(projectPath, home), "tarefas");
}

/**
 * Pasta de tarefas de UM projeto. Layout novo (`projectDir/tarefas`) por padrão; cai pro
 * layout legado (`tarefasRoot/<hash>`, com `meta.json` próprio) só quando `config.tarefasDir`
 * está explicitamente definido — ver spec docs/superpowers/specs/2026-09-12-storage-cross-device-design.md.
 * Cria a pasta se ainda não existir.
 */
function projectTarefasDir(projectPath: string, home: string): string {
  if (loadConfig(home).tarefasDir) {
    const dir = join(tarefasRoot(home), tarefasHash(projectPath));
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(metaPath, JSON.stringify({ projectPath }, null, 2), "utf8");
    }
    return dir;
  }
  const dir = join(projectDir(projectPath, home), "tarefas");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function quadroPath(projectPath: string, home: string): string {
  return join(pastaTarefasSemCriar(projectPath, home), "quadro.md");
}

function itensDir(projectPath: string, home: string): string {
  return join(pastaTarefasSemCriar(projectPath, home), "itens");
}

function itemPath(projectPath: string, home: string, id: string): string {
  return join(itensDir(projectPath, home), `${id}.md`);
}

const ABRE_BLOCO = "```json\n";
const FECHA_BLOCO = "\n```\n";

function escreverMd(dados: unknown, corpo: string): string {
  return `${ABRE_BLOCO}${JSON.stringify(dados, null, 2)}${FECHA_BLOCO}\n${corpo}`;
}

/** Lê só o bloco ```json``` do topo — o resto do arquivo é renderização, nunca reinterpretada. */
function lerBloco<T>(texto: string): T | null {
  const m = /^```json\n([\s\S]*?)\n```/.exec(texto);
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as T;
  } catch {
    return null;
  }
}

function corpoDoQuadro(q: Quadro): string {
  const linhas = ["# Quadro de tarefas", "", "## Colunas"];
  linhas.push(...(q.colunas.length ? q.colunas.map((c) => `- ${c.nome}`) : ["- nenhuma"]));
  linhas.push("", "## Marcos");
  linhas.push(
    ...(q.marcos.length
      ? q.marcos.map((m) => `- ${m.nome}${m.inicio ? ` (início ${m.inicio})` : ""}${m.prazo ? ` (prazo ${m.prazo})` : ""}`)
      : ["- nenhum"]),
  );
  linhas.push("", "## Etiquetas");
  linhas.push(...(q.etiquetas.length ? q.etiquetas.map((e) => `- ${e.nome} (${e.cor})`) : ["- nenhuma"]));
  return `${linhas.join("\n")}\n`;
}

function corpoDaTarefa(t: Tarefa, quadro: Quadro): string {
  const coluna = quadro.colunas.find((c) => c.id === t.colunaId)?.nome ?? t.colunaId;
  const linhas = [`# ${t.titulo}`, "", `- Coluna: ${coluna}`];
  if (t.tipo) linhas.push(`- Tipo: ${t.tipo}`);
  if (t.prioridade) linhas.push(`- Prioridade: ${t.prioridade}`);
  if (t.responsavel) linhas.push(`- Responsável: ${t.responsavel}`);
  if (t.agentId) linhas.push(`- Agente: ${t.agentId}`);
  if (t.prazo) linhas.push(`- Prazo: ${t.prazo}`);
  if (t.marcoId) linhas.push(`- Marco: ${quadro.marcos.find((m) => m.id === t.marcoId)?.nome ?? t.marcoId}`);
  if (t.etiquetaIds.length) {
    const nomes = t.etiquetaIds.map((id) => quadro.etiquetas.find((e) => e.id === id)?.nome ?? id);
    linhas.push(`- Etiquetas: ${nomes.join(", ")}`);
  }
  if (t.parentId) linhas.push(`- Subtarefa de: ${t.parentId}`);
  if (t.dependeDe?.length) linhas.push(`- Bloqueada por: ${t.dependeDe.join(", ")}`);
  linhas.push("");
  if (t.descricao) linhas.push(t.descricao, "");
  if (t.checklist.length) {
    linhas.push("## Checklist");
    linhas.push(...t.checklist.map((i) => `- [${i.feito ? "x" : " "}] ${i.texto}`));
    linhas.push("");
  }
  if (t.comentarios.length) {
    linhas.push("## Comentários");
    linhas.push(...t.comentarios.map((c) => `- ${c.autor ? `**${c.autor}**: ` : ""}${c.texto} _(${c.criadoEm})_`));
    linhas.push("");
  }
  return `${linhas.join("\n")}\n`;
}

type QuadroDados = Omit<Quadro, "projectPath">;

function lerQuadroDoDisco(projectPath: string, home: string): Quadro | null {
  const path = quadroPath(projectPath, home);
  if (!existsSync(path)) return null;
  try {
    const dados = lerBloco<Partial<QuadroDados>>(readFileSync(path, "utf8"));
    if (!dados) return null;
    return {
      projectPath,
      colunas: Array.isArray(dados.colunas) ? dados.colunas : [],
      marcos: Array.isArray(dados.marcos) ? dados.marcos : [],
      etiquetas: Array.isArray(dados.etiquetas) ? dados.etiquetas : [],
    };
  } catch {
    return null;
  }
}

function escreverQuadro(q: Quadro, home: string): void {
  projectTarefasDir(q.projectPath, home);
  const { projectPath: _pp, ...dados } = q;
  writeFileSync(quadroPath(q.projectPath, home), escreverMd(dados, corpoDoQuadro(q)), "utf8");
}

/**
 * Migração de uma vez só do `~/.nexo/tarefas.json` (arquivo único, todos os projetos, formato
 * anterior à pasta-por-projeto): melhor esforço, nunca lança — arquivo legado ausente ou
 * corrompido só significa que este projeto nasce com o quadro padrão, igual sempre nasceu.
 */
function migrarLegado(projectPath: string, home: string): void {
  const path = legadoPath(home);
  if (!existsSync(path) || existsSync(quadroPath(projectPath, home))) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      quadros?: Array<{ projectPath?: string; colunas?: Coluna[]; marcos?: Marco[] }>;
      tarefas?: Array<Partial<Tarefa>>;
    };
    const chave = projectKey(projectPath);
    const quadroLegado = raw.quadros?.find((q) => typeof q.projectPath === "string" && projectKey(q.projectPath) === chave);
    if (!quadroLegado) return;
    const quadro: Quadro = {
      projectPath,
      colunas: quadroLegado.colunas ?? colunasPadrao(),
      marcos: quadroLegado.marcos ?? [],
      etiquetas: [],
    };
    escreverQuadro(quadro, home);
    const tarefasLegadas = (raw.tarefas ?? []).filter(
      (t) => typeof t.projectPath === "string" && projectKey(t.projectPath) === chave,
    );
    for (const t of tarefasLegadas) {
      if (!t.id || !t.titulo || !t.colunaId) continue;
      const tarefa: Tarefa = {
        id: t.id,
        projectPath,
        titulo: t.titulo,
        ...(t.descricao ? { descricao: t.descricao } : {}),
        colunaId: t.colunaId,
        ...(t.marcoId ? { marcoId: t.marcoId } : {}),
        etiquetaIds: [],
        checklist: [],
        comentarios: [],
        ...(t.prazo ? { prazo: t.prazo } : {}),
        ordem: t.ordem ?? 0,
        ...(t.threadId ? { threadId: t.threadId } : {}),
        ...(t.criadoPor ? { criadoPor: t.criadoPor } : {}),
        createdAt: t.createdAt ?? new Date().toISOString(),
        updatedAt: t.updatedAt ?? new Date().toISOString(),
      };
      mkdirSync(itensDir(projectPath, home), { recursive: true });
      writeFileSync(itemPath(projectPath, home, tarefa.id), escreverMd(tarefa, corpoDaTarefa(tarefa, quadro)), "utf8");
    }
  } catch {
    // arquivo legado corrompido — não migra nada, o projeto nasce do zero como sempre nasceu
  }
}

/** O quadro deste projeto — nasce com colunas padrão na primeira leitura, sem passo de "criar quadro". */
export function getQuadro(projectPath: string, home: string): Quadro {
  migrarLegado(projectPath, home);
  const existente = lerQuadroDoDisco(projectPath, home);
  if (existente) return existente;
  const novo: Quadro = { projectPath, colunas: colunasPadrao(), marcos: [], etiquetas: [] };
  escreverQuadro(novo, home);
  return novo;
}

function limparNome(v: unknown, campo: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw badRequest(`${campo} obrigatório`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${campo} passa de ${max} caracteres`);
  return t;
}

/** Versão opcional de `limparNome`: string vazia (ou ausente) vira `undefined`, sem exigir conteúdo. */
function limparTextoOpcional(v: unknown, campo: string, max: number): string | undefined {
  if (typeof v !== "string") throw badRequest(`${campo} inválido`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${campo} passa de ${max} caracteres`);
  return t || undefined;
}

function limparData(v: unknown, campo: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !DATA_RE.test(v)) throw badRequest(`${campo} inválido — use AAAA-MM-DD`);
  return v;
}

function limparCor(v: unknown): string {
  if (typeof v !== "string" || !COR_RE.test(v)) throw badRequest("cor inválida — use #rrggbb");
  return v;
}

function limparPrioridade(v: unknown): Prioridade | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !(PRIORIDADES as readonly string[]).includes(v)) {
    throw badRequest(`prioridade inválida — use ${PRIORIDADES.join("|")}`);
  }
  return v as Prioridade;
}

export type ColunaInput = { id?: string; nome?: string; ordem?: number };

/** Cria (sem `id`) ou renomeia/reordena (com `id`) uma coluna — `ordem` vem da UI, arrastando o cabeçalho. */
export function salvarColuna(projectPath: string, input: ColunaInput, home: string): Coluna {
  const quadro = getQuadro(projectPath, home);
  if (input.id) {
    const atual = quadro.colunas.find((c) => c.id === input.id);
    if (!atual) throw notFound(`coluna não existe: ${input.id}`);
    const nome = input.nome === undefined ? atual.nome : limparNome(input.nome, "nome da coluna", NOME_COLUNA_MAX);
    const ordem = typeof input.ordem === "number" ? input.ordem : atual.ordem;
    const editada: Coluna = { ...atual, nome, ordem };
    escreverQuadro({ ...quadro, colunas: quadro.colunas.map((c) => (c.id === editada.id ? editada : c)) }, home);
    return editada;
  }
  if (quadro.colunas.length >= COLUNAS_MAX) throw badRequest(`limite de ${COLUNAS_MAX} colunas por projeto`);
  const nome = limparNome(input.nome, "nome da coluna", NOME_COLUNA_MAX);
  const coluna: Coluna = { id: newColunaId(), nome, ordem: quadro.colunas.length };
  escreverQuadro({ ...quadro, colunas: [...quadro.colunas, coluna] }, home);
  return coluna;
}

/** Recusa apagar coluna com tarefa dentro — sem cascata silenciosa, a pessoa move antes. */
export function apagarColuna(projectPath: string, id: string, home: string): void {
  const quadro = getQuadro(projectPath, home);
  if (!quadro.colunas.some((c) => c.id === id)) throw notFound(`coluna não existe: ${id}`);
  const emUso = listarTarefas(projectPath, home).filter((t) => t.colunaId === id).length;
  if (emUso > 0) throw badRequest(`${emUso} tarefa(s) nessa coluna — mova antes de apagar`);
  escreverQuadro({ ...quadro, colunas: quadro.colunas.filter((c) => c.id !== id) }, home);
}

export type MarcoInput = { id?: string; nome?: string; inicio?: string | null; prazo?: string | null };

/** `inicio` (quando os dois estão presentes) não pode ser depois de `prazo` — barra não pode nascer invertida. */
function checarOrdemDoMarco(inicio: string | undefined, prazo: string | undefined): void {
  if (inicio && prazo && inicio > prazo) throw badRequest("início não pode ser depois do prazo");
}

export function salvarMarco(projectPath: string, input: MarcoInput, home: string): Marco {
  const quadro = getQuadro(projectPath, home);
  if (input.id) {
    const atual = quadro.marcos.find((m) => m.id === input.id);
    if (!atual) throw notFound(`marco não existe: ${input.id}`);
    const nome = input.nome === undefined ? atual.nome : limparNome(input.nome, "nome do marco", NOME_MARCO_MAX);
    const inicio = input.inicio === undefined ? atual.inicio : (limparData(input.inicio, "início") ?? undefined);
    const prazo = input.prazo === undefined ? atual.prazo : (limparData(input.prazo, "prazo") ?? undefined);
    checarOrdemDoMarco(inicio, prazo);
    const editado: Marco = { ...atual, nome, ...(inicio ? { inicio } : {}), ...(prazo ? { prazo } : {}) };
    if (!inicio) delete editado.inicio;
    if (!prazo) delete editado.prazo;
    escreverQuadro({ ...quadro, marcos: quadro.marcos.map((m) => (m.id === editado.id ? editado : m)) }, home);
    return editado;
  }
  if (quadro.marcos.length >= MARCOS_MAX) throw badRequest(`limite de ${MARCOS_MAX} marcos por projeto`);
  const nome = limparNome(input.nome, "nome do marco", NOME_MARCO_MAX);
  const inicio = limparData(input.inicio, "início");
  const prazo = limparData(input.prazo, "prazo");
  checarOrdemDoMarco(inicio, prazo);
  const marco: Marco = { id: newMarcoId(), nome, ...(inicio ? { inicio } : {}), ...(prazo ? { prazo } : {}) };
  escreverQuadro({ ...quadro, marcos: [...quadro.marcos, marco] }, home);
  return marco;
}

export function apagarMarco(projectPath: string, id: string, home: string): void {
  const quadro = getQuadro(projectPath, home);
  if (!quadro.marcos.some((m) => m.id === id)) throw notFound(`marco não existe: ${id}`);
  const emUso = listarTarefas(projectPath, home).filter((t) => t.marcoId === id).length;
  if (emUso > 0) throw badRequest(`${emUso} tarefa(s) nesse marco — mova antes de apagar`);
  escreverQuadro({ ...quadro, marcos: quadro.marcos.filter((m) => m.id !== id) }, home);
}

export type EtiquetaInput = { id?: string; nome?: string; cor?: string };

export function salvarEtiqueta(projectPath: string, input: EtiquetaInput, home: string): Etiqueta {
  const quadro = getQuadro(projectPath, home);
  if (input.id) {
    const atual = quadro.etiquetas.find((e) => e.id === input.id);
    if (!atual) throw notFound(`etiqueta não existe: ${input.id}`);
    const nome = input.nome === undefined ? atual.nome : limparNome(input.nome, "nome da etiqueta", NOME_ETIQUETA_MAX);
    const cor = input.cor === undefined ? atual.cor : limparCor(input.cor);
    const editada: Etiqueta = { ...atual, nome, cor };
    escreverQuadro({ ...quadro, etiquetas: quadro.etiquetas.map((e) => (e.id === editada.id ? editada : e)) }, home);
    return editada;
  }
  if (quadro.etiquetas.length >= ETIQUETAS_MAX) throw badRequest(`limite de ${ETIQUETAS_MAX} etiquetas por projeto`);
  const nome = limparNome(input.nome, "nome da etiqueta", NOME_ETIQUETA_MAX);
  const cor = limparCor(input.cor);
  const etiqueta: Etiqueta = { id: newEtiquetaId(), nome, cor };
  escreverQuadro({ ...quadro, etiquetas: [...quadro.etiquetas, etiqueta] }, home);
  return etiqueta;
}

export function apagarEtiqueta(projectPath: string, id: string, home: string): void {
  const quadro = getQuadro(projectPath, home);
  if (!quadro.etiquetas.some((e) => e.id === id)) throw notFound(`etiqueta não existe: ${id}`);
  const emUso = listarTarefas(projectPath, home).filter((t) => t.etiquetaIds.includes(id)).length;
  if (emUso > 0) throw badRequest(`${emUso} tarefa(s) com essa etiqueta — remova antes de apagar`);
  escreverQuadro({ ...quadro, etiquetas: quadro.etiquetas.filter((e) => e.id !== id) }, home);
}

function lerTarefaDoDisco(projectPath: string, home: string, id: string): Tarefa | null {
  const path = itemPath(projectPath, home, id);
  if (!existsSync(path)) return null;
  try {
    const dados = lerBloco<Partial<Tarefa>>(readFileSync(path, "utf8"));
    if (!dados || typeof dados.id !== "string" || typeof dados.titulo !== "string" || typeof dados.colunaId !== "string") {
      return null;
    }
    return {
      ...dados,
      id: dados.id,
      projectPath,
      titulo: dados.titulo,
      colunaId: dados.colunaId,
      etiquetaIds: Array.isArray(dados.etiquetaIds) ? dados.etiquetaIds : [],
      checklist: Array.isArray(dados.checklist) ? dados.checklist : [],
      comentarios: Array.isArray(dados.comentarios) ? dados.comentarios : [],
      ordem: typeof dados.ordem === "number" ? dados.ordem : 0,
      createdAt: dados.createdAt ?? new Date().toISOString(),
      updatedAt: dados.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function escreverTarefa(t: Tarefa, quadro: Quadro, home: string): void {
  projectTarefasDir(t.projectPath, home);
  mkdirSync(itensDir(t.projectPath, home), { recursive: true });
  const { projectPath: _pp, ...dados } = t;
  writeFileSync(itemPath(t.projectPath, home, t.id), escreverMd(dados, corpoDaTarefa(t, quadro)), "utf8");
}

export function listarTarefas(projectPath: string, home: string): Tarefa[] {
  migrarLegado(projectPath, home);
  const dir = itensDir(projectPath, home);
  if (!existsSync(dir)) return [];
  const tarefas: Tarefa[] = [];
  for (const arquivo of readdirSync(dir)) {
    if (!arquivo.endsWith(".md")) continue;
    const t = lerTarefaDoDisco(projectPath, home, arquivo.slice(0, -3));
    if (t) tarefas.push(t);
  }
  return tarefas;
}

export function getTarefa(projectPath: string, home: string, id: string): Tarefa | undefined {
  return lerTarefaDoDisco(projectPath, home, id) ?? undefined;
}

export type TarefaInput = {
  id?: string;
  projectPath?: string;
  titulo?: string;
  descricao?: string;
  colunaId?: string;
  marcoId?: string | null;
  etiquetaIds?: string[];
  prioridade?: string | null;
  responsavel?: string | null;
  agentId?: string | null;
  prazo?: string | null;
  threadId?: string | null;
  ordem?: number;
  tipo?: string | null;
  parentId?: string | null;
  dependeDe?: string[];
};

function agora(): string {
  return new Date().toISOString();
}

function limparEtiquetaIds(v: unknown, quadro: Quadro): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw badRequest("etiquetaIds inválido");
  for (const id of v) {
    if (!quadro.etiquetas.some((e) => e.id === id)) throw badRequest(`etiqueta não existe neste projeto: ${id}`);
  }
  return [...new Set(v)];
}

function limparTipo(v: unknown): TipoTarefa | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !(TIPOS_TAREFA as readonly string[]).includes(v)) {
    throw badRequest(`tipo inválido — use ${TIPOS_TAREFA.join("|")}`);
  }
  return v as TipoTarefa;
}

/** Tarefa-mãe: precisa existir no mesmo projeto, não pode ser a própria tarefa, nem criar ciclo direto (mãe↔filha). */
function limparParentId(v: unknown, projectPath: string, home: string, idAtual?: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw badRequest("parentId inválido");
  if (v === idAtual) throw badRequest("uma tarefa não pode ser sua própria mãe");
  const mae = lerTarefaDoDisco(projectPath, home, v);
  if (!mae) throw badRequest(`tarefa não existe neste projeto: ${v}`);
  if (idAtual && mae.parentId === idAtual) throw badRequest("isso criaria um ciclo: a tarefa escolhida já é subtarefa desta");
  return v;
}

/** Coluna de maior `ordem` do quadro — convenção usada pra saber se uma tarefa está "feita". */
function colunaFinalId(quadro: Quadro): string | undefined {
  if (!quadro.colunas.length) return undefined;
  return quadro.colunas.reduce((max, c) => (c.ordem > max.ordem ? c : max), quadro.colunas[0]).id;
}

/**
 * Ids de tarefas que bloqueiam esta — cada um precisa existir no mesmo projeto; sem duplicado,
 * sem o próprio id. Depender de uma tarefa já feita é permitido (fica satisfeita na hora — é o
 * cliente/UI que evita oferecer tarefas feitas como bloqueadora NOVA, ver `preencherParentEDependencias`
 * em `tarefas-board.js`); o backend só recusa o que não existe.
 */
function limparDependeDe(v: unknown, projectPath: string, home: string, idAtual?: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw badRequest("dependeDe inválido");
  for (const id of v) {
    if (id === idAtual) throw badRequest("uma tarefa não pode depender de si mesma");
    if (!lerTarefaDoDisco(projectPath, home, id)) throw badRequest(`tarefa não existe neste projeto: ${id}`);
  }
  return [...new Set(v)];
}

/**
 * Automação de coluna (Nexo Hooks, evento `tarefa.mudou-coluna`): best-effort, nunca lança —
 * uma regra mal configurada (agente apagado, etc.) não pode impedir a MUDANÇA DE COLUNA de
 * gravar, só a automação em cima dela falha silenciosamente (loga e segue).
 */
function dispararAutomacaoDeColuna(t: Tarefa, quadro: Quadro, home: string): void {
  try {
    const coluna = quadro.colunas.find((c) => c.id === t.colunaId)?.nome ?? t.colunaId;
    const contexto = `Tarefa ${t.id} — "${t.titulo}"${t.descricao ? `: ${t.descricao}` : ""} — entrou na coluna "${coluna}".`;
    fireHook("tarefa.mudou-coluna", t.projectPath, home, { colunaId: t.colunaId, contexto });
  } catch (e) {
    console.error(`automação de coluna (tarefa ${t.id}):`, (e as Error).message || e);
  }
}

/**
 * Cria (sem `id`) ou atualiza (com `id`) — upsert campo-a-campo, mesmo idioma de `saveRegra`.
 * Sempre precisa de `projectPath` (mesmo em update): a tarefa mora num arquivo dentro da pasta
 * DAQUELE projeto, não tem índice global por id pra descobrir sozinho onde procurar.
 */
export function salvarTarefa(input: TarefaInput, home: string, criadoPor?: "agente"): Tarefa {
  const projectPath = input.projectPath;
  if (!projectPath) throw badRequest("projectPath obrigatório");
  const quadro = getQuadro(projectPath, home);
  const atual = input.id ? lerTarefaDoDisco(projectPath, home, input.id) : undefined;
  if (input.id && !atual) throw notFound(`tarefa não existe: ${input.id}`);

  const titulo = input.titulo === undefined ? atual?.titulo : limparNome(input.titulo, "título", TITULO_MAX);
  if (!titulo) throw badRequest("título obrigatório");

  const colunaId = input.colunaId === undefined ? atual?.colunaId : input.colunaId;
  if (!colunaId) throw badRequest("colunaId obrigatório");
  if (!quadro.colunas.some((c) => c.id === colunaId)) throw badRequest(`coluna não existe neste projeto: ${colunaId}`);

  const marcoId = input.marcoId === undefined ? atual?.marcoId : (input.marcoId ?? undefined);
  if (marcoId && !quadro.marcos.some((m) => m.id === marcoId)) {
    throw badRequest(`marco não existe neste projeto: ${marcoId}`);
  }

  const etiquetaIds = input.etiquetaIds === undefined ? (atual?.etiquetaIds ?? []) : limparEtiquetaIds(input.etiquetaIds, quadro);
  const prioridade = input.prioridade === undefined ? atual?.prioridade : limparPrioridade(input.prioridade);
  const descricao =
    input.descricao === undefined ? atual?.descricao : limparTextoOpcional(input.descricao, "descrição", DESCRICAO_MAX);
  const responsavel =
    input.responsavel === undefined ? atual?.responsavel : limparTextoOpcional(input.responsavel, "responsável", 80);
  const agentId = input.agentId === undefined ? atual?.agentId : (input.agentId ?? undefined);
  const prazo = input.prazo === undefined ? atual?.prazo : (limparData(input.prazo, "prazo") ?? undefined);
  const threadId = input.threadId === undefined ? atual?.threadId : (input.threadId ?? undefined);
  const tipo = input.tipo === undefined ? atual?.tipo : limparTipo(input.tipo);
  const parentId =
    input.parentId === undefined ? atual?.parentId : limparParentId(input.parentId, projectPath, home, atual?.id);
  const dependeDe =
    input.dependeDe === undefined ? (atual?.dependeDe ?? []) : limparDependeDe(input.dependeDe, projectPath, home, atual?.id);

  // Mover pra coluna final (maior `ordem`) com dependência ainda não concluída (fora da coluna
  // final) é bloqueado — dependeDe deixa de ser só informativo nesse um caso.
  const finalId = colunaFinalId(quadro);
  if (colunaId === finalId && colunaId !== atual?.colunaId && dependeDe.length) {
    const pendentes = dependeDe
      .map((id) => lerTarefaDoDisco(projectPath, home, id))
      .filter((t): t is Tarefa => !!t && t.colunaId !== finalId);
    if (pendentes.length) {
      throw badRequest(`bloqueada por: ${pendentes.map((t) => t.titulo).join(", ")}`);
    }
  }

  if (!atual && listarTarefas(projectPath, home).length >= TAREFAS_MAX_POR_PROJETO) {
    throw badRequest(`limite de ${TAREFAS_MAX_POR_PROJETO} tarefas por projeto`);
  }

  // Nova tarefa entra no fim da coluna, a menos que quem chame já mande uma ordem explícita
  // (é o caso do drag-and-drop, que calcula a posição de destino).
  const irmas = listarTarefas(projectPath, home).filter((t) => t.colunaId === colunaId && t.id !== atual?.id);
  const ordem =
    input.ordem === undefined
      ? (atual?.colunaId === colunaId ? atual?.ordem : undefined) ?? Math.max(-1, ...irmas.map((t) => t.ordem)) + 1
      : input.ordem;

  const ts = agora();
  const def: Tarefa = {
    id: atual?.id ?? newTarefaId(),
    projectPath,
    titulo,
    ...(descricao ? { descricao } : {}),
    colunaId,
    ...(marcoId ? { marcoId } : {}),
    etiquetaIds,
    ...(prioridade ? { prioridade } : {}),
    ...(responsavel ? { responsavel } : {}),
    ...(agentId ? { agentId } : {}),
    checklist: atual?.checklist ?? [],
    comentarios: atual?.comentarios ?? [],
    ...(prazo ? { prazo } : {}),
    ordem,
    ...(threadId ? { threadId } : {}),
    // Quem CRIOU, não quem tocou por último — editar uma tarefa da pessoa por MCP não deve
    // retroativamente virar "criada por agente".
    ...((atual ? atual.criadoPor : criadoPor) ? { criadoPor: (atual ? atual.criadoPor : criadoPor) as "agente" } : {}),
    ...(tipo ? { tipo } : {}),
    ...(parentId ? { parentId } : {}),
    ...(dependeDe.length ? { dependeDe } : {}),
    createdAt: atual?.createdAt ?? ts,
    updatedAt: ts,
  };
  escreverTarefa(def, quadro, home);
  if (atual && atual.colunaId !== colunaId) dispararAutomacaoDeColuna(def, quadro, home);
  return def;
}

export function apagarTarefa(projectPath: string, home: string, id: string): void {
  const path = itemPath(projectPath, home, id);
  if (!existsSync(path)) throw notFound(`tarefa não existe: ${id}`);
  rmSync(path);
}

function exigirTarefa(projectPath: string, home: string, id: string): Tarefa {
  const t = lerTarefaDoDisco(projectPath, home, id);
  if (!t) throw notFound(`tarefa não existe: ${id}`);
  return t;
}

export function adicionarChecklistItem(projectPath: string, home: string, tarefaId: string, texto: string): ChecklistItem {
  const t = exigirTarefa(projectPath, home, tarefaId);
  if (t.checklist.length >= CHECKLIST_MAX) throw badRequest(`limite de ${CHECKLIST_MAX} itens de checklist`);
  const item: ChecklistItem = { id: newChecklistItemId(), texto: limparNome(texto, "item do checklist", TEXTO_ITEM_MAX), feito: false };
  const quadro = getQuadro(projectPath, home);
  escreverTarefa({ ...t, checklist: [...t.checklist, item], updatedAt: agora() }, quadro, home);
  return item;
}

export function alternarChecklistItem(projectPath: string, home: string, tarefaId: string, itemId: string, feito: boolean): void {
  const t = exigirTarefa(projectPath, home, tarefaId);
  if (!t.checklist.some((i) => i.id === itemId)) throw notFound(`item não existe: ${itemId}`);
  const quadro = getQuadro(projectPath, home);
  escreverTarefa(
    { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? { ...i, feito } : i)), updatedAt: agora() },
    quadro,
    home,
  );
}

export function apagarChecklistItem(projectPath: string, home: string, tarefaId: string, itemId: string): void {
  const t = exigirTarefa(projectPath, home, tarefaId);
  if (!t.checklist.some((i) => i.id === itemId)) throw notFound(`item não existe: ${itemId}`);
  const quadro = getQuadro(projectPath, home);
  escreverTarefa({ ...t, checklist: t.checklist.filter((i) => i.id !== itemId), updatedAt: agora() }, quadro, home);
}

/** Comentários são só de adicionar — activity log, não tem editar/apagar. */
export function adicionarComentario(projectPath: string, home: string, tarefaId: string, texto: string, autor?: string): Comentario {
  const t = exigirTarefa(projectPath, home, tarefaId);
  if (t.comentarios.length >= COMENTARIOS_MAX) throw badRequest(`limite de ${COMENTARIOS_MAX} comentários`);
  const comentario: Comentario = {
    id: newComentarioId(),
    texto: limparNome(texto, "comentário", TEXTO_COMENTARIO_MAX),
    ...(autor ? { autor: limparNome(autor, "autor", 80) } : {}),
    criadoEm: agora(),
  };
  const quadro = getQuadro(projectPath, home);
  escreverTarefa({ ...t, comentarios: [...t.comentarios, comentario], updatedAt: agora() }, quadro, home);
  return comentario;
}

/** Erro de validação vira texto pro modelo corrigir — mesmo `tentar()` de `autoria.ts`. */
function tentar(f: () => string): Saida {
  try {
    return { ok: true, texto: f() };
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status && err.status >= 500) throw err;
    return { ok: false, texto: err.message || "não deu" };
  }
}

function linhaDaTarefa(t: Tarefa, quadro: Quadro): string {
  const coluna = quadro.colunas.find((c) => c.id === t.colunaId)?.nome ?? t.colunaId;
  const marco = t.marcoId ? quadro.marcos.find((m) => m.id === t.marcoId)?.nome : undefined;
  const etiquetas = t.etiquetaIds.map((id) => quadro.etiquetas.find((e) => e.id === id)?.nome ?? id).join(", ");
  const extra = [
    marco ? `marco ${marco}` : "",
    t.prazo ? `prazo ${t.prazo}` : "",
    t.prioridade ? `prioridade ${t.prioridade}` : "",
    t.responsavel ? `responsável ${t.responsavel}` : "",
    etiquetas ? `etiquetas: ${etiquetas}` : "",
    t.checklist.length ? `checklist ${t.checklist.filter((i) => i.feito).length}/${t.checklist.length}` : "",
    t.threadId ? "com conversa" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `- ${t.id} [${coluna}] ${t.titulo}${extra ? ` (${extra})` : ""}`;
}

export const MCP_TOOLS_TAREFA = [
  "mcp__nexo__nexo_tarefa_listar",
  "mcp__nexo__nexo_tarefa_salvar",
  "mcp__nexo__nexo_tarefa_checklist",
  "mcp__nexo__nexo_tarefa_comentar",
  "mcp__nexo__nexo_tarefa_commits",
];

/**
 * `nexo_tarefa_*`: o modelo cria, move e edita tarefas do quadro deste projeto — mesma
 * assimetria de `autoria.ts` (agente/time/hook): sem apagar por aqui, só a pessoa apaga na tela.
 * Escopado por PROJETO (não por thread), mesmo padrão de `ferramentasDeRepoMap`.
 */
export function ferramentasDeTarefas(projectPath: string, home: string): Conjunto {
  return () => {
    const quadro = getQuadro(projectPath, home);
    const idsDeColuna = quadro.colunas.map((c) => c.id);
    const idsDeMarco = quadro.marcos.map((m) => m.id);
    const idsDeEtiqueta = quadro.etiquetas.map((e) => e.id);

    const ferramentas: Ferramenta[] = [
      {
        name: "nexo_tarefa_listar",
        description:
          "Lista o quadro de tarefas deste projeto: colunas (com id), marcos (com id), etiquetas (com id) e " +
          "cada tarefa com seu estado. CHAME ISTO PRIMEIRO quando for criar/mover card — criar exige um " +
          "colunaId que já exista. Mensagem do usuário com MAIS DE UM pedido: liste, crie um card por " +
          "pedido, depois atualize conforme avança. Pedido único: não chame só por chamar.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        executar: () => {
          const tarefas = listarTarefas(projectPath, home).sort((a, b) => a.ordem - b.ordem);
          const linhas = [
            "## Colunas",
            quadro.colunas.map((c) => `- ${c.id} — ${c.nome}`).join("\n") || "- nenhuma",
            "",
            "## Marcos",
            quadro.marcos.length
              ? quadro.marcos.map((m) => `- ${m.id} — ${m.nome}${m.prazo ? ` (prazo ${m.prazo})` : ""}`).join("\n")
              : "- nenhum",
            "",
            "## Etiquetas",
            quadro.etiquetas.length ? quadro.etiquetas.map((e) => `- ${e.id} — ${e.nome}`).join("\n") : "- nenhuma",
            "",
            "## Tarefas",
            tarefas.length ? tarefas.map((t) => linhaDaTarefa(t, quadro)).join("\n") : "- nenhuma",
          ];
          return { ok: true, texto: linhas.join("\n") };
        },
      },
      {
        name: "nexo_tarefa_salvar",
        description:
          "Cria ou atualiza uma tarefa do quadro deste projeto. Mesmo id = atualiza (mover de coluna " +
          "é só mandar outro colunaId), e campo que você não mandar fica como estava. Não apaga — " +
          "apagar é só na tela, pela pessoa. Mensagem com VÁRIOS pedidos: um card por pedido, depois " +
          "vá atualizando o da vez (coluna, checklist, comentário) até mover pra coluna final.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "só pra ATUALIZAR uma tarefa já existente" },
            titulo: { type: "string" },
            descricao: { type: "string" },
            colunaId: { type: "string", ...(idsDeColuna.length ? { enum: idsDeColuna } : {}) },
            marcoId: { type: "string", ...(idsDeMarco.length ? { enum: idsDeMarco } : {}) },
            etiquetaIds: {
              type: "array",
              items: { type: "string", ...(idsDeEtiqueta.length ? { enum: idsDeEtiqueta } : {}) },
            },
            prioridade: { type: "string", enum: PRIORIDADES as unknown as string[] },
            responsavel: { type: "string", description: "nome de uma pessoa" },
            prazo: { type: "string", description: "data AAAA-MM-DD, opcional" },
            tipo: { type: "string", enum: TIPOS_TAREFA as unknown as string[] },
            parentId: { type: "string", description: "id de outra tarefa deste projeto — esta vira subtarefa dela" },
            dependeDe: {
              type: "array",
              items: { type: "string" },
              description:
                "ids de tarefas que bloqueiam esta — impede mover pra coluna FINAL do quadro se alguma ainda não estiver lá",
            },
          },
          additionalProperties: false,
        },
        executar: (args) =>
          tentar(() => {
            const t = salvarTarefa({ ...(args as TarefaInput), projectPath }, home, "agente");
            return `tarefa ${t.id} salva — [${quadro.colunas.find((c) => c.id === t.colunaId)?.nome ?? t.colunaId}] ${t.titulo}`;
          }),
      },
      {
        name: "nexo_tarefa_checklist",
        description:
          "Adiciona ou marca/desmarca um item de checklist de uma tarefa deste projeto. Pra 'adicionar' " +
          "mande texto; pra 'marcar'/'desmarcar' mande itemId (veja em nexo_tarefa_listar).",
        inputSchema: {
          type: "object",
          properties: {
            tarefaId: { type: "string" },
            acao: { type: "string", enum: ["adicionar", "marcar", "desmarcar"] },
            texto: { type: "string", description: "obrigatório só pra 'adicionar'" },
            itemId: { type: "string", description: "obrigatório só pra 'marcar'/'desmarcar'" },
          },
          required: ["tarefaId", "acao"],
          additionalProperties: false,
        },
        executar: (args) =>
          tentar(() => {
            const a = args as { tarefaId?: string; acao?: string; texto?: string; itemId?: string };
            if (!a.tarefaId) throw badRequest("tarefaId obrigatório");
            if (a.acao === "adicionar") {
              if (!a.texto) throw badRequest("texto obrigatório pra adicionar");
              const item = adicionarChecklistItem(projectPath, home, a.tarefaId, a.texto);
              return `item ${item.id} adicionado ao checklist`;
            }
            if (a.acao === "marcar" || a.acao === "desmarcar") {
              if (!a.itemId) throw badRequest("itemId obrigatório pra marcar/desmarcar");
              alternarChecklistItem(projectPath, home, a.tarefaId, a.itemId, a.acao === "marcar");
              return `item ${a.itemId} ${a.acao === "marcar" ? "marcado" : "desmarcado"}`;
            }
            throw badRequest(`ação inválida: ${String(a.acao)}`);
          }),
      },
      {
        name: "nexo_tarefa_comentar",
        description: "Adiciona um comentário numa tarefa deste projeto — activity log, sem editar/apagar depois.",
        inputSchema: {
          type: "object",
          properties: { tarefaId: { type: "string" }, texto: { type: "string" } },
          required: ["tarefaId", "texto"],
          additionalProperties: false,
        },
        executar: (args) =>
          tentar(() => {
            const a = args as { tarefaId?: string; texto?: string };
            if (!a.tarefaId || !a.texto) throw badRequest("tarefaId e texto obrigatórios");
            const c = adicionarComentario(projectPath, home, a.tarefaId, a.texto);
            return `comentário ${c.id} adicionado`;
          }),
      },
      {
        name: "nexo_tarefa_commits",
        description:
          "Lista os commits deste projeto cuja mensagem menciona o id da tarefa — útil pra ver o que já foi " +
          "feito antes de continuar o trabalho nela.",
        inputSchema: {
          type: "object",
          properties: { tarefaId: { type: "string" } },
          required: ["tarefaId"],
          additionalProperties: false,
        },
        executar: (args) => {
          const a = args as { tarefaId?: string };
          if (!a.tarefaId) return { ok: false, texto: "tarefaId obrigatório" };
          const commits = commitsRelacionados(projectPath, a.tarefaId);
          if (!commits.length) return { ok: true, texto: "nenhum commit menciona esta tarefa ainda" };
          return { ok: true, texto: commits.map((c) => `- ${c.hash.slice(0, 7)} — ${c.mensagem} (${c.data})`).join("\n") };
        },
      },
    ];
    return ferramentas;
  };
}
