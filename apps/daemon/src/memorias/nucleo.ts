/**
 * Núcleo da memória do usuário: a pasta `<home>/memorias` é a fonte da verdade.
 *
 * Cada memória é um `.md` (ver `arquivo.ts`); o diário `<dir>/.memorias.json`
 * guarda o que o arquivo não diz — revisão, sha256 do conteúdo, status, origem
 * e datas — e os títulos de seção do índice. Toda escrita passa por
 * `proporMemoria`, que reconcilia antes (o disco pode ter mudado por fora),
 * confere a revisão esperada (CAS), tira segredos para o cofre e regenera o
 * MEMORY.md depois.
 *
 * Diferente do Agent Code, edição externa não é conflito: o arquivo editado à
 * mão é ADOTADO (revisão+1, origem "externo"), o novo é importado, e o que
 * sumiu vira aposentado.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ARQUIVO_INDICE,
  caminhoAposentado,
  caminhoAtivo,
  memoriasDir,
  normalizarCaminho,
  pastaDe,
  validarCaminhoMemoria,
} from "./caminho.ts";
import {
  lerConteudo,
  montarArquivo,
  separarFrontmatter,
  separarTitulo,
  TIPO_PADRAO,
  TIPOS_MEMORIA,
  tipoValido,
  tituloDoArquivo,
  umaLinha,
  type ConteudoMemoria,
} from "./arquivo.ts";
import { lerSecoesIndice, renderizarIndice } from "./indice.ts";
import { rankearMemorias } from "./busca.ts";
import { gravarSegredo, listarSegredos } from "./cofre.ts";
import { nomeSegredoDerivado, nomeSegredoValido, substituirSegredos, valoresSegredo, varrerSegredos } from "./segredos.ts";
import { ORIGENS_MEMORIA, type Memoria, type OrigemMemoria, type PropostaMemoria, type ResultadoProposta } from "./tipos.ts";

const ARQUIVO_DIARIO = ".memorias.json";

interface EntradaDiario {
  revisao: number;
  sha256: string;
  status: "ativa" | "aposentada";
  titulo: string;
  gancho: string;
  tipo: string;
  origem: OrigemMemoria;
  criadaEm: string;
  atualizadaEm: string;
}

interface Diario {
  version: 1;
  entradas: Record<string, EntradaDiario>;
  /** pasta → título de seção escrito à mão no MEMORY.md. */
  secoes: Record<string, string>;
}

const sha256 = (dado: string | Buffer): string => createHash("sha256").update(dado).digest("hex");
const agoraIso = (): string => new Date().toISOString();

