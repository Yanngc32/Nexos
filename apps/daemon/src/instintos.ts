import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./log.ts";
import { projectDir, projectSlug } from "./projeto-dir.ts";
import { instalarSkillDeMarkdown } from "./skills.ts";

/**
 * Aprendizados ("instintos" no código; a tela só diz "aprendizado"): preferências de COMO a pessoa
 * quer que o agente trabalhe, tiradas das correções dela (`aprendizado-sinais.ts` marca,
 * `aprendizado-analise.ts` transforma em candidato). Um `.md` por instinto em
 * `projectDir/instintos/`, que sincroniza entre aparelhos. Só os aprovados entram no pack
 * (`blocoDeAprendizados`), com teto próprio, separado da MEMORIA.md.
 *
 * O pack é refeito a cada turno e a pasta mora no Drive: tudo aqui lê de um cache em memória por
 * projeto. A 1ª leitura é síncrona (uma vez); depois o cache se renova em segundo plano (fs
 * assíncrono) quando passa de `CACHE_TTL_MS` — é assim que entra o que outro aparelho sincronizou.
 */

export type TipoDeSinal = "parar" | "inject" | "mock_reprovado" | "mensagem_seguinte";
export type StatusDoInstinto = "candidato" | "aprovado" | "rejeitado" | "incorporado";

export type Evidencia = {
  threadId: string;
  /** Título da conversa na hora (a tela mostra sem reler a conversa). */
  titulo?: string;
  data: string;
  tipo: TipoDeSinal;
  /** Fala da pessoa, cortada (~140 caracteres). */
  trecho: string;
  efeito: "confirma" | "contradiz";
};

export type Instinto = {
  id: string;
  /** Quando vale, sem o "Quando" (ex.: "for commitar"); ver `fraseDoGatilho`. */
  gatilho: string;
  acao: string;
  /** 1–2 palavras normalizadas (`normalizarArea`): agrupa as propostas de skill. */
  area: string;
  evidencia: Evidencia[];
  /** Calculada pelo daemon (`calcularConfianca`); o arquivo guarda a da última gravação. */
  confianca: number;
  escopo: "projeto";
  status: StatusDoInstinto;
  skill?: string;
  /** A pessoa editou o texto: a análise só soma evidência, nunca reescreve `gatilho`/`acao`. */
  editadoPelaPessoa: boolean;
  /** Rejeições da pessoa: contam como contradição (−0,1 cada). */
  rejeicoes: number;
  criadoEm: string;
  atualizadoEm: string;
};

export type ConfigDoAprendizado = {
  /** Coleta + análise. Desligado, os aprovados continuam no contexto. */
  ligado: boolean;
  /** "Agora não" por área: os ids aprovados na hora; a proposta volta quando entra outro. */
  adiadas: Record<string, string[]>;
};

export const PASTA_INSTINTOS = "instintos";
const CONFIG_ARQ = "_config.json";
const CACHE_TTL_MS = 60_000;

/** Teto próprio no pack, separado dos 8000 da MEMORIA.md. */
export const APRENDIZADOS_NO_PACK_MAX_ITENS = 6;
export const APRENDIZADOS_NO_PACK_MAX_CHARS = 1500;
/** Mínimo de aprovados na mesma área pra propor uma skill. */
export const MINIMO_PRA_SKILL = 3;
export const GATILHO_MAX = 120;
export const ACAO_MAX = 280;

const SEMANA_MS = 7 * 24 * 60 * 60_000;

/* ---------------------------------------------------------------------------
 * Puros
 * ------------------------------------------------------------------------- */

/** "Commits de Release" → "commits-de-release": minúsculas, sem acento, hífen no lugar de espaço. */
export function normalizarArea(area: string): string {
  const s = area
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 2)
    .join("-");
  return s || "geral";
}

/** Gatilho como frase: "for commitar" → "Quando for commitar"; "Ao terminar" fica como está. */
export function fraseDoGatilho(gatilho: string): string {
  const g = gatilho.trim().replace(/[:.]+$/, "");
  if (/^(quando|ao|antes|depois|sempre|se|em|no|na|durante)\b/i.test(g)) return g.charAt(0).toUpperCase() + g.slice(1);
  return `Quando ${g}`;
}

