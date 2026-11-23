/**
 * Migração do MEMORIA.md legado (um arquivo corrido por projeto, escrito pelo
 * antigo agente "memória" depois de cada commit) para o acervo novo: um `.md`
 * por fato em `<home>/memorias/<slug-do-projeto>/`, e `geral/` para o chat
 * sem projeto.
 *
 * - Quem separa os fatos é o modelo (`rodar`), num protocolo de linhas próprio,
 *   fail-closed e com teto de 90 s. Resposta que não passa na validação, erro
 *   ou ausência de `rodar` caem no corte determinístico: um fato por seção `##`
 *   (sem seção, o arquivo inteiro vira `<slug>/memoria-legada.md`).
 * - O original só é renomeado para `MEMORIA.md.migrado` depois de TODAS as
 *   memórias dele terem sido criadas — é o backup e a marca de "já migrado".
 * - Idempotente: `.migrado` sem `MEMORIA.md` é pulado; os dois juntos também,
 *   com aviso. Uma memória idêntica já gravada (rodada anterior que parou no
 *   meio) é reaproveitada em vez de virar `-2`.
 * - Segredos saem do texto por `redigirSegredos` antes de qualquer escrita.
 *
 * Nunca lança: o que der errado vai para `erros`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { log } from "../log.ts";
import { globalMemoriaPath, memoriaRoot, statusDaMemoria } from "../memoria.ts";
import { projetosRoot } from "../projeto-dir.ts";
import { projetosConhecidos } from "../threads.ts";
import { TIPO_PADRAO, TIPOS_MEMORIA } from "./arquivo.ts";
import { lerMemoria, proporMemoria } from "./nucleo.ts";
import { redigirSegredos } from "./segredos.ts";

export type RodarModelo = (prompt: string, ctx: { home: string; modelo: string; tetoMs: number }) => Promise<string>;

export interface ResultadoMigracao {
  migrados: { origem: string; criadas: string[] }[];
  pulados: string[];
  erros: string[];
}

export interface DepsMigracao {
  rodar?: RodarModelo;
  modelo?: string;
  listarProjetos?: () => { nome: string; projectPath: string }[];
}

/** Teto do modelo por arquivo: passou disso, vale o corte por `##`. */
export const TETO_MIGRACAO_MS = 90_000;
export const MODELO_MIGRACAO_PADRAO = "haiku";
export const SUFIXO_MIGRADO = ".migrado";
export const PASTA_GERAL = "geral";
const ARQUIVO_LEGADO = "MEMORIA.md";
const SLUG_LEGADO = "memoria-legada";
const SLUG_MAX = 60;
const GANCHO_MAX = 160;
const RESERVADOS = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export interface FatoLegado {
  slug: string;
  titulo: string;
  gancho: string;
  tipo: string;
  corpo: string;
}

interface Fonte {
  caminho: string;
  pasta: string;
}

/** kebab-case aceito por `validarCaminhoMemoria`: minúsculas, números, hífen. */
export function slugMemoria(texto: string, padrao = "fato"): string {
  const s = String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  if (!s) return padrao;
  return RESERVADOS.test(s) ? `${s}-${padrao}` : s;
}

/** Tira os carimbos `<!-- commit: ... -->` que o agente antigo deixava. */
function semCarimbos(texto: string): string {
  return texto
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*<!--\s*commit:.*-->\s*$/i.test(l))
    .join("\n")
    .trim();
}

function primeiraLinhaUtil(texto: string): string {
  for (const bruta of texto.split("\n")) {
    const l = bruta
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^#+\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (l) return l.length > GANCHO_MAX ? l.slice(0, GANCHO_MAX - 1).trimEnd() + "…" : l;
  }
  return "";
}

/**
 * Corte determinístico: um fato por seção `##`. O que vem antes da primeira
 * seção (fora o `# Título`) vira `memoria-legada`; sem seção nenhuma, o
 * arquivo inteiro vira um fato só.
 */