/** Grava por tmp + rename na mesma pasta; o tmp é oculto, a varredura não o vê. */
function escreverAtomico(caminho: string, conteudo: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = join(dirname(caminho), `.${basename(caminho)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, conteudo, "utf8");
    renameSync(tmp, caminho);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* sobra do tmp não importa */ }
    throw e;
  }
}

// ── diário ──────────────────────────────────────────────────────────────────

function entradaValida(e: unknown): e is EntradaDiario {
  if (!e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  return (
    typeof x.revisao === "number" && Number.isInteger(x.revisao) && x.revisao >= 1 &&
    typeof x.sha256 === "string" && (x.status === "ativa" || x.status === "aposentada") &&
    typeof x.titulo === "string" && typeof x.gancho === "string" && typeof x.tipo === "string" &&
    (ORIGENS_MEMORIA as readonly unknown[]).includes(x.origem) &&
    typeof x.criadaEm === "string" && typeof x.atualizadaEm === "string"
  );
}

/** Diário do disco; ausente ou ilegível = diário vazio (os arquivos são reimportados). */
function lerDiario(home: string): Diario {
  const vazio: Diario = { version: 1, entradas: {}, secoes: {} };
  try {
    const dado = JSON.parse(readFileSync(join(memoriasDir(home), ARQUIVO_DIARIO), "utf8")) as Partial<Diario> | null;
    if (!dado || dado.version !== 1 || typeof dado.entradas !== "object" || !dado.entradas) return vazio;
    const entradas: Record<string, EntradaDiario> = {};
    for (const [rel, e] of Object.entries(dado.entradas)) {
      if (!validarCaminhoMemoria(rel) && entradaValida(e)) entradas[rel] = e;
    }
    const secoes: Record<string, string> = {};
    if (dado.secoes && typeof dado.secoes === "object") {
      for (const [pasta, titulo] of Object.entries(dado.secoes)) if (typeof titulo === "string" && titulo.trim()) secoes[pasta] = titulo;
    }
    return { version: 1, entradas, secoes };
  } catch {
    return vazio;
  }
}

function gravarDiario(home: string, diario: Diario): void {
  escreverAtomico(join(memoriasDir(home), ARQUIVO_DIARIO), JSON.stringify(diario, null, 2) + "\n");
}

function renderizarDoDiario(diario: Diario): string {
  const itens = Object.entries(diario.entradas)
    .filter(([, e]) => e.status === "ativa")
    .map(([relPath, e]) => ({ relPath, titulo: e.titulo, gancho: e.gancho }));
  return renderizarIndice(itens, diario.secoes);
}

/** Regrava o MEMORY.md só quando o conteúdo mudou. */
function gravarIndice(home: string, diario: Diario): string {
  const conteudo = renderizarDoDiario(diario);
  const arq = join(memoriasDir(home), ARQUIVO_INDICE);
  let atual: string | undefined;
  try { atual = readFileSync(arq, "utf8"); } catch { atual = undefined; }
  if (atual !== conteudo) escreverAtomico(arq, conteudo);
  return conteudo;
}

// ── reconciliação ─────────────────────────────────────────────────────────────

/** Memórias ativas no disco: raiz e um nível de pasta, só caminhos aceitos. */
function varrerArquivos(home: string): Map<string, string> {
  const dir = memoriasDir(home);
  const achados = new Map<string, string>();
  let itens;
  try { itens = readdirSync(dir, { withFileTypes: true }); } catch { return achados; }
  for (const item of itens) {
    if (item.name.startsWith(".")) continue;
    if (item.isFile()) {
      if (!validarCaminhoMemoria(item.name)) achados.set(item.name, join(dir, item.name));
    } else if (item.isDirectory()) {
      let subs;
      try { subs = readdirSync(join(dir, item.name), { withFileTypes: true }); } catch { continue; }
      for (const sub of subs) {
        const rel = `${item.name}/${sub.name}`;
        if (sub.isFile() && !validarCaminhoMemoria(rel)) achados.set(rel, join(dir, item.name, sub.name));
      }
    }
  }
  return achados;
}

interface ResultadoReconciliacao {
  importadas: string[];
  adotadas: string[];
  aposentadas: string[];
}

function reconciliar(home: string): { diario: Diario; resultado: ResultadoReconciliacao } {
  const dir = memoriasDir(home);
  mkdirSync(dir, { recursive: true });
  const diario = lerDiario(home);
  const resultado: ResultadoReconciliacao = { importadas: [], adotadas: [], aposentadas: [] };
  let mudou = false;

  // Título de seção mexido à mão no MEMORY.md: vale o do arquivo.
  try {
    for (const [pasta, titulo] of lerSecoesIndice(readFileSync(join(dir, ARQUIVO_INDICE), "utf8"))) {
      if (titulo === pasta) {
        if (pasta in diario.secoes) { delete diario.secoes[pasta]; mudou = true; }
      } else if (diario.secoes[pasta] !== titulo) {
        diario.secoes[pasta] = titulo;
        mudou = true;
      }
    }
  } catch { /* sem MEMORY.md ainda */ }

  const arquivos = varrerArquivos(home);
  const agora = agoraIso();
  for (const [rel, abs] of [...arquivos].sort((a, b) => a[0].localeCompare(b[0]))) {
    let bruto: Buffer;
    try { bruto = readFileSync(abs); } catch { arquivos.delete(rel); continue; }
    const hash = sha256(bruto);
    const e = diario.entradas[rel];
    if (e && e.status === "ativa" && e.sha256 === hash) continue;
    const c = lerConteudo(bruto.toString("utf8"), rel);
    const meta = { titulo: c.titulo, gancho: c.gancho, tipo: c.tipo };
    if (!e) {
      diario.entradas[rel] = { revisao: 1, sha256: hash, status: "ativa", ...meta, origem: "externo", criadaEm: agora, atualizadaEm: agora };
      resultado.importadas.push(rel);
    } else {
      diario.entradas[rel] = { ...e, ...meta, revisao: e.revisao + 1, sha256: hash, status: "ativa", origem: "externo", atualizadaEm: agora };
      resultado.adotadas.push(rel);
    }
    mudou = true;
  }
  for (const [rel, e] of Object.entries(diario.entradas)) {
    if (e.status !== "ativa" || arquivos.has(rel)) continue;
    diario.entradas[rel] = { ...e, status: "aposentada", revisao: e.revisao + 1, atualizadaEm: agora };
    resultado.aposentadas.push(rel);
    mudou = true;
  }

  if (mudou) gravarDiario(home, diario);
  gravarIndice(home, diario);
  return { diario, resultado };
}

/**
 * Alinha o diário com o disco: importa `.md` novo, adota o editado por fora
 * (revisão+1, origem "externo") e aposenta a memória cujo arquivo sumiu.
 * Regenera o MEMORY.md.
 */
export function reconciliarMemorias(home: string): { importadas: string[]; adotadas: string[]; aposentadas: string[] } {
  return reconciliar(home).resultado;
}

// ── leitura ───────────────────────────────────────────────────────────────────

function montarMemoria(home: string, relPath: string, e: EntradaDiario): Memoria {
  let c: ConteudoMemoria = { titulo: e.titulo, gancho: e.gancho, tipo: e.tipo, corpo: "" };
  const arq = e.status === "ativa" ? caminhoAtivo(home, relPath) : caminhoAposentado(home, relPath);
  try { c = lerConteudo(readFileSync(arq, "utf8"), relPath); } catch { /* aposentada que sumiu do disco */ }
  return {
    relPath,
    pasta: pastaDe(relPath),
    titulo: c.titulo,
    gancho: c.gancho,
    tipo: c.tipo,
    corpo: c.corpo,
    revisao: e.revisao,
    status: e.status,
    origem: e.origem,
    criadaEm: e.criadaEm,
    atualizadaEm: e.atualizadaEm,
  };
}

/**
 * Memórias (ativas, ou todas com `incluirAposentadas`), por relPath. Com
 * `consulta`, só as que pontuam, da mais relevante à menos. `limite` corta.
 */
export function listarMemorias(home: string, o: { consulta?: string; limite?: number; incluirAposentadas?: boolean } = {}): Memoria[] {
  const { diario } = reconciliar(home);
  let lista = Object.entries(diario.entradas)
    .filter(([, e]) => o.incluirAposentadas || e.status === "ativa")
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([rel, e]) => montarMemoria(home, rel, e));
  if (o.consulta?.trim()) lista = rankearMemorias(lista, o.consulta);
  if (typeof o.limite === "number" && o.limite >= 0) lista = lista.slice(0, o.limite);
  return lista;
}

/** Uma memória (ativa ou aposentada) pelo relPath; `undefined` se não existe ou o caminho é recusado. */
export function lerMemoria(home: string, relPath: string): Memoria | undefined {
  if (validarCaminhoMemoria(relPath)) return undefined;
  const rel = normalizarCaminho(relPath);
  const e = reconciliar(home).diario.entradas[rel];
  return e ? montarMemoria(home, rel, e) : undefined;
}

/** Conteúdo do MEMORY.md (reconciliado agora). */
export function indiceMemorias(home: string): string {
  return renderizarDoDiario(reconciliar(home).diario);
}

/** sha256 do índice: muda quando o catálogo que o modelo vê muda. */
export function versaoCatalogo(home: string): string {
  return sha256(indiceMemorias(home));
}

export function statusMemorias(home: string): { dir: string; total: number; ativas: number; aposentadas: number; segredos: number } {
  const entradas = Object.values(reconciliar(home).diario.entradas);
  const ativas = entradas.filter((e) => e.status === "ativa").length;
  return { dir: memoriasDir(home), total: entradas.length, ativas, aposentadas: entradas.length - ativas, segredos: listarSegredos(home).length };
}

/**
 * Corpo para ir ao prompt: `{{secret:x}}` fica como está (o valor nunca sai do
 * cofre por aqui) e qualquer trecho com cara de segredo que tenha escapado
 * — arquivo editado à mão — é mascarado.
 */
export function corpoParaPrompt(m: Memoria): string {
  const corpo = m.corpo ?? "";
  let saida = "";
  let pos = 0;
  for (const t of varrerSegredos(corpo)) {
    saida += corpo.slice(pos, t.inicio) + "[segredo redigido]";
    pos = t.fim;
  }
  return saida + corpo.slice(pos);
}

// ── escrita ───────────────────────────────────────────────────────────────────

const falha = (motivo: string, revisaoAtual?: number): ResultadoProposta =>
  revisaoAtual === undefined ? { ok: false, motivo } : { ok: false, motivo, revisaoAtual };

/**
 * Campos finais da memória: frontmatter no corpo vence (titulo/gancho/tipo
 * saem dele); o que a proposta não trouxe vem de `base` (update) ou do padrão.
 */
function montarCampos(p: PropostaMemoria, rel: string, base?: ConteudoMemoria): ConteudoMemoria | string {
  let { titulo, gancho, tipo, corpo } = p;
  if (typeof corpo === "string") {
    const fm = separarFrontmatter(corpo);
    if (fm.tem) {
      const t = separarTitulo(fm.resto);
      titulo = t.titulo ?? titulo;
      gancho = fm.cabecalho.description ?? gancho;
      tipo = fm.cabecalho.type ?? tipo;
      corpo = t.corpo;
    } else {
      const t = separarTitulo(corpo);
      if (t.titulo && (titulo === undefined || umaLinha(titulo) === t.titulo)) {
        titulo = t.titulo;
        corpo = t.corpo;
      }
    }
  }
  const final: ConteudoMemoria = {
    titulo: umaLinha(titulo ?? base?.titulo ?? "") || tituloDoArquivo(rel),
    gancho: umaLinha(gancho ?? base?.gancho ?? ""),
    tipo: (tipo ?? base?.tipo ?? TIPO_PADRAO).trim(),
    corpo: String(corpo ?? base?.corpo ?? "").replace(/\r\n/g, "\n").replace(/\s+$/, ""),
  };
  if (!tipoValido(final.tipo)) return `Tipo "${final.tipo}" inválido: use ${TIPOS_MEMORIA.join(", ")}.`;
  if (!final.gancho) return "A memória precisa de um gancho (description): uma linha dizendo quando ela serve.";
  if (!final.corpo.trim()) return "A memória precisa de corpo.";
  return final;
}

/**
 * Move para o cofre os segredos declarados na proposta (o nome dado vence) e
 * os que a varredura acha no texto (nome derivado do relPath, sem pisar em
 * nome já usado), e devolve os campos com `{{secret:nome}}` no lugar.
 */
function guardarSegredos(
  home: string,
  rel: string,
  campos: ConteudoMemoria,
  explicitos: PropostaMemoria["segredos"],
): { campos: ConteudoMemoria; guardados: string[] } | string {
  const atribuicoes = new Map<string, string>();
  const nomes = new Set<string>();
  if (explicitos !== undefined && !Array.isArray(explicitos)) return "segredos precisa ser uma lista de { nome, valor }.";
  for (const s of explicitos ?? []) {
    if (!s || !nomeSegredoValido(s.nome)) return `Nome de segredo inválido: "${String(s?.nome)}".`;
    if (typeof s.valor !== "string" || !s.valor) return `O segredo "${s.nome}" veio sem valor.`;
    if (nomes.has(s.nome)) return `O segredo "${s.nome}" foi declarado duas vezes.`;
    if (atribuicoes.has(s.valor)) continue;
    atribuicoes.set(s.valor, s.nome);
    nomes.add(s.nome);
  }
  const ocupados = new Set([...nomes, ...listarSegredos(home).map((s) => s.nome)]);
  let indice = 1;
  for (const texto of [campos.titulo, campos.gancho, campos.corpo]) {
    for (const valor of valoresSegredo(texto)) {
      if (atribuicoes.has(valor)) continue;
      let nome = nomeSegredoDerivado(rel, indice++);
      while (ocupados.has(nome)) nome = nomeSegredoDerivado(rel, indice++);
      ocupados.add(nome);
      atribuicoes.set(valor, nome);
    }
  }
  if (!atribuicoes.size) return { campos, guardados: [] };
  // Cofre antes do Markdown: se o cofre falhar, o texto puro não vai ao disco.
  for (const [valor, nome] of atribuicoes) gravarSegredo(home, nome, valor);
  return {
    campos: {
      titulo: substituirSegredos(campos.titulo, atribuicoes),
      gancho: substituirSegredos(campos.gancho, atribuicoes),
      tipo: campos.tipo,
      corpo: substituirSegredos(campos.corpo, atribuicoes),
    },
    guardados: [...atribuicoes.values()],
  };
}

function propor(home: string, p: PropostaMemoria): ResultadoProposta {
  if (!p || typeof p !== "object") return falha("Proposta inválida.");
  if (p.op !== "create" && p.op !== "update" && p.op !== "retire") return falha(`Operação "${String(p.op)}" inválida: use create, update ou retire.`);
  if (!ORIGENS_MEMORIA.includes(p.origem)) return falha(`Origem "${String(p.origem)}" inválida.`);
  const recusa = validarCaminhoMemoria(p.relPath);
  if (recusa) return falha(recusa);
  const rel = normalizarCaminho(p.relPath);

  const { diario } = reconciliar(home);
  const entrada = diario.entradas[rel];
  const agora = agoraIso();

  if (p.op === "create") {
    if (entrada || existsSync(caminhoAtivo(home, rel)) || existsSync(caminhoAposentado(home, rel))) {
      return falha(`Já existe uma memória em ${rel}${entrada?.status === "aposentada" ? " (aposentada)" : ""}: use update, ou outro caminho.`, entrada?.revisao);
    }
    const campos = montarCampos(p, rel);
    if (typeof campos === "string") return falha(campos);
    const limpo = guardarSegredos(home, rel, campos, p.segredos);
    if (typeof limpo === "string") return falha(limpo);
    const conteudo = montarArquivo(rel, limpo.campos);
    escreverAtomico(caminhoAtivo(home, rel), conteudo);
    diario.entradas[rel] = {
      revisao: 1,
      sha256: sha256(Buffer.from(conteudo, "utf8")),
      status: "ativa",
      titulo: limpo.campos.titulo,
      gancho: limpo.campos.gancho,
      tipo: limpo.campos.tipo,
      origem: p.origem,
      criadaEm: agora,
      atualizadaEm: agora,
    };
    gravarDiario(home, diario);
    gravarIndice(home, diario);
    return { ok: true, memoria: montarMemoria(home, rel, diario.entradas[rel]!), segredosGuardados: limpo.guardados };
  }

  if (!entrada || entrada.status !== "ativa") {
    return falha(`Não há memória ativa em ${rel}.`, entrada?.revisao);
  }
  if (typeof p.revisaoEsperada !== "number") {
    return falha(`${p.op} exige revisaoEsperada (a revisão atual de ${rel} é ${entrada.revisao}).`, entrada.revisao);
  }
  if (p.revisaoEsperada !== entrada.revisao) {
    return falha(`Revisão desatualizada: esperava ${p.revisaoEsperada}, a atual de ${rel} é ${entrada.revisao}. Releia a memória e proponha de novo.`, entrada.revisao);
  }

  if (p.op === "retire") {
    const destino = caminhoAposentado(home, rel);
    mkdirSync(dirname(destino), { recursive: true });
    rmSync(destino, { force: true });
    renameSync(caminhoAtivo(home, rel), destino);
    diario.entradas[rel] = { ...entrada, status: "aposentada", revisao: entrada.revisao + 1, origem: p.origem, atualizadaEm: agora };
    gravarDiario(home, diario);
    gravarIndice(home, diario);
    return { ok: true, memoria: montarMemoria(home, rel, diario.entradas[rel]!), segredosGuardados: [] };
  }

  // update
  const base = lerConteudo(readFileSync(caminhoAtivo(home, rel), "utf8"), rel);
  const campos = montarCampos(p, rel, base);
  if (typeof campos === "string") return falha(campos, entrada.revisao);
  const limpo = guardarSegredos(home, rel, campos, p.segredos);
  if (typeof limpo === "string") return falha(limpo, entrada.revisao);
  const conteudo = montarArquivo(rel, limpo.campos);
  escreverAtomico(caminhoAtivo(home, rel), conteudo);
  diario.entradas[rel] = {
    ...entrada,
    revisao: entrada.revisao + 1,
    sha256: sha256(Buffer.from(conteudo, "utf8")),
    titulo: limpo.campos.titulo,
    gancho: limpo.campos.gancho,
    tipo: limpo.campos.tipo,
    origem: p.origem,
    atualizadaEm: agora,
  };
  gravarDiario(home, diario);
  gravarIndice(home, diario);
  return { ok: true, memoria: montarMemoria(home, rel, diario.entradas[rel]!), segredosGuardados: limpo.guardados };
}

/**
 * Aplica uma proposta (create/update/retire). Síncrono; reconcilia antes e
 * regenera o MEMORY.md depois. update/retire exigem `revisaoEsperada`, e a
 * revisão errada volta `{ok:false, revisaoAtual}`. Nunca lança: falha de disco
 * ou de cofre vira `{ok:false, motivo}`.
 */
export function proporMemoria(home: string, p: PropostaMemoria): ResultadoProposta {
  try {
    return propor(home, p);
  } catch (e) {
    return falha(`Não consegui gravar a memória: ${e instanceof Error ? e.message : String(e)}`);
  }
}