/** Tabela do ECC por conversas distintas que confirmam: 1–2 → 0,3; 3–5 → 0,5; 6–10 → 0,7; 11+ → 0,85. */
function base(conversas: number): number {
  if (conversas >= 11) return 0.85;
  if (conversas >= 6) return 0.7;
  if (conversas >= 3) return 0.5;
  if (conversas >= 1) return 0.3;
  return 0.1;
}

/**
 * Confiança calculada pelo daemon (o modelo só diz se a evidência confirma ou contradiz):
 * base pela contagem de conversas que confirmam, +0,05 por confirmação a mais na mesma conversa,
 * −0,1 por contradição (rejeição da pessoa conta), −0,02 por semana sem aparecer.
 * Aprovar e editar NÃO mexem: a aprovação é o portão (`status`), a confiança mede evidência.
 */
export function calcularConfianca(i: Pick<Instinto, "evidencia" | "rejeicoes">, agora = Date.now()): number {
  const confirmam = i.evidencia.filter((e) => e.efeito === "confirma");
  const conversas = new Set(confirmam.map((e) => e.threadId)).size;
  const contra = i.evidencia.length - confirmam.length + (i.rejeicoes || 0);
  let c = base(conversas) + 0.05 * (confirmam.length - conversas) - 0.1 * contra;
  const ultima = Math.max(0, ...i.evidencia.map((e) => Date.parse(e.data) || 0));
  if (ultima) c -= 0.02 * Math.max(0, Math.floor((agora - ultima) / SEMANA_MS));
  return Math.round(Math.min(0.95, Math.max(0.05, c)) * 100) / 100;
}

function valorDoFrontmatter(bruto: string): unknown {
  try {
    return JSON.parse(bruto);
  } catch {
    return bruto;
  }
}

/** `.md` do instinto: frontmatter com um valor JSON por chave (JSON é YAML válido) + a frase legível. */
export function escreverInstinto(i: Instinto): string {
  const campos: (keyof Instinto)[] = [
    "id",
    "gatilho",
    "acao",
    "area",
    "escopo",
    "status",
    "confianca",
    "editadoPelaPessoa",
    "rejeicoes",
    "criadoEm",
    "atualizadoEm",
    "skill",
    "evidencia",
  ];
  const linhas = campos.filter((k) => i[k] !== undefined).map((k) => `${k}: ${JSON.stringify(i[k])}`);
  return `---\n${linhas.join("\n")}\n---\n\n${fraseDoGatilho(i.gatilho)}: ${i.acao}\n`;
}

const STATUS: StatusDoInstinto[] = ["candidato", "aprovado", "rejeitado", "incorporado"];

export function lerInstinto(texto: string): Instinto | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  if (!m) return null;
  const o: Record<string, unknown> = {};
  for (const linha of m[1]!.split(/\r?\n/)) {
    const i = linha.indexOf(": ");
    if (i > 0) o[linha.slice(0, i).trim()] = valorDoFrontmatter(linha.slice(i + 2).trim());
  }
  if (typeof o.id !== "string" || typeof o.gatilho !== "string" || typeof o.acao !== "string") return null;
  const evidencia = Array.isArray(o.evidencia)
    ? (o.evidencia as Evidencia[]).filter((e) => e && typeof e.threadId === "string" && typeof e.data === "string")
    : [];
  return {
    id: o.id,
    gatilho: o.gatilho,
    acao: o.acao,
    area: normalizarArea(typeof o.area === "string" ? o.area : ""),
    evidencia,
    confianca: typeof o.confianca === "number" ? o.confianca : 0.3,
    escopo: "projeto",
    status: STATUS.includes(o.status as StatusDoInstinto) ? (o.status as StatusDoInstinto) : "candidato",
    ...(typeof o.skill === "string" && o.skill ? { skill: o.skill } : {}),
    editadoPelaPessoa: o.editadoPelaPessoa === true,
    rejeicoes: typeof o.rejeicoes === "number" ? o.rejeicoes : 0,
    criadoEm: typeof o.criadoEm === "string" ? o.criadoEm : new Date(0).toISOString(),
    atualizadoEm: typeof o.atualizadoEm === "string" ? o.atualizadoEm : new Date(0).toISOString(),
  };
}