export function cortarPorSecoes(texto: string, rotulo = "Memória legada"): FatoLegado[] {
  const limpo = semCarimbos(texto);
  if (!limpo) return [];
  const linhas = limpo.split("\n");
  let tituloH1 = "";
  const preambulo: string[] = [];
  const secoes: { titulo: string; linhas: string[] }[] = [];
  for (const linha of linhas) {
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(linha);
    if (h2) {
      secoes.push({ titulo: h2[1]!.trim(), linhas: [] });
      continue;
    }
    if (secoes.length) {
      secoes[secoes.length - 1]!.linhas.push(linha);
      continue;
    }
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(linha);
    if (h1 && !tituloH1 && !preambulo.some((l) => l.trim())) {
      tituloH1 = h1[1]!.trim();
      continue;
    }
    preambulo.push(linha);
  }
  const fatos: FatoLegado[] = [];
  const pre = preambulo.join("\n").trim();
  if (!secoes.length) {
    const titulo = tituloH1 || rotulo;
    if (!pre) return [];
    return [{ slug: SLUG_LEGADO, titulo, gancho: primeiraLinhaUtil(pre) || titulo, tipo: TIPO_PADRAO, corpo: pre }];
  }
  if (pre) {
    const titulo = tituloH1 || rotulo;
    fatos.push({ slug: SLUG_LEGADO, titulo, gancho: primeiraLinhaUtil(pre) || titulo, tipo: TIPO_PADRAO, corpo: pre });
  }
  for (const s of secoes) {
    const corpo = s.linhas.join("\n").trim();
    if (!corpo) continue;
    fatos.push({ slug: slugMemoria(s.titulo), titulo: s.titulo, gancho: primeiraLinhaUtil(corpo) || s.titulo, tipo: TIPO_PADRAO, corpo });
  }
  return fatos;
}

export function promptDeMigracao(texto: string, rotulo: string): string {
  return [
    `Você vai separar a memória legada de "${rotulo}" em fatos independentes, um por assunto.`,
    "Responda SÓ com blocos neste formato exato, um por fato, sem nada antes, entre ou depois:",
    "",
    "=== FATO",
    `tipo: <um de: ${TIPOS_MEMORIA.join(", ")}>`,
    "arquivo: <nome-em-kebab-case, sem .md>",
    "titulo: <título curto, uma linha>",
    "gancho: <uma linha dizendo quando esse fato serve>",
    "corpo:",
    "<texto do fato em Markdown, várias linhas, sem inventar nada além do original>",
    "=== FIM",
    "",
    "Regras: não perca informação; não invente; mantenha comandos, caminhos e nomes como estão;",
    "ignore linhas `<!-- commit: ... -->`; na dúvida do tipo, use conhecimento.",
    "",
    "Memória legada:",
    "<<<",
    texto,
    ">>>",
  ].join("\n");
}

/**
 * Lê a resposta do modelo. Fail-closed: qualquer bloco malformado, tipo fora da
 * lista, campo vazio, texto solto entre blocos ou corte que perde demais do
 * original invalida a resposta INTEIRA (→ `undefined`, corte por `##`).
 */