/** Aprovados que valem pro contexto, mais fortes primeiro, e o corte pelo teto. */
export function selecionarParaContexto(
  instintos: Instinto[],
  agora = Date.now(),
): { dentro: Instinto[]; fora: Instinto[]; chars: number; linhas: string[] } {
  const aprovados = instintos
    .filter((i) => i.status === "aprovado")
    .map((i) => ({ i, c: calcularConfianca(i, agora) }))
    .sort((a, b) => b.c - a.c || (a.i.criadoEm < b.i.criadoEm ? -1 : 1));
  const dentro: Instinto[] = [];
  const fora: Instinto[] = [];
  const linhas: string[] = [];
  let chars = 0;
  for (const { i } of aprovados) {
    const linha = `- ${fraseDoGatilho(i.gatilho)}: ${i.acao}`;
    if (dentro.length >= APRENDIZADOS_NO_PACK_MAX_ITENS || chars + linha.length > APRENDIZADOS_NO_PACK_MAX_CHARS) {
      fora.push(i);
      continue;
    }
    dentro.push(i);
    linhas.push(linha);
    chars += linha.length;
  }
  return { dentro, fora, chars, linhas };
}

export const TITULO_DO_BLOCO = "# Preferências aprendidas";

/** Bloco do pack (logo depois de `# Memória do projeto`); vazio sem aprovado. */
export function montarBlocoDeAprendizados(instintos: Instinto[], agora = Date.now()): string {
  const { linhas } = selecionarParaContexto(instintos, agora);
  if (!linhas.length) return "";
  return `${TITULO_DO_BLOCO}\nVêm de correções suas que você aprovou; são referência, não ordem.\n${linhas.join("\n")}`;
}

export type PropostaDeSkill = {
  area: string;
  skill: string;
  /** A área já tem skill (algum incorporado): a proposta regrava com tudo. */
  atualizar: boolean;
  /** Aprovados ainda fora da skill. */
  ids: string[];
  gatilhos: string[];
};

export function nomeDaSkill(slugDoProjeto: string, area: string): string {
  const slug = slugDoProjeto
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `aprendizados-${slug || "projeto"}-${normalizarArea(area)}`;
}

/** 3+ aprovados na mesma área (ou 1+ novo numa área que já tem skill), menos as adiadas sem novidade. */
export function propostasDeSkill(instintos: Instinto[], config: ConfigDoAprendizado, slugDoProjeto: string): PropostaDeSkill[] {
  const porArea = new Map<string, Instinto[]>();
  for (const i of instintos) {
    if (i.status !== "aprovado" && i.status !== "incorporado") continue;
    porArea.set(i.area, [...(porArea.get(i.area) ?? []), i]);
  }
  const out: PropostaDeSkill[] = [];
  for (const [area, lista] of [...porArea].sort(([a], [b]) => a.localeCompare(b))) {
    const novos = lista.filter((i) => i.status === "aprovado");
    const temSkill = lista.some((i) => i.status === "incorporado");
    if (!novos.length || (!temSkill && novos.length < MINIMO_PRA_SKILL)) continue;
    const adiada = config.adiadas[area];
    if (adiada && novos.every((i) => adiada.includes(i.id))) continue;
    out.push({
      area,
      skill: nomeDaSkill(slugDoProjeto, area),
      atualizar: temSkill,
      ids: novos.map((i) => i.id),
      gatilhos: (temSkill ? lista : novos).map((i) => fraseDoGatilho(i.gatilho)),
    });
  }
  return out;
}

/** `SKILL.md` por modelo fixo, sem LLM. */
export function montarSkill(nome: string, area: string, projeto: string, instintos: Instinto[]): string {
  const linhas = instintos.map((i) => `- ${fraseDoGatilho(i.gatilho)}: ${i.acao}`);
  return [
    "---",
    `name: ${nome}`,
    `description: Preferências aprendidas sobre ${area} no projeto ${projeto}. Use quando a tarefa envolver ${area}.`,
    "---",
    "",
    `# Preferências aprendidas: ${area}`,
    "",
    `Vêm de correções que a pessoa fez e aprovou no projeto ${projeto} (Nexos → Memória do Projeto → Aprendizados).`,
    "São referência de como ela prefere que o trabalho seja feito, não ordem acima do pedido da vez.",
    "",
    ...linhas,
    "",
  ].join("\n");
}

/* ---------------------------------------------------------------------------
 * Cache e disco
 * ------------------------------------------------------------------------- */

type Estado = {
  dir: string;
  instintos: Map<string, Instinto>;
  config: ConfigDoAprendizado;
  /** mtime de cada arquivo lido: a renovação só relê o que mudou. */
  mtimes: Map<string, number>;
  lidoEm: number;
  renovando: Promise<void> | null;
};

const caches = new Map<string, Estado>();
type Ouvinte = (projectPath: string) => void;
const ouvintes = new Set<Ouvinte>();

/** Avisa quando os aprendizados de um projeto mudam (gravação daqui ou renovação que achou mudança). */
export function aoMudarAprendizados(fn: Ouvinte): () => void {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

function avisar(projectPath: string): void {
  for (const fn of ouvintes) {
    try {
      fn(projectPath);
    } catch (e) {
      log.aviso("aprendizado", "ouvinte de aprendizados falhou", { erro: (e as Error).message });
    }
  }
}

function configPadrao(): ConfigDoAprendizado {
  return { ligado: true, adiadas: {} };
}

function lerConfig(texto: string | null): ConfigDoAprendizado {
  if (!texto) return configPadrao();
  try {
    const o = JSON.parse(texto) as Partial<ConfigDoAprendizado>;
    return {
      ligado: o.ligado !== false,
      adiadas: o.adiadas && typeof o.adiadas === "object" ? (o.adiadas as Record<string, string[]>) : {},
    };
  } catch {
    return configPadrao();
  }
}

function pastaDosInstintos(projectPath: string, home: string): string {
  return join(projectDir(projectPath, home), PASTA_INSTINTOS);
}

/** 1ª leitura do projeto: síncrona, uma vez só por subida do motor. */
function carregar(projectPath: string, home: string): Estado {
  const dir = pastaDosInstintos(projectPath, home);
  const estado: Estado = { dir, instintos: new Map(), config: configPadrao(), mtimes: new Map(), lidoEm: Date.now(), renovando: null };
  if (!existsSync(dir)) return estado;
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    try {
      if (nome === CONFIG_ARQ) {
        estado.config = lerConfig(readFileSync(caminho, "utf8"));
        estado.mtimes.set(nome, statSync(caminho).mtimeMs);
        continue;
      }
      if (!nome.endsWith(".md")) continue;
      const i = lerInstinto(readFileSync(caminho, "utf8"));
      if (i) estado.instintos.set(i.id, i);
      estado.mtimes.set(nome, statSync(caminho).mtimeMs);
    } catch (e) {
      log.avisoUmaVez(`instinto-ler-${caminho}`, "aprendizado", "não consegui ler um aprendizado", { caminho, erro: (e as Error).message });
    }
  }
  return estado;
}

/** Renova em segundo plano (fs assíncrono): só relê arquivo novo ou com mtime diferente. */
async function renovar(projectPath: string, estado: Estado): Promise<void> {
  let mudou = false;
  try {
    const nomes = existsSync(estado.dir) ? await readdir(estado.dir) : [];
    const vistos = new Set<string>();
    for (const nome of nomes) {
      if (nome !== CONFIG_ARQ && !nome.endsWith(".md")) continue;
      vistos.add(nome);
      const caminho = join(estado.dir, nome);
      const m = (await stat(caminho)).mtimeMs;
      if (estado.mtimes.get(nome) === m) continue;
      const texto = await readFile(caminho, "utf8");
      estado.mtimes.set(nome, m);
      mudou = true;
      if (nome === CONFIG_ARQ) estado.config = lerConfig(texto);
      else {
        const i = lerInstinto(texto);
        if (i) estado.instintos.set(i.id, i);
      }
    }
    for (const nome of [...estado.mtimes.keys()]) {
      if (vistos.has(nome)) continue;
      estado.mtimes.delete(nome);
      mudou = true;
      if (nome === CONFIG_ARQ) estado.config = configPadrao();
      else estado.instintos.delete(nome.slice(0, -".md".length));
    }
  } catch (e) {
    log.avisoUmaVez(`instintos-renovar-${estado.dir}`, "aprendizado", "não consegui renovar os aprendizados", { erro: (e as Error).message });
  } finally {
    estado.lidoEm = Date.now();
    estado.renovando = null;
  }
  if (mudou) avisar(projectPath);
}