export function lerRespostaDoModelo(resposta: string, original: string): FatoLegado[] | undefined {
  if (typeof resposta !== "string" || !resposta.trim()) return undefined;
  const linhas = resposta.replace(/\r\n/g, "\n").split("\n");
  const fatos: FatoLegado[] = [];
  let i = 0;
  while (i < linhas.length) {
    const linha = linhas[i]!.trim();
    if (!linha || /^```\w*$/.test(linha)) {
      i++;
      continue;
    }
    if (linha !== "=== FATO") return undefined;
    i++;
    const campos: Record<string, string> = {};
    for (const nome of ["tipo", "arquivo", "titulo", "gancho"]) {
      const m = new RegExp(`^${nome}:\\s*(.*)$`, "i").exec((linhas[i] ?? "").trim());
      if (!m || !m[1]!.trim()) return undefined;
      campos[nome] = m[1]!.trim();
      i++;
    }
    if (!/^corpo:\s*$/i.test((linhas[i] ?? "").trim())) return undefined;
    i++;
    const corpo: string[] = [];
    while (i < linhas.length && linhas[i]!.trim() !== "=== FIM") {
      if (linhas[i]!.trim() === "=== FATO") return undefined;
      corpo.push(linhas[i]!);
      i++;
    }
    if (i >= linhas.length) return undefined;
    i++;
    const tipo = campos.tipo!.toLowerCase();
    if (!(TIPOS_MEMORIA as readonly string[]).includes(tipo)) return undefined;
    const texto = corpo.join("\n").trim();
    if (!texto) return undefined;
    const slug = slugMemoria(campos.arquivo!.replace(/\.md$/i, ""), "");
    if (!slug) return undefined;
    fatos.push({ slug, titulo: campos.titulo!, gancho: campos.gancho!, tipo, corpo: texto });
  }
  if (!fatos.length) return undefined;
  // Modelo que "resume" a memória a quase nada perde fato: melhor o corte burro.
  const tamanhoOriginal = semCarimbos(original).replace(/\s+/g, "").length;
  const tamanhoFatos = fatos.reduce((n, f) => n + f.corpo.replace(/\s+/g, "").length, 0);
  if (tamanhoOriginal > 0 && tamanhoFatos < tamanhoOriginal * 0.25) return undefined;
  return fatos;
}

async function comTeto<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rejeitar) => {
        timer = setTimeout(() => rejeitar(new Error(`teto de ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function separarFatos(home: string, texto: string, rotulo: string, deps: DepsMigracao): Promise<{ fatos: FatoLegado[]; viaModelo: boolean }> {
  if (deps.rodar) {
    try {
      const resposta = await comTeto(
        Promise.resolve().then(() =>
          deps.rodar!(promptDeMigracao(semCarimbos(texto), rotulo), { home, modelo: deps.modelo || MODELO_MIGRACAO_PADRAO, tetoMs: TETO_MIGRACAO_MS }),
        ),
        TETO_MIGRACAO_MS,
      );
      const fatos = lerRespostaDoModelo(resposta, texto);
      if (fatos) return { fatos, viaModelo: true };
      log.aviso("app", `migração de memória: resposta do modelo inválida para ${rotulo}, usando o corte por seções`);
    } catch (e) {
      log.aviso("app", `migração de memória: modelo falhou para ${rotulo}, usando o corte por seções`, { erro: e instanceof Error ? e.message : String(e) });
    }
  }
  return { fatos: cortarPorSecoes(texto, rotulo), viaModelo: false };
}

const mesmoTexto = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();

/** Cria um fato em `<pasta>/<slug>.md`, com `-2`, `-3`… se o caminho já estiver ocupado por outra coisa. */
function gravarFato(home: string, pasta: string, fato: FatoLegado): { ok: true; relPath: string } | { ok: false; motivo: string } {
  for (let n = 1; n <= 200; n++) {
    const relPath = `${pasta}/${n === 1 ? fato.slug : `${fato.slug}-${n}`}.md`;
    // Corpo redigido aqui (nomes `<relPath>.N`); título e gancho o núcleo varre
    // e redige com nomes que não pisam nestes.
    const red = redigirSegredos(fato.corpo, relPath);
    const existente = lerMemoria(home, relPath);
    if (existente) {
      // Rodada anterior que parou no meio já gravou este mesmo fato: reaproveita.
      if (existente.status === "ativa" && existente.origem === "migracao" && mesmoTexto(existente.corpo, red.texto)) return { ok: true, relPath };
      continue;
    }
    const r = proporMemoria(home, {
      op: "create",
      relPath,
      titulo: fato.titulo,
      gancho: fato.gancho,
      tipo: fato.tipo,
      corpo: red.texto,
      segredos: red.segredos.length ? red.segredos : undefined,
      origem: "migracao",
    });
    if (r.ok) return { ok: true, relPath };
    if (/^Já existe uma memória/.test(r.motivo)) continue;
    return { ok: false, motivo: r.motivo };
  }
  return { ok: false, motivo: `sem caminho livre para ${pasta}/${fato.slug}.md` };
}

function lerMetaProjeto(dir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { projectPath?: unknown };
    return typeof meta.projectPath === "string" && meta.projectPath ? meta.projectPath : undefined;
  } catch {
    return undefined;
  }
}

function subpastas(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

const temLegado = (caminho: string) => existsSync(caminho) || existsSync(caminho + SUFIXO_MIGRADO);

/**
 * Todo MEMORIA.md legado que dá pra achar: dos projetos conhecidos, das pastas
 * de projeto órfãs em `projetosRoot`, do layout antigo por hash e o do chat
 * geral. Um mesmo arquivo aparece uma vez só.
 */
function acharFontes(home: string, deps: DepsMigracao, erros: string[]): Fonte[] {
  const fontes = new Map<string, Fonte>();
  const somar = (caminho: string, pasta: string) => {
    const chave = resolve(caminho).toLowerCase();
    if (!fontes.has(chave) && temLegado(caminho)) fontes.set(chave, { caminho, pasta });
  };
  try {
    const projetos = deps.listarProjetos ? deps.listarProjetos() : projetosConhecidos(home).map((p) => ({ nome: basename(p), projectPath: p }));
    for (const p of projetos) {
      try {
        somar(statusDaMemoria(p.projectPath, home).caminho, slugMemoria(p.nome || basename(p.projectPath), "projeto"));
      } catch (e) {
        erros.push(`${p.projectPath}: não achei a memória (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  } catch (e) {
    erros.push(`lista de projetos: ${e instanceof Error ? e.message : String(e)}`);
  }
  const varrer = (raiz: string, pastaMemoria: boolean) => {
    for (const dir of subpastas(raiz)) {
      const caminho = pastaMemoria ? join(dir, "memoria", ARQUIVO_LEGADO) : join(dir, ARQUIVO_LEGADO);
      const projectPath = lerMetaProjeto(dir);
      if (!pastaMemoria && !projectPath) continue;
      somar(caminho, slugMemoria(projectPath ? basename(projectPath) : basename(dir), "projeto"));
    }
  };
  try {
    varrer(projetosRoot(home), true);
  } catch (e) {
    erros.push(`pasta de projetos: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    varrer(memoriaRoot(home), false);
  } catch (e) {
    erros.push(`memória legada por hash: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    somar(globalMemoriaPath(home), PASTA_GERAL);
  } catch (e) {
    erros.push(`memória geral: ${e instanceof Error ? e.message : String(e)}`);
  }
  return [...fontes.values()];
}

async function migrarFonte(home: string, fonte: Fonte, deps: DepsMigracao, r: ResultadoMigracao): Promise<void> {
  const { caminho, pasta } = fonte;
  const migrado = caminho + SUFIXO_MIGRADO;
  const existe = existsSync(caminho);
  if (!existe) {
    if (existsSync(migrado)) r.pulados.push(`${caminho}: já migrado`);
    return;
  }
  if (existsSync(migrado)) {
    log.aviso("app", `migração de memória: ${caminho} e ${basename(migrado)} existem juntos; nada foi mexido`);
    r.pulados.push(`${caminho}: já existe ${basename(migrado)} ao lado; confira e apague um dos dois`);
    return;
  }
  let texto: string;
  try {
    if (!statSync(caminho).isFile()) {
      r.pulados.push(`${caminho}: não é arquivo`);
      return;
    }
    texto = readFileSync(caminho, "utf8");
  } catch (e) {
    r.erros.push(`${caminho}: não consegui ler (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (!semCarimbos(texto)) {
    r.pulados.push(`${caminho}: vazio`);
    return;
  }
  const rotulo = pasta === PASTA_GERAL ? "chat geral" : pasta;
  const { fatos } = await separarFatos(home, texto, rotulo, deps);
  if (!fatos.length) {
    r.pulados.push(`${caminho}: sem fato aproveitável`);
    return;
  }
  const criadas: string[] = [];
  let falhou = false;
  for (const fato of fatos) {
    const g = gravarFato(home, pasta, fato);
    if (g.ok) {
      if (!criadas.includes(g.relPath)) criadas.push(g.relPath);
    } else {
      falhou = true;
      r.erros.push(`${caminho}: ${fato.slug}: ${g.motivo}`);
    }
  }
  if (falhou) return;
  try {
    renameSync(caminho, migrado);
  } catch (e) {
    r.erros.push(`${caminho}: memórias criadas, mas não consegui renomear para ${basename(migrado)} (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  r.migrados.push({ origem: caminho, criadas });
  log.info("app", `migração de memória: ${caminho} → ${criadas.length} memória(s) em ${pasta}/`);
}

/** Converte os MEMORIA.md legados em memórias novas. Nunca lança. */
export async function migrarMemoriaLegada(home: string, deps: DepsMigracao = {}): Promise<ResultadoMigracao> {
  const r: ResultadoMigracao = { migrados: [], pulados: [], erros: [] };
  try {
    for (const fonte of acharFontes(home, deps ?? {}, r.erros)) {
      try {
        await migrarFonte(home, fonte, deps ?? {}, r);
      } catch (e) {
        r.erros.push(`${fonte.caminho}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    r.erros.push(e instanceof Error ? e.message : String(e));
  }
  return r;
}