function estadoDe(projectPath: string, home: string): Estado {
  let e = caches.get(projectPath);
  if (!e) {
    e = carregar(projectPath, home);
    caches.set(projectPath, e);
    return e;
  }
  if (!e.renovando && Date.now() - e.lidoEm > CACHE_TTL_MS) e.renovando = renovar(projectPath, e);
  return e;
}

/** Espera a renovação em curso (teste e quem acabou de sincronizar). */
export async function renovarAprendizados(projectPath: string, home: string): Promise<void> {
  const e = caches.get(projectPath);
  if (!e) {
    estadoDe(projectPath, home);
    return;
  }
  e.renovando ??= renovar(projectPath, e);
  await e.renovando;
}

export function resetInstintosForTest(): void {
  caches.clear();
}

function escreverAtomico(caminho: string, conteudo: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = `${caminho}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, conteudo, "utf8");
  renameSync(tmp, caminho);
}

function gravar(projectPath: string, e: Estado, i: Instinto): Instinto {
  const salvo = { ...i, confianca: calcularConfianca(i) };
  const nome = `${i.id}.md`;
  const caminho = join(e.dir, nome);
  escreverAtomico(caminho, escreverInstinto(salvo));
  e.instintos.set(i.id, salvo);
  e.mtimes.set(nome, statSync(caminho).mtimeMs);
  avisar(projectPath);
  return salvo;
}

function gravarConfig(projectPath: string, e: Estado): void {
  const caminho = join(e.dir, CONFIG_ARQ);
  escreverAtomico(caminho, JSON.stringify(e.config, null, 2));
  e.mtimes.set(CONFIG_ARQ, statSync(caminho).mtimeMs);
  avisar(projectPath);
}

/* ---------------------------------------------------------------------------
 * API do motor
 * ------------------------------------------------------------------------- */

export function listarInstintos(projectPath: string, home: string): Instinto[] {
  const agora = Date.now();
  return [...estadoDe(projectPath, home).instintos.values()].map((i) => ({ ...i, confianca: calcularConfianca(i, agora) }));
}

export function configDoAprendizado(projectPath: string, home: string): ConfigDoAprendizado {
  return estadoDe(projectPath, home).config;
}

export function aprendizadoLigado(projectPath: string, home: string): boolean {
  return configDoAprendizado(projectPath, home).ligado;
}

export function definirAprendizadoLigado(projectPath: string, home: string, ligado: boolean): ConfigDoAprendizado {
  const e = estadoDe(projectPath, home);
  e.config = { ...e.config, ligado };
  gravarConfig(projectPath, e);
  return e.config;
}

export function candidatosPendentes(projectPath: string, home: string): number {
  return listarInstintos(projectPath, home).filter((i) => i.status === "candidato").length;
}

/** Só o que já está no cache (nunca lê disco): a barra lateral consulta todo projeto a cada poll. */
export function candidatosPendentesEmCache(projectPath: string): number | null {
  const e = caches.get(projectPath);
  if (!e) return null;
  if (!e.config.ligado) return 0;
  let n = 0;
  for (const i of e.instintos.values()) if (i.status === "candidato") n++;
  return n;
}

/** Bloco `# Preferências aprendidas` do pack; erro de leitura não derruba o turno. */
export function blocoDeAprendizados(projectPath: string, home: string): string {
  try {
    return montarBlocoDeAprendizados([...estadoDe(projectPath, home).instintos.values()]);
  } catch (e) {
    log.avisoUmaVez("aprendizados-pack", "aprendizado", "aprendizados ficaram fora do contexto", { erro: (e as Error).message });
    return "";
  }
}

function erro(status: number, msg: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(msg), { status, ...extra });
}

function instintoOuErro(e: Estado, id: string, expected?: unknown): Instinto {
  const i = e.instintos.get(id);
  if (!i) throw erro(404, `aprendizado ${id} não existe`);
  // mudou em outro aparelho (sync) no meio da edição: a tela recarrega o cartão
  if (typeof expected === "string" && expected && expected !== i.atualizadoEm) {
    throw erro(409, "mudou em outro aparelho", { atual: { ...i, confianca: calcularConfianca(i) } });
  }
  return i;
}

export type AcaoNoInstinto = "aprovar" | "rejeitar" | "reconsiderar" | "desfazer-rejeicao";

/**
 * Aprovar: só o `status` (a confiança não muda). Rejeitar (ou Remover um aprovado): contradição,
 * −0,1. Reconsiderar: volta pra revisão sem mexer na confiança. Desfazer (toast de 6 s): devolve
 * o estado de antes da rejeição.
 */
export function agirNoInstinto(
  projectPath: string,
  home: string,
  id: string,
  acao: AcaoNoInstinto,
  opts: { expected?: unknown; statusAnterior?: unknown } = {},
): Instinto {
  const e = estadoDe(projectPath, home);
  const i = instintoOuErro(e, id, opts.expected);
  const agora = new Date().toISOString();
  let novo: Instinto;
  if (acao === "aprovar") novo = { ...i, status: "aprovado" };
  else if (acao === "rejeitar") novo = { ...i, status: "rejeitado", rejeicoes: i.rejeicoes + 1 };
  else if (acao === "reconsiderar") novo = { ...i, status: "candidato" };
  else if (acao === "desfazer-rejeicao") {
    if (i.status !== "rejeitado") throw erro(400, "esse aprendizado não está rejeitado");
    const volta = opts.statusAnterior === "aprovado" ? "aprovado" : "candidato";
    novo = { ...i, status: volta, rejeicoes: Math.max(0, i.rejeicoes - 1) };
  } else throw erro(400, `ação inválida: ${String(acao)}`);
  return gravar(projectPath, e, { ...novo, atualizadoEm: agora });
}

/** Edição da pessoa: marca `editadoPelaPessoa` (a análise nunca mais reescreve o texto). */
export function editarInstinto(
  projectPath: string,
  home: string,
  id: string,
  input: { gatilho?: unknown; acao?: unknown; aprovar?: unknown; expected?: unknown },
): Instinto {
  const e = estadoDe(projectPath, home);
  const i = instintoOuErro(e, id, input.expected);
  const gatilho = typeof input.gatilho === "string" ? input.gatilho.trim().replace(/^quando\s+/i, "") : i.gatilho;
  const acao = typeof input.acao === "string" ? input.acao.trim() : i.acao;
  if (!gatilho || !acao) throw erro(400, "preencha o “Quando…” e o “Fazer…”");
  if (gatilho.length > GATILHO_MAX) throw erro(400, `o “Quando…” passa de ${GATILHO_MAX} caracteres`);
  if (acao.length > ACAO_MAX) throw erro(400, `o “Fazer…” passa de ${ACAO_MAX} caracteres`);
  const status = input.aprovar === true && i.status === "candidato" ? "aprovado" : i.status;
  return gravar(projectPath, e, { ...i, gatilho, acao, status, editadoPelaPessoa: true, atualizadoEm: new Date().toISOString() });
}

export type ResultadoDaAnalise =
  | { tipo: "novo"; gatilho: string; acao: string; area: string; evidencia: Evidencia[] }
  | { tipo: "evidencia"; id: string; evidencia: Evidencia[]; gatilho?: string; acao?: string };

/**
 * Aplica o que a análise achou: candidato novo, ou evidência somada num existente. Texto editado
 * pela pessoa nunca é reescrito; o de candidato não editado pode ser refinado pela análise.
 */
export function aplicarAnalise(projectPath: string, home: string, r: ResultadoDaAnalise): Instinto | null {
  const e = estadoDe(projectPath, home);
  const agora = new Date().toISOString();
  if (r.tipo === "novo") {
    const gatilho = r.gatilho.trim().replace(/^quando\s+/i, "").slice(0, GATILHO_MAX);
    const acao = r.acao.trim().slice(0, ACAO_MAX);
    if (!gatilho || !acao || !r.evidencia.length) return null;
    const id = `in-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    return gravar(projectPath, e, {
      id,
      gatilho,
      acao,
      area: normalizarArea(r.area),
      evidencia: r.evidencia,
      confianca: 0,
      escopo: "projeto",
      status: "candidato",
      editadoPelaPessoa: false,
      rejeicoes: 0,
      criadoEm: agora,
      atualizadoEm: agora,
    });
  }
  const i = e.instintos.get(r.id);
  if (!i) return null;
  const ja = new Set(i.evidencia.map((x) => `${x.threadId}|${x.data}|${x.tipo}`));
  const novas = r.evidencia.filter((x) => !ja.has(`${x.threadId}|${x.data}|${x.tipo}`));
  if (!novas.length) return i;
  const reescreve = !i.editadoPelaPessoa && i.status === "candidato";
  return gravar(projectPath, e, {
    ...i,
    ...(reescreve && r.gatilho?.trim() ? { gatilho: r.gatilho.trim().replace(/^quando\s+/i, "").slice(0, GATILHO_MAX) } : {}),
    ...(reescreve && r.acao?.trim() ? { acao: r.acao.trim().slice(0, ACAO_MAX) } : {}),
    evidencia: [...i.evidencia, ...novas],
    atualizadoEm: agora,
  });
}

/** Resumo pra tela: contexto agora (itens e caracteres) e propostas de skill. */
export function resumoDoAprendizado(projectPath: string, home: string) {
  const instintos = listarInstintos(projectPath, home);
  const config = configDoAprendizado(projectPath, home);
  const sel = selecionarParaContexto(instintos);
  const dentro = new Set(sel.dentro.map((i) => i.id));
  let slug = "projeto";
  try {
    slug = projectSlug(projectPath, home).slug;
  } catch {
    /* sem slug: nome genérico */
  }
  return {
    ligado: config.ligado,
    instintos: instintos.map((i) => ({ ...i, noContexto: dentro.has(i.id) })),
    propostas: propostasDeSkill(instintos, config, slug),
    contexto: {
      itens: sel.dentro.length,
      maxItens: APRENDIZADOS_NO_PACK_MAX_ITENS,
      chars: sel.chars,
      maxChars: APRENDIZADOS_NO_PACK_MAX_CHARS,
    },
  };
}

/** "Agora não": esconde a proposta da área até entrar um aprovado novo nela. */
export function adiarProposta(projectPath: string, home: string, area: string): void {
  const e = estadoDe(projectPath, home);
  const ids = [...e.instintos.values()].filter((i) => i.area === area && i.status === "aprovado").map((i) => i.id);
  e.config = { ...e.config, adiadas: { ...e.config.adiadas, [area]: ids } };
  gravarConfig(projectPath, e);
}

/**
 * "Criar skill" / "Atualizar skill": grava a skill GLOBAL (fora do repo, desligável por projeto em
 * Configurações → Skills) com todos os aprovados e incorporados da área; os aprovados viram
 * `incorporado` e saem do bloco do pack. Falha ao gravar a skill não mexe em nenhum aprendizado.
 */
export function criarSkillDaArea(projectPath: string, home: string, area: string): { skill: string; caminho: string; incorporados: string[] } {
  const e = estadoDe(projectPath, home);
  const slug = projectSlug(projectPath, home).slug;
  const lista = [...e.instintos.values()].filter((i) => i.area === area && (i.status === "aprovado" || i.status === "incorporado"));
  const novos = lista.filter((i) => i.status === "aprovado");
  if (!novos.length) throw erro(400, `nenhum aprendizado aprovado novo em ${area}`);
  const temSkill = lista.some((i) => i.status === "incorporado");
  if (!temSkill && novos.length < MINIMO_PRA_SKILL) throw erro(400, `precisa de ${MINIMO_PRA_SKILL} aprendizados aprovados em ${area}`);
  const skill = nomeDaSkill(slug, area);
  const caminho = instalarSkillDeMarkdown(home, skill, montarSkill(skill, area, slug, lista));
  const agora = new Date().toISOString();
  for (const i of novos) gravar(projectPath, e, { ...i, status: "incorporado", skill, atualizadoEm: agora });
  if (e.config.adiadas[area]) {
    const { [area]: _, ...resto } = e.config.adiadas;
    e.config = { ...e.config, adiadas: resto };
    gravarConfig(projectPath, e);
  }
  log.info("aprendizado", "skill de aprendizados gravada", { skill, area, itens: lista.length });
  return { skill, caminho, incorporados: novos.map((i) => i.id) };
}

/** Só pra teste: apaga a pasta de instintos do projeto. */
export function apagarInstintosForTest(projectPath: string, home: string): void {
  rmSync(pastaDosInstintos(projectPath, home), { recursive: true, force: true });
  caches.delete(projectPath);
}
