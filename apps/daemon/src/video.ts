import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dsDoProjeto, estadoDs, lerSistema, type DsCompleto } from "./design-system.ts";
import { codigoDoErro, log } from "./log.ts";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";

/**
 * Painel de VÍDEO do Canvas (plano-20260928-1230). Mesmo padrão do painel de mocks: herda tokens e
 * DESIGN.md do DS oficial, não vira DS nem edita tokens. Cada cena é um card HTML; a ordem, as
 * transições e a trilha de áudio ficam no `meta.json` do vídeo; o motor (Hyperframes, ver
 * video-motor.ts) renderiza a composição que `comporVideo` monta.
 *
 * Onde mora: `<projectDir>/videos/<id>/`
 *   meta.json             nome, formato, ordem das cenas, transições, áudio (sincroniza)
 *   cenas/<cena>.html     fragmento da cena: <style> + marcação + <script> opcional (sincroniza)
 *   audio/<arquivo>       música própria que a pessoa trouxe + batidas calculadas (sincroniza)
 *   render/               DERIVADO: composição montada, MP4, capa, snapshots — nunca sincroniza
 *                         (`sincronizavel` barra; outra máquina renderiza de novo)
 *
 * Contrato da cena (o que o agente escreve): fragmento sem <html>/<body>. `<style>` e marcação
 * como num card do DS (só var(--token)); `<script>` opcional recebe `tl` (timeline GSAP pausada
 * da cena, tempo LOCAL: 0 = início da cena) e `cena` (o elemento raiz). Regras do Hyperframes:
 * determinístico (sem Date.now/Math.random/rede), `tl.fromTo`, nada de setTimeout. O Hyperframes
 * escopa CSS e seletor por cena (sub-composition), então `.titulo` numa cena não pega na outra.
 */

export const HYPERFRAMES_VERSAO = "0.8.82";
export const GSAP_VERSAO = "3.14.2";

export type Formato = "16:9" | "9:16" | "1:1";
export const FORMATOS: Record<Formato, { largura: number; altura: number }> = {
  "16:9": { largura: 1920, altura: 1080 },
  "9:16": { largura: 1080, altura: 1920 },
  "1:1": { largura: 1080, altura: 1080 },
};

export type TipoTransicao = "corte" | "fade" | "fundo" | "deslizar-esq" | "deslizar-cima" | "mascara" | "personalizada";
export const TIPOS_TRANSICAO: TipoTransicao[] = ["corte", "fade", "fundo", "deslizar-esq", "deslizar-cima", "mascara", "personalizada"];
export const NOMES_TRANSICAO: Record<TipoTransicao, string> = {
  corte: "Corte",
  fade: "Fade",
  fundo: "Pelo fundo",
  "deslizar-esq": "Deslizar ←",
  "deslizar-cima": "Deslizar ↑",
  mascara: "Máscara circular",
  personalizada: "Personalizada",
};

export type Cena = {
  id: string;
  nome: string;
  /** segundos */
  duracao: number;
  /** Tela do DS de onde a cena foi COPIADA (só informativo: sem vínculo com a original). */
  origem?: { sistema: string; card: string; titulo: string };
};

export type Transicao = {
  de: string;
  para: string;
  tipo: TipoTransicao;
  duracao: number;
  /** Só `personalizada`: nome curto ("Giro + logo") e o corpo JS que recebe (tl, a, b, inicio, duracao). */
  nome?: string;
  codigo?: string;
  prompt?: string;
  /** Um passo de desfazer: o que estava antes da última troca. */
  anterior?: Omit<Transicao, "anterior" | "de" | "para">;
};

export type Musica = {
  /** `nexos:<arquivo sem .mp3>` (vem com o Nexos) ou `propria:<arquivo>` (em audio/) */
  fonte: string;
  nome: string;
  volume: number;
  /** segundos; das músicas do Nexos vem do arquivo de batidas */
  duracao?: number;
  /** música mais curta que o vídeo: repete (true) ou deixa silêncio no fim (false, padrão) */
  repetir?: boolean;
};

export type Efeito = {
  id: string;
  /** Cena dona do efeito: o tempo é relativo ao início dela e o efeito anda junto. */
  cena: string;
  t: number;
  /** caminho dentro de video-assets/efeitos (ex.: impact/impactSoft_medium_001.ogg) */
  arquivo: string;
  volume: number;
  rotulo: string;
};

export type MetaVideo = {
  id: string;
  nome: string;
  formato: Formato;
  criadoEm: string;
  cenas: Cena[];
  transicoes: Transicao[];
  audio: { musica: Musica | null; efeitos: Efeito[] };
  /** Texto pra postar (skill nexo-video); o crédito da música entra sozinho no fim. */
  textoPost?: string;
  /** Tempo (s) da capa escolhida pela skill: o melhor frame já assentado, não o frame 0. */
  capaEm?: number;
};

export type Linha = {
  cenas: { id: string; inicio: number; duracao: number; fim: number }[];
  transicoes: (Transicao & { inicio: number; maximo: number })[];
  total: number;
};

export type VideoResumo = { id: string; nome: string; formato: Formato; cenas: number; total: number };

export type VideoCompleto = MetaVideo & {
  pastaAbs: string;
  projetoAbs: string;
  linha: Linha;
  html: Record<string, string>;
  /** DS de onde vêm os tokens (o oficial do projeto), ou null se o projeto não tem DS. */
  ds: { id: string; nome: string } | null;
  render: InfoRender | null;
  creditos: string[];
};

export type InfoRender = {
  arquivo: string;
  caminho: string;
  bytes: number;
  duracao: number;
  qualidade: string;
  em: string;
  capa?: string;
};

function erro(msg: string, status = 400): Error {
  return Object.assign(new Error(msg), { status });
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ARQ_RE = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,120}$/;

/** Mudanças no disco de um vídeo, por projeto: o SSE do painel escuta aqui. */
export const videoBus = new EventEmitter();
videoBus.setMaxListeners(0);
export function canalVideo(projectPath: string): string {
  return `video:${resolve(projectPath).toLowerCase()}`;
}
export function avisarVideo(projectPath: string, ev: Record<string, unknown>): void {
  videoBus.emit(canalVideo(projectPath), ev);
}

/* ---------------------------------------------------------------------------
 * Assets que vêm com o Nexos (músicas ende.app, efeitos Kenney, GSAP, fontes)
 * ------------------------------------------------------------------------- */

/** `src/` e `dist/` ficam na mesma profundidade: `../video-assets` vale nos dois. */
export function pastaDeAssets(): string {
  const aqui = dirname(fileURLToPath(import.meta.url));
  return process.env.NEXOS_VIDEO_ASSETS || join(aqui, "..", "video-assets");
}

export const CREDITO_MUSICA = "Music: ende.app (CC BY 4.0)";

export type MusicaDoNexos = { fonte: string; nome: string; arquivo: string; bpm: number; duracao: number };

function lerJson<T>(caminho: string): T | null {
  try {
    return JSON.parse(readFileSync(caminho, "utf8")) as T;
  } catch (e) {
    if (codigoDoErro(e) !== "ENOENT") log.avisoUmaVez(`video-json:${caminho}`, "video", `não consegui ler ${caminho}`, { erro: (e as Error).message });
    return null;
  }
}

type Cues = { duration?: number; tempo?: number; beats?: { time: number; intensity?: number }[]; strongCues?: { time: number }[] };

export function musicasDoNexos(): MusicaDoNexos[] {
  const pasta = join(pastaDeAssets(), "musicas");
  let arquivos: string[] = [];
  try {
    arquivos = readdirSync(pasta).filter((f) => f.endsWith(".mp3"));
  } catch (e) {
    log.avisoUmaVez(`video-musicas:${pasta}`, "video", `as músicas do Nexos não estão em ${pasta}`, { erro: (e as Error).message });
    return [];
  }
  return arquivos
    .map((f) => {
      const stem = f.slice(0, -4);
      const cues = lerJson<Cues>(join(pasta, `${stem}.music-cues.json`));
      const vol = /vol-(\d+)/.exec(stem)?.[1] ?? "";
      return {
        fonte: `nexos:${stem}`,
        nome: `Happy Beats vol. ${vol}`,
        arquivo: join(pasta, f),
        bpm: Math.round(cues?.tempo ?? 0),
        duracao: cues?.duration ?? 0,
      };
    })
    .sort((a, b) => Number(/\d+/.exec(a.nome)?.[0]) - Number(/\d+/.exec(b.nome)?.[0]));
}

export type Batida = { t: number; forca: number; forte?: boolean };

/** Batidas da música do vídeo: pré-calculadas (Nexos) ou do `hyperframes beats` (própria). */
export function batidasDaMusica(projectPath: string, home: string, videoId: string, m: Musica | null): Batida[] {
  if (!m) return [];
  if (m.fonte.startsWith("nexos:")) {
    const stem = m.fonte.slice(6);
    if (!ID_ARQ_MUSICA.test(stem)) return [];
    const cues = lerJson<Cues>(join(pastaDeAssets(), "musicas", `${stem}.music-cues.json`));
    const fortes = new Set((cues?.strongCues ?? []).map((c) => c.time));
    return (cues?.beats ?? []).map((b) => ({ t: b.time, forca: b.intensity ?? 0.5, ...(fortes.has(b.time) ? { forte: true } : {}) }));
  }
  const arq = m.fonte.slice(8);
  const beats = lerJson<{ beats?: { time: number; strength?: number }[] }>(join(pastaDoVideo(projectPath, home, videoId, false), "audio", `${arq}.beats.json`));
  const lista = beats?.beats ?? [];
  // `hyperframes beats` não marca as fortes: as 15% de maior força fazem esse papel
  const corte = [...lista].map((b) => b.strength ?? 0).sort((a, b) => b - a)[Math.floor(lista.length * 0.15)] ?? 1;
  return lista.map((b) => ({ t: b.time, forca: b.strength ?? 0.5, ...((b.strength ?? 0) >= corte ? { forte: true } : {}) }));
}
const ID_ARQ_MUSICA = /^[a-z0-9-]+$/;

/** Tolerância do encaixe na batida (spec da trilha: ≤ 0,15 s). */
export const ENCAIXE_S = 0.15;
export function encaixarNaBatida(t: number, batidas: Batida[], tol = ENCAIXE_S): { t: number; naBatida: boolean } {
  let melhor: number | null = null;
  for (const b of batidas) if (Math.abs(b.t - t) <= tol && (melhor === null || Math.abs(b.t - t) < Math.abs(melhor - t))) melhor = b.t;
  return melhor === null ? { t, naBatida: false } : { t: Math.round(melhor * 1000) / 1000, naBatida: true };
}

/* ---------------------------------------------------------------------------
 * Pastas e meta
 * ------------------------------------------------------------------------- */

function raizVideos(projectPath: string, home: string, criar: boolean): string {
  return join(criar ? projectDir(projectPath, home) : projectDirSemCriar(projectPath, home), "videos");
}

export function pastaDoVideo(projectPath: string, home: string, id: string, criar: boolean): string {
  if (!ID_RE.test(id)) throw erro("id de vídeo inválido");
  return join(raizVideos(projectPath, home, criar), id);
}

function escreverAtomico(caminho: string, conteudo: string | Buffer): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = `${caminho}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, conteudo);
  renameSync(tmp, caminho);
}

function num(v: unknown, padrao: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.round(n * 1000) / 1000));
}

function ehFormato(v: unknown): v is Formato {
  return v === "16:9" || v === "9:16" || v === "1:1";
}

function normalizarMeta(bruto: Partial<MetaVideo>, id: string): MetaVideo {
  const cenas = (Array.isArray(bruto.cenas) ? bruto.cenas : [])
    .filter((c): c is Cena => !!c && typeof c.id === "string" && ID_RE.test(c.id))
    .map((c) => ({
      id: c.id,
      nome: typeof c.nome === "string" && c.nome.trim() ? c.nome.trim() : c.id,
      duracao: num(c.duracao, 3, 0.2, 120),
      ...(c.origem && typeof c.origem.sistema === "string" && typeof c.origem.card === "string"
        ? { origem: { sistema: c.origem.sistema, card: c.origem.card, titulo: String(c.origem.titulo ?? c.origem.card) } }
        : {}),
    }));
  const transicoes = (Array.isArray(bruto.transicoes) ? bruto.transicoes : []).filter(
    (t): t is Transicao => !!t && typeof t.de === "string" && typeof t.para === "string" && TIPOS_TRANSICAO.includes(t.tipo),
  );
  const a = bruto.audio && typeof bruto.audio === "object" ? bruto.audio : { musica: null, efeitos: [] };
  const musica =
    a.musica && typeof a.musica.fonte === "string"
      ? { ...a.musica, volume: num(a.musica.volume, 0.35, 0, 1), nome: String(a.musica.nome ?? a.musica.fonte) }
      : null;
  const efeitos = (Array.isArray(a.efeitos) ? a.efeitos : []).filter(
    (e): e is Efeito => !!e && typeof e.id === "string" && typeof e.cena === "string" && typeof e.arquivo === "string",
  );
  return {
    id,
    nome: typeof bruto.nome === "string" && bruto.nome.trim() ? bruto.nome.trim() : id,
    formato: ehFormato(bruto.formato) ? bruto.formato : "16:9",
    criadoEm: typeof bruto.criadoEm === "string" ? bruto.criadoEm : new Date().toISOString(),
    cenas,
    transicoes,
    audio: { musica, efeitos },
    ...(typeof bruto.textoPost === "string" && bruto.textoPost ? { textoPost: bruto.textoPost } : {}),
    ...(typeof bruto.capaEm === "number" ? { capaEm: bruto.capaEm } : {}),
  };
}

export function lerMeta(projectPath: string, home: string, id: string): MetaVideo {
  const pasta = pastaDoVideo(projectPath, home, id, false);
  const bruto = lerJson<Partial<MetaVideo>>(join(pasta, "meta.json"));
  if (!bruto) throw erro(`o vídeo ${id} não existe`, 404);
  return normalizarMeta(bruto, id);
}

function gravarMeta(projectPath: string, home: string, meta: MetaVideo): void {
  const pasta = pastaDoVideo(projectPath, home, meta.id, true);
  escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  avisarVideo(projectPath, { type: "video-mudou", id: meta.id });
}

export function listarVideos(projectPath: string, home: string): VideoResumo[] {
  const raiz = raizVideos(projectPath, home, false);
  let ids: string[] = [];
  try {
    ids = readdirSync(raiz).filter((d) => ID_RE.test(d) && existsSync(join(raiz, d, "meta.json")));
  } catch (e) {
    if (codigoDoErro(e) !== "ENOENT") log.avisoUmaVez(`video-lista:${raiz}`, "video", `não consegui listar ${raiz}`, { erro: (e as Error).message });
    return [];
  }
  return ids
    .map((id) => {
      try {
        const m = lerMeta(projectPath, home, id);
        return { id, nome: m.nome, formato: m.formato, cenas: m.cenas.length, total: linhaDoTempo(m).total, criadoEm: m.criadoEm };
      } catch {
        return null;
      }
    })
    .filter((v): v is VideoResumo & { criadoEm: string } => !!v)
    .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm))
    .map(({ criadoEm: _c, ...v }) => v);
}

function slug(texto: string): string {
  return (
    texto
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "video"
  );
}

function idLivre(base: string, existe: (id: string) => boolean): string {
  let id = slug(base);
  for (let n = 2; existe(id); n++) id = `${slug(base).slice(0, 44)}-${n}`;
  return id;
}

export function criarVideo(projectPath: string, home: string, input: { nome?: unknown; formato?: unknown }): MetaVideo {
  const nome = typeof input.nome === "string" && input.nome.trim() ? input.nome.trim().slice(0, 120) : "Vídeo";
  const raiz = raizVideos(projectPath, home, true);
  const id = idLivre(nome, (x) => existsSync(join(raiz, x)));
  const meta = normalizarMeta({ nome, formato: ehFormato(input.formato) ? input.formato : "16:9", cenas: [], transicoes: [] }, id);
  mkdirSync(join(raiz, id, "cenas"), { recursive: true });
  gravarMeta(projectPath, home, meta);
  return meta;
}

export function apagarVideo(projectPath: string, home: string, id: string): void {
  const pasta = pastaDoVideo(projectPath, home, id, false);
  if (!existsSync(join(pasta, "meta.json"))) throw erro(`o vídeo ${id} não existe`, 404);
  rmSync(pasta, { recursive: true, force: true });
  avisarVideo(projectPath, { type: "video-mudou", id, apagado: true });
}

/* ---------------------------------------------------------------------------
 * Linha do tempo: transição SOBREPÕE as cenas (decisão "Transição sobrepõe as cenas")
 * ------------------------------------------------------------------------- */

/** Máximo de uma transição: metade da cena mais curta das duas, arredondado pra baixo em 0,1 s. */
export function maximoDaTransicao(durA: number, durB: number): number {
  return Math.floor((Math.min(durA, durB) / 2) * 10 + 1e-9) / 10;
}

export function transicaoEntre(meta: MetaVideo, de: string, para: string): Transicao | undefined {
  return meta.transicoes.find((t) => t.de === de && t.para === para);
}

export function linhaDoTempo(meta: MetaVideo): Linha {
  const cenas: Linha["cenas"] = [];
  const transicoes: Linha["transicoes"] = [];
  let cursor = 0;
  meta.cenas.forEach((c, i) => {
    const ant = meta.cenas[i - 1];
    let inicio = cursor;
    if (ant) {
      const t = transicaoEntre(meta, ant.id, c.id);
      const maximo = maximoDaTransicao(ant.duracao, c.duracao);
      if (t && t.tipo !== "corte") {
        const d = Math.min(t.duracao, maximo);
        inicio = Math.round((cursor - d) * 1000) / 1000;
        transicoes.push({ ...t, duracao: d, inicio, maximo });
      } else {
        transicoes.push({ ...(t ?? { de: ant.id, para: c.id, tipo: "corte" as const }), duracao: 0, inicio, maximo });
      }
    }
    const fim = Math.round((inicio + c.duracao) * 1000) / 1000;
    cenas.push({ id: c.id, inicio, duracao: c.duracao, fim });
    cursor = fim;
  });
  return { cenas, transicoes, total: Math.round(cursor * 1000) / 1000 };
}

/* ---------------------------------------------------------------------------
 * Cenas
 * ------------------------------------------------------------------------- */

function arquivoDaCena(projectPath: string, home: string, videoId: string, cenaId: string, criar = false): string {
  if (!ID_RE.test(cenaId)) throw erro("id de cena inválido");
  return join(pastaDoVideo(projectPath, home, videoId, criar), "cenas", `${cenaId}.html`);
}

export function htmlDaCena(projectPath: string, home: string, videoId: string, cenaId: string): string {
  try {
    return readFileSync(arquivoDaCena(projectPath, home, videoId, cenaId), "utf8");
  } catch (e) {
    if (codigoDoErro(e) !== "ENOENT") log.aviso("video", `não consegui ler a cena ${cenaId} de ${videoId}`, { erro: (e as Error).message });
    return "";
  }
}

/** Problemas da cena que quebram o render — o resto o `hyperframes check` pega. */
export function lintCena(html: string): string[] {
  const out: string[] = [];
  if (/<\/?(html|head|body)\b/i.test(html)) out.push("a cena é um fragmento: tire <html>, <head> e <body>");
  if (/<script[^>]+\bsrc\s*=/i.test(html)) out.push("<script src> não: o GSAP já vem carregado e rede não entra no render");
  if (/\b(Date\.now|Math\.random|new Date\(|performance\.now|setTimeout|setInterval|fetch\()/.test(scriptsDe(html).join("\n"))) {
    out.push("script da cena precisa ser determinístico: sem Date.now, Math.random, timers ou fetch (use a timeline `tl`)");
  }
  if (/(src|href)\s*=\s*["']https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html)) out.push("nada de URL externa: imagem/fonte de rede não entra no render");
  if (/<audio\b(?![^>]*\bid=)/i.test(html)) out.push("<audio> sem id sai mudo no render — dê um id (ou use a trilha de áudio do painel)");
  return out;
}

export function salvarCena(
  projectPath: string,
  home: string,
  videoId: string,
  input: { id?: unknown; nome?: unknown; duracao?: unknown; html?: unknown; posicao?: unknown; origem?: Cena["origem"] },
): { meta: MetaVideo; cena: Cena; avisos: string[] } {
  const meta = lerMeta(projectPath, home, videoId);
  const idPedido = typeof input.id === "string" ? input.id.trim() : "";
  let cena = idPedido ? meta.cenas.find((c) => c.id === idPedido) : undefined;
  const avisos: string[] = [];
  if (!cena) {
    const nome = typeof input.nome === "string" && input.nome.trim() ? input.nome.trim().slice(0, 80) : `Cena ${meta.cenas.length + 1}`;
    const id = idPedido && ID_RE.test(idPedido) ? idPedido : idLivre(nome, (x) => meta.cenas.some((c) => c.id === x));
    cena = { id, nome, duracao: num(input.duracao, 3, 0.2, 120), ...(input.origem ? { origem: input.origem } : {}) };
    const pos = typeof input.posicao === "number" ? Math.max(0, Math.min(meta.cenas.length, Math.floor(input.posicao))) : meta.cenas.length;
    meta.cenas.splice(pos, 0, cena);
    if (typeof input.html !== "string") input = { ...input, html: "" };
  } else {
    if (typeof input.nome === "string" && input.nome.trim()) cena.nome = input.nome.trim().slice(0, 80);
    if (input.duracao !== undefined) cena.duracao = num(input.duracao, cena.duracao, 0.2, 120);
    if (typeof input.posicao === "number") {
      meta.cenas = meta.cenas.filter((c) => c.id !== cena!.id);
      meta.cenas.splice(Math.max(0, Math.min(meta.cenas.length, Math.floor(input.posicao))), 0, cena);
    }
  }
  if (typeof input.html === "string") {
    avisos.push(...lintCena(input.html));
    escreverAtomico(arquivoDaCena(projectPath, home, videoId, cena.id, true), input.html);
  }
  // transição que passou do limite com a duração nova fica limitada na linha do tempo; avisa
  for (const t of linhaDoTempo(meta).transicoes) {
    const bruta = transicaoEntre(meta, t.de, t.para);
    if (bruta && bruta.tipo !== "corte" && bruta.duracao > t.maximo) avisos.push(`transição ${t.de} → ${t.para} limitada a ${fmtS(t.maximo)} (metade da cena mais curta)`);
  }
  gravarMeta(projectPath, home, meta);
  return { meta, cena, avisos };
}

export function fmtS(s: number): string {
  return `${(Math.round(s * 10) / 10).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

export function apagarCena(projectPath: string, home: string, videoId: string, cenaId: string): { meta: MetaVideo; efeitosRemovidos: Efeito[] } {
  const meta = lerMeta(projectPath, home, videoId);
  if (!meta.cenas.some((c) => c.id === cenaId)) throw erro(`a cena ${cenaId} não existe`, 404);
  meta.cenas = meta.cenas.filter((c) => c.id !== cenaId);
  const efeitosRemovidos = meta.audio.efeitos.filter((e) => e.cena === cenaId);
  meta.audio.efeitos = meta.audio.efeitos.filter((e) => e.cena !== cenaId);
  meta.transicoes = meta.transicoes.filter((t) => t.de !== cenaId && t.para !== cenaId);
  rmSync(arquivoDaCena(projectPath, home, videoId, cenaId), { force: true });
  gravarMeta(projectPath, home, meta);
  return { meta, efeitosRemovidos };
}

export function duplicarCena(projectPath: string, home: string, videoId: string, cenaId: string): { meta: MetaVideo; cena: Cena } {
  const meta = lerMeta(projectPath, home, videoId);
  const i = meta.cenas.findIndex((c) => c.id === cenaId);
  if (i < 0) throw erro(`a cena ${cenaId} não existe`, 404);
  const orig = meta.cenas[i]!;
  const r = salvarCena(projectPath, home, videoId, {
    nome: `${orig.nome} (cópia)`,
    duracao: orig.duracao,
    html: htmlDaCena(projectPath, home, videoId, cenaId),
    posicao: i + 1,
    ...(orig.origem ? { origem: orig.origem } : {}),
  });
  return { meta: r.meta, cena: r.cena };
}

/** Nova ordem das cenas (ids). Tem que ser uma permutação das que existem. */
export function ordenarCenas(projectPath: string, home: string, videoId: string, ordem: unknown): MetaVideo {
  const meta = lerMeta(projectPath, home, videoId);
  if (!Array.isArray(ordem) || ordem.length !== meta.cenas.length || !meta.cenas.every((c) => ordem.includes(c.id))) {
    throw erro("ordem precisa listar todas as cenas do vídeo, cada uma uma vez");
  }
  meta.cenas = (ordem as string[]).map((id) => meta.cenas.find((c) => c.id === id)!);
  gravarMeta(projectPath, home, meta);
  return meta;
}

export function mudarVideo(projectPath: string, home: string, videoId: string, m: { nome?: unknown; formato?: unknown; textoPost?: unknown; capaEm?: unknown }): MetaVideo {
  const meta = lerMeta(projectPath, home, videoId);
  if (typeof m.nome === "string" && m.nome.trim()) meta.nome = m.nome.trim().slice(0, 120);
  if (m.formato !== undefined) {
    if (!ehFormato(m.formato)) throw erro("formato: 16:9, 9:16 ou 1:1");
    meta.formato = m.formato;
  }
  if (typeof m.textoPost === "string") meta.textoPost = m.textoPost.slice(0, 4000);
  if (m.capaEm !== undefined) meta.capaEm = num(m.capaEm, 0, 0, 3600);
  gravarMeta(projectPath, home, meta);
  return meta;
}

/**
 * Tela do DS oficial ou do painel de mocks vira cena: CÓPIA do HTML (decisão "reorganizar as
 * telas"). A cena ganha timeline e não pode quebrar quando a tela original mudar.
 */
export function importarTela(projectPath: string, home: string, videoId: string, sistemaId: string, cardId: string): { meta: MetaVideo; cena: Cena } {
  const est = estadoDs(projectPath, home);
  const sistema = est.sistemas.find((s) => s.id === sistemaId);
  if (!sistema) throw erro(`design system ${sistemaId} não existe`, 404);
  const ds = lerSistema(projectPath, home, sistema);
  const card = ds.cards.find((c) => c.id === cardId);
  if (!card) throw erro(`a tela ${cardId} não existe em ${sistema.nome}`, 404);
  const html = htmlDaTelaImportada(card.html, LARGURA_DO_CARD_PX[card.largura ?? "1/2"] ?? 764);
  const r = salvarCena(projectPath, home, videoId, {
    nome: card.titulo.replace(/^Tela:\s*/i, ""),
    duracao: 4,
    html,
    origem: { sistema: sistema.id, card: card.id, titulo: card.titulo },
  });
  return { meta: r.meta, cena: r.cena };
}

/** Largura do card no board do Canvas (canvas-ds.js `LARGURA_PX`): a tela foi desenhada nela. */
const LARGURA_DO_CARD_PX: Record<string, number> = { "1/3": 500, "1/2": 764, "2/3": 1028, "1": 1560 };

/**
 * A tela importada entra na LARGURA em que foi desenhada no Canvas e é ampliada pra largura do
 * quadro (menos a margem), em CSS puro: `--vp-w` vem do documento da cena (`documentoDaCena`), então
 * trocar o formato do vídeo reajusta sozinho. Tela mais alta que o quadro alinha no topo e o resto
 * fica recortado de propósito (`data-layout-allow-overflow` avisa o `check`); o agente reenquadra
 * animando a cena. Zoom fixo (o de antes) estourava a largura; medir no script não serve porque a
 * cena ainda está escondida quando o script roda no render.
 */
export function htmlDaTelaImportada(cardHtml: string, larguraPx: number): string {
  return `<style>
.palco{position:absolute;inset:0;background:var(--color-bg);overflow:hidden;display:flex;justify-content:safe center;align-items:safe center;padding:64px;box-sizing:border-box}
.palco>.tela{flex:none;width:${larguraPx}px;zoom:calc((var(--vp-w) - 128) / ${larguraPx})}
</style>
<div class="palco" data-layout-allow-overflow><div class="tela">
${cardHtml}
</div></div>
<script>
tl.fromTo(".tela", { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power2.out" }, 0);
</script>
`;
}

/** Telas que dá pra importar: DS oficial + painel de mocks dele, por seção. */
export function telasImportaveis(projectPath: string, home: string): { sistema: string; nome: string; secao: string; card: string; titulo: string }[] {
  const est = estadoDs(projectPath, home);
  const oficial = est.oficial;
  const alvo = est.sistemas.filter((s) => s.id === oficial || (oficial && s.mocksDe === oficial));
  const out: { sistema: string; nome: string; secao: string; card: string; titulo: string }[] = [];
  for (const s of alvo) {
    const ds = lerSistema(projectPath, home, s);
    for (const c of ds.cards) out.push({ sistema: s.id, nome: s.nome, secao: ds.secoes.find((x) => x.id === c.secao)?.titulo ?? c.secao, card: c.id, titulo: c.titulo });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Transições
 * ------------------------------------------------------------------------- */

export function definirTransicao(
  projectPath: string,
  home: string,
  videoId: string,
  input: { de?: unknown; para?: unknown; tipo?: unknown; duracao?: unknown; nome?: unknown; codigo?: unknown; prompt?: unknown },
): { meta: MetaVideo; transicao: Transicao; limitada: boolean; maximo: number } {
  const meta = lerMeta(projectPath, home, videoId);
  const de = String(input.de ?? "");
  const para = String(input.para ?? "");
  const i = meta.cenas.findIndex((c) => c.id === de);
  if (i < 0 || meta.cenas[i + 1]?.id !== para) throw erro(`${de} → ${para} não são cenas vizinhas nesta ordem`);
  const tipo = input.tipo as TipoTransicao;
  if (!TIPOS_TRANSICAO.includes(tipo)) throw erro(`tipo: ${TIPOS_TRANSICAO.join(", ")}`);
  const maximo = maximoDaTransicao(meta.cenas[i]!.duracao, meta.cenas[i + 1]!.duracao);
  const pedido = tipo === "corte" ? 0 : num(input.duracao, 0.6, 0.1, 2);
  const duracao = Math.min(pedido, maximo);
  const atual = transicaoEntre(meta, de, para);
  if (tipo === "personalizada") {
    const codigo = typeof input.codigo === "string" ? input.codigo : atual?.tipo === "personalizada" ? atual.codigo : undefined;
    if (!codigo?.trim()) throw erro("transição personalizada precisa de `codigo` (corpo JS com tl, a, b, inicio, duracao)");
    if (/\b(Date\.now|Math\.random|setTimeout|setInterval|fetch\()/.test(codigo)) throw erro("código da transição precisa ser determinístico (sem Date.now, Math.random, timers, fetch)");
  }
  const nova: Transicao = {
    de,
    para,
    tipo,
    duracao,
    ...(tipo === "personalizada"
      ? {
          nome: typeof input.nome === "string" && input.nome.trim() ? input.nome.trim().slice(0, 40) : (atual?.nome ?? "Personalizada"),
          codigo: typeof input.codigo === "string" ? input.codigo : atual?.codigo,
          ...(typeof input.prompt === "string" ? { prompt: input.prompt.slice(0, 500) } : atual?.prompt ? { prompt: atual.prompt } : {}),
        }
      : {}),
    ...(atual ? { anterior: semAnterior(atual) } : {}),
  };
  meta.transicoes = [...meta.transicoes.filter((t) => !(t.de === de && t.para === para)), nova];
  gravarMeta(projectPath, home, meta);
  avisarVideo(projectPath, { type: "transicao-salva", id: videoId, de, para, tipo, duracao });
  return { meta, transicao: nova, limitada: pedido > maximo, maximo };
}

function semAnterior(t: Transicao): Omit<Transicao, "anterior" | "de" | "para"> {
  const { anterior: _a, de: _d, para: _p, ...resto } = t;
  return resto;
}

export function desfazerTransicao(projectPath: string, home: string, videoId: string, de: string, para: string): MetaVideo {
  const meta = lerMeta(projectPath, home, videoId);
  const atual = transicaoEntre(meta, de, para);
  if (!atual?.anterior) throw erro("nada pra desfazer nessa transição");
  meta.transicoes = meta.transicoes.map((t) => (t === atual ? { ...atual.anterior!, de, para } : t));
  gravarMeta(projectPath, home, meta);
  avisarVideo(projectPath, { type: "transicao-salva", id: videoId, de, para, tipo: atual.anterior.tipo });
  return meta;
}

/** A transição personalizada que já existe em outro par: vira o 7º item reaplicável do popover. */
export function transicoesPersonalizadas(meta: MetaVideo): Transicao[] {
  const vistas = new Set<string>();
  return meta.transicoes.filter((t) => t.tipo === "personalizada" && t.codigo && !vistas.has(t.codigo) && vistas.add(t.codigo));
}

/* ---------------------------------------------------------------------------
 * Áudio
 * ------------------------------------------------------------------------- */

export const VOLUME_MUSICA = { padrao: 0.35, recomendadoMax: 0.5 };
export const VOLUME_EFEITO = { padrao: 0.7, min: 0.55, max: 0.85 };
export const MUSICA_MAX_BYTES = 30 * 1024 * 1024;

export function definirMusica(
  projectPath: string,
  home: string,
  videoId: string,
  input: { fonte?: unknown; volume?: unknown; repetir?: unknown; duracao?: unknown } | null,
): MetaVideo {
  const meta = lerMeta(projectPath, home, videoId);
  if (!input || input.fonte === null || input.fonte === "") {
    meta.audio.musica = null;
  } else {
    const fonte = String(input.fonte ?? meta.audio.musica?.fonte ?? "");
    let nome = fonte;
    let duracao: number | undefined;
    if (fonte.startsWith("nexos:")) {
      const m = musicasDoNexos().find((x) => x.fonte === fonte);
      if (!m) throw erro(`música ${fonte} não existe`);
      nome = `${m.nome} — ende.app`;
      duracao = m.duracao;
    } else if (fonte.startsWith("propria:")) {
      const arq = fonte.slice(8);
      if (!ARQ_RE.test(arq) || !existsSync(join(pastaDoVideo(projectPath, home, videoId, false), "audio", arq))) throw erro(`a música ${arq} não está no vídeo`);
      nome = arq.replace(/\.[^.]+$/, "");
      duracao = input.duracao !== undefined ? num(input.duracao, 0, 0, 3600) : meta.audio.musica?.fonte === fonte ? meta.audio.musica.duracao : undefined;
    } else throw erro("fonte: nexos:<música> ou propria:<arquivo>");
    const antes = meta.audio.musica;
    meta.audio.musica = {
      fonte,
      nome,
      volume: num(input.volume, antes?.volume ?? VOLUME_MUSICA.padrao, 0, 1),
      ...(duracao ? { duracao } : {}),
      ...(typeof input.repetir === "boolean" ? { repetir: input.repetir } : antes?.repetir ? { repetir: true } : {}),
    };
  }
  gravarMeta(projectPath, home, meta);
  return meta;
}

const EXT_AUDIO = /\.(mp3|wav|m4a)$/i;

/** Música própria: grava em audio/ (sincroniza) — as batidas o motor calcula depois. */
export function gravarMusicaPropria(projectPath: string, home: string, videoId: string, nome: string, dados: Buffer): string {
  const limpo = nome.replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(-100);
  if (!EXT_AUDIO.test(limpo)) throw erro("Esse arquivo não dá: use mp3, wav ou m4a");
  if (dados.length > MUSICA_MAX_BYTES) throw erro("Esse arquivo não dá: maior que 30 MB");
  if (!dados.length) throw erro("Esse arquivo não dá: está vazio");
  const destino = join(pastaDoVideo(projectPath, home, videoId, true), "audio", limpo);
  escreverAtomico(destino, dados);
  return limpo;
}

export function salvarEfeito(
  projectPath: string,
  home: string,
  videoId: string,
  input: { id?: unknown; cena?: unknown; t?: unknown; tAbsoluto?: unknown; arquivo?: unknown; volume?: unknown; rotulo?: unknown; encaixar?: unknown },
): { meta: MetaVideo; efeito: Efeito; naBatida: boolean } {
  const meta = lerMeta(projectPath, home, videoId);
  const linha = linhaDoTempo(meta);
  const existente = typeof input.id === "string" ? meta.audio.efeitos.find((e) => e.id === input.id) : undefined;
  const arquivo = typeof input.arquivo === "string" ? input.arquivo : existente?.arquivo;
  if (!arquivo || !efeitoExiste(arquivo)) throw erro(`efeito ${arquivo ?? ""} não existe (veja a lista de efeitos)`);
  // tempo absoluto (arrastado na trilha) → cena dona + tempo relativo a ela
  let cena = typeof input.cena === "string" ? input.cena : existente?.cena;
  let t = input.t !== undefined ? num(input.t, 0, 0, 3600) : (existente?.t ?? 0);
  let naBatida = false;
  if (input.tAbsoluto !== undefined) {
    let abs = num(input.tAbsoluto, 0, 0, linha.total);
    if (input.encaixar !== false) {
      const e = encaixarNaBatida(abs, batidasDaMusica(projectPath, home, videoId, meta.audio.musica));
      abs = e.t;
      naBatida = e.naBatida;
    }
    // a cena que está TOCANDO em `abs` (na sobreposição, a que entra)
    const dona = [...linha.cenas].reverse().find((c) => abs >= c.inicio) ?? linha.cenas[0];
    if (!dona) throw erro("o vídeo não tem cena");
    cena = dona.id;
    t = Math.round((abs - dona.inicio) * 1000) / 1000;
  }
  if (!cena || !meta.cenas.some((c) => c.id === cena)) throw erro("efeito precisa de uma cena do vídeo");
  const efeito: Efeito = {
    id: existente?.id ?? `ef-${randomBytes(3).toString("hex")}`,
    cena,
    t,
    arquivo,
    volume: num(input.volume, existente?.volume ?? VOLUME_EFEITO.padrao, 0, 1),
    rotulo: typeof input.rotulo === "string" && input.rotulo.trim() ? input.rotulo.trim().slice(0, 24) : (existente?.rotulo ?? rotuloDoEfeito(arquivo)),
  };
  meta.audio.efeitos = [...meta.audio.efeitos.filter((e) => e.id !== efeito.id), efeito];
  gravarMeta(projectPath, home, meta);
  return { meta, efeito, naBatida };
}

export function removerEfeito(projectPath: string, home: string, videoId: string, efeitoId: string): MetaVideo {
  const meta = lerMeta(projectPath, home, videoId);
  meta.audio.efeitos = meta.audio.efeitos.filter((e) => e.id !== efeitoId);
  gravarMeta(projectPath, home, meta);
  return meta;
}

/** Devolve efeitos removidos (desfazer do "apagar cena"): só os da cena que ainda existe. */
export function restaurarEfeitos(projectPath: string, home: string, videoId: string, efeitos: Efeito[]): MetaVideo {
  const meta = lerMeta(projectPath, home, videoId);
  const validos = efeitos.filter((e) => meta.cenas.some((c) => c.id === e.cena) && efeitoExiste(e.arquivo));
  meta.audio.efeitos = [...meta.audio.efeitos.filter((e) => !validos.some((v) => v.id === e.id)), ...validos];
  gravarMeta(projectPath, home, meta);
  return meta;
}

function rotuloDoEfeito(arquivo: string): string {
  const base = arquivo.split("/").pop()!.replace(/\.[^.]+$/, "");
  if (/whoosh|swipe|swish/i.test(base)) return "whoosh";
  if (/click/i.test(base)) return "clique";
  if (/impact/i.test(base)) return "impacto";
  if (/pop|bong/i.test(base)) return "pop";
  return base.replace(/[_-]\d+$/, "").slice(0, 16);
}

function efeitoExiste(arquivo: string): boolean {
  if (arquivo.includes("..") || !/^[a-z]+\/[a-zA-Z0-9_.-]+\.(ogg|mp3|wav)$/.test(arquivo)) return false;
  return existsSync(join(pastaDeAssets(), "efeitos", arquivo));
}

export type EfeitoDoCatalogo = { arquivo: string; categoria: "Transição" | "Interface" | "Impacto" | "Sutil"; duracao: number; cansa: boolean; uso: string };

let catalogoCache: EfeitoDoCatalogo[] | null = null;
/** Os efeitos da Kenney com a análise do brag: `cansa` = risco alto de agudo/cansaço. */
export function catalogoDeEfeitos(): EfeitoDoCatalogo[] {
  if (catalogoCache) return catalogoCache;
  type Rec = { path: string; family?: string; duration?: number; highFrequencyRisk?: string; recommendedUses?: string[]; brightness?: string };
  const j = lerJson<{ recommendations?: Rec[] }>(join(pastaDeAssets(), "efeitos", "sfx-analysis.json"));
  catalogoCache = (j?.recommendations ?? [])
    .filter((r) => efeitoExiste(r.path))
    .map((r) => {
      const uso = (r.recommendedUses ?? []).join(", ");
      const categoria: EfeitoDoCatalogo["categoria"] = /transition|reveal/i.test(uso)
        ? "Transição"
        : r.family === "impact"
          ? "Impacto"
          : /button|selection|user action|typing/i.test(uso) || r.family === "ui" || r.family === "interface" || r.family === "keyboard"
            ? "Interface"
            : "Sutil";
      return { arquivo: r.path, categoria, duracao: r.duration ?? 0, cansa: r.highFrequencyRisk === "high", uso };
    });
  return catalogoCache;
}

/* ---------------------------------------------------------------------------
 * Leitura completa (pro painel)
 * ------------------------------------------------------------------------- */

export function infoRender(projectPath: string, home: string, videoId: string): InfoRender | null {
  const pasta = join(pastaDoVideo(projectPath, home, videoId, false), "render");
  const info = lerJson<InfoRender>(join(pasta, "info.json"));
  if (!info) return null;
  const caminho = join(pasta, info.arquivo);
  if (!existsSync(caminho)) return null;
  return { ...info, caminho };
}

export function lerVideo(projectPath: string, home: string, videoId: string): VideoCompleto {
  const meta = lerMeta(projectPath, home, videoId);
  const oficial = dsDoProjeto(projectPath, home);
  const html: Record<string, string> = {};
  for (const c of meta.cenas) html[c.id] = htmlDaCena(projectPath, home, videoId, c.id);
  return {
    ...meta,
    pastaAbs: pastaDoVideo(projectPath, home, videoId, false),
    projetoAbs: resolve(projectPath),
    linha: linhaDoTempo(meta),
    html,
    ds: oficial ? { id: oficial.id, nome: oficial.nome } : null,
    render: infoRender(projectPath, home, videoId),
    creditos: creditosDoVideo(meta),
  };
}

export function creditosDoVideo(meta: MetaVideo): string[] {
  const out: string[] = [];
  if (meta.audio.musica?.fonte.startsWith("nexos:")) out.push(CREDITO_MUSICA);
  if (meta.audio.efeitos.length) out.push("Sound effects: Kenney (CC0)");
  return out;
}

/** Texto pra postar com o crédito da música anexado (CC BY exige atribuição). */
export function textoParaPostar(meta: MetaVideo): string {
  const base = (meta.textoPost ?? meta.nome).trim();
  const cred = creditosDoVideo(meta).filter((c) => !base.includes(c));
  return cred.length ? `${base}\n\n${cred.join(" · ")}` : base;
}

/* ---------------------------------------------------------------------------
 * Composição Hyperframes (render/comp) — o MESMO documento do render e do preview
 * ------------------------------------------------------------------------- */

const FONTES_EMBUTIDAS: Record<string, string> = {
  inter: "inter.woff2",
  "inter tight": "inter-tight.woff2",
  "jetbrains mono": "jetbrains-mono.woff2",
};

/** Fontes do DS que não vêm com o Nexos: baixadas uma vez do Google Fonts (video-motor.ts). */
export function pastaFontesBaixadas(home: string): string {
  return join(home, "video-fontes");
}
export function arquivoDaFonteBaixada(familia: string): string {
  return `${familia.replace(/[^a-z0-9]+/g, "-")}.woff2`;
}
export const FAMILIAS_GENERICAS = /^(system-ui|sans-serif|serif|monospace|cursive|ui-|-apple|blinkmac|segoe|roboto|helvetica|arial|sfmono|menlo|consolas|courier)/;

/** "ibm plex sans" → "IBM Plex Sans": o Google Fonts diferencia maiúscula; sigla curta vai toda em maiúscula. */
export function nomeDaFamilia(f: string): string {
  return f
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ")
    .replace("Jetbrains", "JetBrains");
}

/** Famílias citadas nos tokens de fonte, em minúsculas. */
export function familiasDoDs(ds: DsCompleto | null): string[] {
  if (!ds) return ["inter"];
  const out = new Set<string>();
  for (const v of ds.vars) {
    if (v.tipo !== "fontFamily" && !/family/i.test(v.caminho)) continue;
    for (const f of v.valor.split(",")) {
      const nome = f.trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (nome) out.add(nome);
    }
  }
  return [...out];
}

function cssBase(ds: DsCompleto | null, fontesLocais: { familia: string; arquivo: string }[]): string {
  const faces = fontesLocais
    .map((f) => `@font-face { font-family: "${f.familia}"; src: url("${f.arquivo}") format("woff2"); font-weight: 100 900; font-display: block; }`)
    .join("\n");
  // o DS oficial dá os tokens; sem DS, o básico pra cena não sair em branco no branco
  const tokens = ds?.css ?? ":root { --color-bg: #141417; --color-text: #ececef; --font-family-body: Inter, sans-serif; }";
  return `${faces}\n${tokens}\n`;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function scriptsDe(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? "");
}
function estilosDe(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? "");
}
function marcacaoDe(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").trim();
}

/** Tira `</script` de dentro de código que vai num <script> inline. */
function seguroEmScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

/** `--vp-w`/`--vp-h`: tamanho do quadro SEM unidade, pra `calc()` de escala (ex.: tela importada). */
const ESTILO_RAIZ_CENA = (id: string, fmt: { largura: number; altura: number }) =>
  `[data-composition-id="cena-${id}"]{--vp-w:${fmt.largura};--vp-h:${fmt.altura};position:absolute;inset:0;overflow:hidden;background:var(--color-bg);color:var(--color-text);font-family:var(--font-family-body)}`;

/**
 * Documento de UMA cena (sub-composition). `previa`: mesmo documento, mas autônomo (sem o runtime
 * do Hyperframes): cria `window.__timelines`, escuta `seek` por postMessage e traz o inspector —
 * é o que o card da cena no Canvas carrega. O seek é o mesmo do render, então o frame é fiel.
 */
export function documentoDaCena(cena: Cena, html: string, fmt: { largura: number; altura: number }, opts: { previa?: boolean; prefixo?: string } = {}): string {
  const p = opts.prefixo ?? "";
  const id = cena.id;
  const scripts = scriptsDe(html).map(seguroEmScript).join("\n;\n");
  const estilos = estilosDe(html).join("\n");
  const previa = opts.previa
    ? `<script>window.__timelines=window.__timelines||{};</script>
<style>html,body{margin:0;width:${fmt.largura}px;height:${fmt.altura}px;overflow:hidden;background:var(--color-bg)}
.nx-alvo{outline:2px dashed #b7a3e3 !important;outline-offset:2px}</style>`
    : "";
  const ponte = opts.previa ? `\n<script>${seguroEmScript(PONTE_PREVIA(id))}</script>` : "";
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="${p}assets/base.css">
<script src="${p}assets/gsap.min.js"></script>
${previa}
<style>${ESTILO_RAIZ_CENA(id, fmt)}</style>
<style>
${estilos}
</style>
</head><body>
<div data-composition-id="cena-${id}" data-width="${fmt.largura}" data-height="${fmt.altura}" data-duration="${cena.duracao}">
${marcacaoDe(html)}
</div>
<script>
(function () {
  var cena = document.querySelector('[data-composition-id="cena-${id}"]');
  var tl = gsap.timeline({ paused: true });
  try {
${scripts}
  } catch (e) { console.error("cena ${id}:", e); window.__erroDaCena = String(e && e.message || e); }
  window.__timelines["cena-${id}"] = tl;
  tl.seek(0);
})();
</script>${ponte}
</body></html>
`;
}

/**
 * Ponte da prévia: o card no Canvas é de outra origem (file://), então conversa por postMessage.
 * `seek` → frame fiel; `inspecionar` liga/desliga o inspector (clique devolve seletor + texto).
 */
const PONTE_PREVIA = (id: string) => `(function () {
  var tl = window.__timelines["cena-${id}"];
  var tocando = null;
  function avisar(m) { try { parent.postMessage(Object.assign({ nexosCena: "${id}" }, m), "*"); } catch (e) {} }
  function seek(t) { if (tocando) { cancelAnimationFrame(tocando.raf); tocando = null; } tl.seek(Math.max(0, t), false); }
  var inspecionando = false, alvo = null;
  function seletor(el) {
    var partes = [];
    while (el && el.nodeType === 1 && !el.hasAttribute("data-composition-id") && partes.length < 5) {
      var s = el.tagName.toLowerCase();
      if (el.id) { partes.unshift(s + "#" + el.id); break; }
      var c = [].slice.call(el.classList).filter(function (x) { return x !== "nx-alvo"; })[0];
      if (c) s += "." + c;
      var irmaos = el.parentElement ? [].filter.call(el.parentElement.children, function (x) { return x.tagName === el.tagName; }) : [];
      if (irmaos.length > 1) s += ":nth-of-type(" + (irmaos.indexOf(el) + 1) + ")";
      partes.unshift(s);
      el = el.parentElement;
    }
    return partes.join(" > ");
  }
  document.addEventListener("mouseover", function (e) {
    if (!inspecionando) return;
    if (alvo) alvo.classList.remove("nx-alvo");
    alvo = e.target; alvo.classList.add("nx-alvo");
  });
  document.addEventListener("click", function (e) {
    if (!inspecionando) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    avisar({ tipo: "inspecionado", seletor: seletor(el), texto: (el.textContent || "").trim().slice(0, 120), tag: el.tagName.toLowerCase() });
  }, true);
  window.addEventListener("message", function (e) {
    var m = e.data || {};
    if (m.tipo === "seek") seek(Number(m.t) || 0);
    else if (m.tipo === "tocar") {
      var t0 = performance.now(), de = Number(m.de) || 0, ate = Number(m.ate) || tl.duration();
      if (tocando) cancelAnimationFrame(tocando.raf);
      tocando = { raf: 0 };
      (function passo() {
        var t = de + (performance.now() - t0) / 1000;
        if (t >= ate) { tl.seek(ate, false); tocando = null; avisar({ tipo: "parou", t: ate }); return; }
        tl.seek(t, false); avisar({ tipo: "tempo", t: t });
        tocando.raf = requestAnimationFrame(passo);
      })();
    } else if (m.tipo === "parar") { if (tocando) { cancelAnimationFrame(tocando.raf); tocando = null; } }
    else if (m.tipo === "inspecionar") { inspecionando = !!m.ligado; if (!inspecionando && alvo) { alvo.classList.remove("nx-alvo"); alvo = null; } }
  });
  avisar({ tipo: "pronta", duracao: tl.duration(), erro: window.__erroDaCena || null });
})();`;

/**
 * JS que aplica as transições na timeline raiz. `a`/`b` = hosts das cenas (div no render,
 * iframe no player de prévia — o mesmo código serve aos dois).
 */
export function codigoDasTransicoes(linha: Linha, host: (id: string) => string): string {
  const linhas: string[] = [];
  for (const t of linha.transicoes) {
    if (t.tipo === "corte" || t.duracao <= 0) continue;
    const a = host(t.de);
    const b = host(t.para);
    const i = t.inicio;
    const d = t.duracao;
    const ef = `ease: "power2.inOut", immediateRender: false`;
    switch (t.tipo) {
      case "fade":
        linhas.push(`tl.fromTo(${b}, { opacity: 0 }, { opacity: 1, duration: ${d}, ease: "none", immediateRender: false }, ${i});`);
        break;
      case "fundo":
        linhas.push(`tl.fromTo(${a}, { opacity: 1 }, { opacity: 0, duration: ${d / 2}, ease: "power1.in", immediateRender: false }, ${i});`);
        linhas.push(`tl.fromTo(${b}, { opacity: 0 }, { opacity: 1, duration: ${d / 2}, ease: "power1.out", immediateRender: false }, ${i + d / 2});`);
        linhas.push(`tl.set(${b}, { opacity: 0 }, ${i});`);
        break;
      case "deslizar-esq":
        linhas.push(`tl.fromTo(${a}, { xPercent: 0 }, { xPercent: -100, duration: ${d}, ${ef} }, ${i});`);
        linhas.push(`tl.fromTo(${b}, { xPercent: 100 }, { xPercent: 0, duration: ${d}, ${ef} }, ${i});`);
        break;
      case "deslizar-cima":
        linhas.push(`tl.fromTo(${a}, { yPercent: 0 }, { yPercent: -100, duration: ${d}, ${ef} }, ${i});`);
        linhas.push(`tl.fromTo(${b}, { yPercent: 100 }, { yPercent: 0, duration: ${d}, ${ef} }, ${i});`);
        break;
      case "mascara":
        linhas.push(`tl.fromTo(${b}, { clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)", duration: ${d}, ${ef} }, ${i});`);
        break;
      case "personalizada":
        linhas.push(`(function (tl, a, b, inicio, duracao) {\n${seguroEmScript(t.codigo ?? "")}\n})(tl, ${a}, ${b}, ${i}, ${d});`);
        break;
    }
  }
  return linhas.join("\n");
}

type AudioNaComposicao = { id: string; src: string; inicio: number; duracao: number; volume: number; fadeOut?: number; musica?: boolean; offset?: number };

export function audiosDoVideo(meta: MetaVideo, linha: Linha): AudioNaComposicao[] {
  const out: AudioNaComposicao[] = [];
  const m = meta.audio.musica;
  if (m && linha.total > 0) {
    const src = m.fonte.startsWith("nexos:") ? `assets/musica/${m.fonte.slice(6)}.mp3` : `assets/musica/${m.fonte.slice(8)}`;
    const dur = m.duracao && m.duracao > 0 ? m.duracao : linha.total;
    if (dur >= linha.total || !m.repetir) {
      const fim = Math.min(dur, linha.total);
      // cortada no fim do vídeo: fade-out de 1 s (spec da trilha). Acabou antes: termina natural.
      out.push({ id: "musica", src, inicio: 0, duracao: fim, volume: m.volume, musica: true, ...(dur >= linha.total ? { fadeOut: Math.min(1, fim) } : {}) });
    } else {
      let k = 0;
      for (let ini = 0; ini < linha.total - 0.01; ini += dur, k++) {
        const d = Math.min(dur, linha.total - ini);
        const ultimo = ini + dur >= linha.total;
        out.push({ id: k ? `musica-${k + 1}` : "musica", src, inicio: Math.round(ini * 1000) / 1000, duracao: Math.round(d * 1000) / 1000, volume: m.volume, musica: true, ...(ultimo ? { fadeOut: Math.min(1, d) } : {}) });
      }
    }
  }
  for (const e of meta.audio.efeitos) {
    const c = linha.cenas.find((x) => x.id === e.cena);
    if (!c) continue;
    const inicio = Math.round((c.inicio + Math.min(e.t, c.duracao)) * 1000) / 1000;
    if (inicio >= linha.total) continue;
    // o slot tem a duração do próprio som (o Hyperframes avisa quando o slot é maior que a mídia)
    const dur = catalogoDeEfeitos().find((x) => x.arquivo === e.arquivo)?.duracao || 3;
    out.push({ id: `efeito-${e.id}`, src: `assets/efeitos/${e.arquivo}`, inicio, duracao: Math.round(Math.min(dur, linha.total - inicio) * 1000) / 1000, volume: e.volume });
  }
  return out;
}

export function documentoRaiz(meta: MetaVideo, linha: Linha): string {
  const fmt = FORMATOS[meta.formato];
  const hosts = linha.cenas
    .map(
      (c, i) =>
        `  <div id="h-${c.id}" class="clip" data-composition-id="cena-${c.id}" data-composition-src="compositions/cena-${c.id}.html" data-start="${c.inicio}" data-duration="${c.duracao}" data-track-index="${i % 2}" data-layout-allow-overlap></div>`,
    )
    .join("\n");
  const audios = audiosDoVideo(meta, linha)
    .map(
      (a) =>
        `  <audio id="${a.id}"${a.musica ? ' data-timeline-role="music"' : ""} src="${escAttr(a.src)}" data-start="${a.inicio}" data-duration="${a.duracao}" data-volume="${a.volume}"${a.fadeOut ? ` data-fade-out="${a.fadeOut}"` : ""} data-track-index="${a.musica ? 2 : 3}"></audio>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=${fmt.largura}, height=${fmt.altura}">
<link rel="stylesheet" href="assets/base.css">
<script src="assets/gsap.min.js"></script>
<style>*{margin:0;padding:0;box-sizing:border-box} html,body{width:${fmt.largura}px;height:${fmt.altura}px;overflow:hidden;background:var(--color-bg)}</style>
</head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${linha.total}" data-width="${fmt.largura}" data-height="${fmt.altura}">
${hosts}
${audios}
</div>
<script>
  const tl = gsap.timeline({ paused: true });
${codigoDasTransicoes(linha, (id) => `"#h-${id}"`)}
  window.__timelines["main"] = tl;
</script>
</body></html>
`;
}

/**
 * Player da prévia do vídeo inteiro (drawer "Preview"): cada cena num iframe (o mesmo documento
 * de prévia do card), a MESMA timeline raiz de transições aplicada nos iframes e o áudio tocando
 * junto. Serve sem FFmpeg e sem render.
 */
export function documentoPlayer(meta: MetaVideo, linha: Linha): string {
  const fmt = FORMATOS[meta.formato];
  const frames = linha.cenas
    .map((c) => `<iframe id="h-${c.id}" src="previa/cena-${c.id}.html" data-inicio="${c.inicio}" data-fim="${c.fim}" tabindex="-1"></iframe>`)
    .join("\n");
  const audios = audiosDoVideo(meta, linha)
    .map((a) => `<audio data-inicio="${a.inicio}" data-duracao="${a.duracao}" data-volume="${a.volume}" data-fade="${a.fadeOut ?? 0}" src="${escAttr(a.src)}" preload="auto"></audio>`)
    .join("\n");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="assets/base.css">
<script src="assets/gsap.min.js"></script>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
#palco{position:absolute;left:50%;top:50%;width:${fmt.largura}px;height:${fmt.altura}px;transform-origin:0 0;background:var(--color-bg);overflow:hidden}
#palco iframe{position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden}
</style></head><body>
<div id="palco">
${frames}
</div>
${audios}
<script>
(function () {
  var W = ${fmt.largura}, H = ${fmt.altura}, TOTAL = ${linha.total};
  var palco = document.getElementById("palco");
  function ajustar() { var s = Math.min(innerWidth / W, innerHeight / H); palco.style.transformOrigin = "50% 50%"; palco.style.transform = "translate(-50%,-50%) scale(" + s + ")"; }
  addEventListener("resize", ajustar); ajustar();
  var frames = [].slice.call(document.querySelectorAll("#palco iframe"));
  var audios = [].slice.call(document.querySelectorAll("audio"));
  var tl = gsap.timeline({ paused: true });
${codigoDasTransicoes(linha, (id) => `document.getElementById("h-${id}")`)}
  function mostrar(t) {
    frames.forEach(function (f) {
      var i = +f.dataset.inicio, fim = +f.dataset.fim, vis = t >= i && t < fim + 1e-6;
      f.style.visibility = vis ? "visible" : "hidden";
      var w = f.contentWindow;
      if (vis && w && w.__timelines) { var k = Object.keys(w.__timelines)[0]; if (k) w.__timelines[k].seek(t - i, false); }
    });
    tl.seek(t, false);
  }
  var t0 = 0, base = 0, raf = 0, tocando = false;
  function avisar(m) { try { parent.postMessage(Object.assign({ nexosPlayer: true }, m), "*"); } catch (e) {} }
  function audiosEm(t, tocar) {
    audios.forEach(function (a) {
      var i = +a.dataset.inicio, d = +a.dataset.duracao;
      if (!tocar || t < i || t >= i + d) { a.pause(); return; }
      a.currentTime = t - i; a.volume = Math.min(1, +a.dataset.volume); a.play().catch(function () {});
    });
  }
  function volumeFade(t) {
    audios.forEach(function (a) {
      var i = +a.dataset.inicio, d = +a.dataset.duracao, f = +a.dataset.fade, v = +a.dataset.volume;
      if (f > 0 && t > i + d - f) a.volume = Math.max(0, Math.min(1, v * (i + d - t) / f));
      if (t >= i + d && !a.paused) a.pause();
      if (t >= i && t < i + d && a.paused && tocando) { a.currentTime = t - i; a.play().catch(function () {}); }
    });
  }
  function passo() {
    var t = base + (performance.now() - t0) / 1000;
    if (t >= TOTAL) { mostrar(TOTAL - 0.001); parar(); avisar({ tipo: "fim" }); return; }
    mostrar(t); volumeFade(t); avisar({ tipo: "tempo", t: t });
    raf = requestAnimationFrame(passo);
  }
  function tocar(de) { base = Math.max(0, Math.min(TOTAL, de || 0)); t0 = performance.now(); tocando = true; audiosEm(base, true); cancelAnimationFrame(raf); raf = requestAnimationFrame(passo); }
  function parar() { tocando = false; cancelAnimationFrame(raf); audiosEm(0, false); }
  addEventListener("message", function (e) {
    var m = e.data || {};
    if (m.tipo === "tocar") tocar(Number(m.de) || 0);
    else if (m.tipo === "parar") parar();
    else if (m.tipo === "seek") { parar(); mostrar(Number(m.t) || 0); }
  });
  var prontas = 0;
  frames.forEach(function (f) { f.addEventListener("load", function () { if (++prontas === frames.length) { mostrar(0); avisar({ tipo: "pronto", total: TOTAL }); } }); });
  if (!frames.length) avisar({ tipo: "pronto", total: 0 });
})();
</script>
</body></html>
`;
}

/** Hash do que entra na composição: igual = não precisa remontar a pasta. */
function assinatura(partes: string[]): string {
  return createHash("sha1").update(partes.join("\u0000")).digest("hex");
}

/**
 * Monta `render/comp/` (o projeto Hyperframes) a partir das cenas, ordem, transições e áudio.
 * Síncrono e barato (arquivos pequenos + cópia de assets só quando falta); roda a cada mudança.
 * Devolve a pasta. Fontes que não vêm com o Nexos ficam no fallback do DS (loga uma vez).
 */
export function comporVideo(projectPath: string, home: string, videoId: string): string {
  const meta = lerMeta(projectPath, home, videoId);
  const linha = linhaDoTempo(meta);
  const fmt = FORMATOS[meta.formato];
  const pasta = pastaDoVideo(projectPath, home, videoId, true);
  const comp = join(pasta, "render", "comp");
  const ds = dsDoProjeto(projectPath, home);
  const assets = pastaDeAssets();

  // família com arquivo local vira @font-face (render sem rede): as que vêm com o Nexos e as baixadas
  const fontes: { familia: string; arquivo: string; de: string }[] = [];
  const semFonte: string[] = [];
  for (const f of familiasDoDs(ds)) {
    const nome = nomeDaFamilia(f);
    const embutida = FONTES_EMBUTIDAS[f];
    const baixada = join(pastaFontesBaixadas(home), arquivoDaFonteBaixada(f));
    if (embutida) fontes.push({ familia: nome, arquivo: `fontes/${embutida}`, de: join(assets, "fontes", embutida) });
    else if (existsSync(baixada)) fontes.push({ familia: nome, arquivo: `fontes/${arquivoDaFonteBaixada(f)}`, de: baixada });
    else if (!FAMILIAS_GENERICAS.test(f)) semFonte.push(f);
  }
  if (semFonte.length) log.avisoUmaVez(`video-fontes:${semFonte.join(",")}`, "video", `fontes do DS sem arquivo local pro vídeo — saem no fallback: ${semFonte.join(", ")}`);

  mkdirSync(join(comp, "compositions"), { recursive: true });
  mkdirSync(join(comp, "previa"), { recursive: true });
  mkdirSync(join(comp, "assets", "fontes"), { recursive: true });
  const copiar = (de: string, para: string) => {
    if (existsSync(para) && statSync(para).size === statSync(de).size) return;
    mkdirSync(dirname(para), { recursive: true });
    cpSync(de, para);
  };
  copiar(join(assets, "js", "gsap.min.js"), join(comp, "assets", "gsap.min.js"));
  for (const f of fontes) copiar(f.de, join(comp, "assets", f.arquivo));
  escreverSeMudou(join(comp, "assets", "base.css"), cssBase(ds, fontes));

  // áudio: só o que o vídeo usa
  const m = meta.audio.musica;
  if (m?.fonte.startsWith("nexos:") && ID_ARQ_MUSICA.test(m.fonte.slice(6))) {
    copiar(join(assets, "musicas", `${m.fonte.slice(6)}.mp3`), join(comp, "assets", "musica", `${m.fonte.slice(6)}.mp3`));
  } else if (m?.fonte.startsWith("propria:")) {
    const arq = m.fonte.slice(8);
    const de = join(pasta, "audio", arq);
    if (ARQ_RE.test(arq) && existsSync(de)) copiar(de, join(comp, "assets", "musica", arq));
  }
  for (const e of meta.audio.efeitos) if (efeitoExiste(e.arquivo)) copiar(join(assets, "efeitos", e.arquivo), join(comp, "assets", "efeitos", e.arquivo));

  // cenas: sub-composition (render) + documento de prévia (card do Canvas)
  const vivas = new Set<string>();
  for (const c of meta.cenas) {
    const bruto = htmlDaCena(projectPath, home, videoId, c.id);
    escreverSeMudou(join(comp, "compositions", `cena-${c.id}.html`), documentoDaCena(c, arquivosDoProjeto(bruto, projectPath, comp, ""), fmt));
    escreverSeMudou(
      join(comp, "previa", `cena-${c.id}.html`),
      documentoDaCena(c, arquivosDoProjeto(bruto, projectPath, comp, "../"), fmt, { previa: true, prefixo: "../" }),
    );
    vivas.add(`cena-${c.id}.html`);
  }
  for (const sub of ["compositions", "previa"]) {
    for (const f of readdirSync(join(comp, sub))) if (f.startsWith("cena-") && !vivas.has(f)) rmSync(join(comp, sub, f), { force: true });
  }
  escreverSeMudou(join(comp, "index.html"), documentoRaiz(meta, linha));
  escreverSeMudou(join(comp, "player.html"), documentoPlayer(meta, linha));
  escreverSeMudou(
    join(comp, "hyperframes.json"),
    `${JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2)}\n`,
  );
  escreverSeMudou(join(comp, "meta.json"), `${JSON.stringify({ id: videoId, name: meta.nome }, null, 2)}\n`);
  return comp;
}

/**
 * Imagem relativa numa cena (o logo em `public/logo.svg`, igual nos cards do DS) é relativa à RAIZ
 * DO PROJETO. O render não enxerga o repo: copia o arquivo pra `assets/projeto/` da composição e
 * reescreve o `src`/`url()`. O HTML gravado da cena não muda. Caminho que escapa do projeto ou não
 * existe fica como está (o `hyperframes check` aponta).
 */
export function arquivosDoProjeto(html: string, projectPath: string, comp: string, prefixo: string): string {
  const raiz = resolve(projectPath);
  const trocar = (rel: string): string | null => {
    if (!rel || /^(data:|https?:|blob:|#|\/\/|assets\/)/i.test(rel) || rel.includes("..")) return null;
    const limpo = rel.replace(/^\.?\//, "").split(/[?#]/)[0]!;
    const de = resolve(raiz, limpo);
    if (!de.startsWith(raiz) || !existsSync(de) || !statSync(de).isFile()) return null;
    const para = join(comp, "assets", "projeto", limpo);
    if (!existsSync(para) || statSync(para).size !== statSync(de).size) {
      mkdirSync(dirname(para), { recursive: true });
      cpSync(de, para);
    }
    return `${prefixo}assets/projeto/${limpo.replace(/\\/g, "/")}`;
  };
  return html
    .replace(/(\s(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi, (m, a: string, q: string, v: string) => {
      const novo = trocar(v);
      return novo ? `${a}${q}${novo}${q}` : m;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q: string, v: string) => {
      const novo = trocar(v);
      return novo ? `url(${q}${novo}${q})` : m;
    });
}

function escreverSeMudou(caminho: string, conteudo: string): void {
  try {
    if (readFileSync(caminho, "utf8") === conteudo) return;
  } catch {
    /* não existe ainda */
  }
  escreverAtomico(caminho, conteudo);
}

/** Assinatura da composição atual (cache do check/snapshot). */
export function assinaturaDaComposicao(comp: string): string {
  const partes: string[] = [];
  for (const f of ["index.html", "assets/base.css", ...readdirSync(join(comp, "compositions")).map((x) => `compositions/${x}`)]) {
    try {
      partes.push(f, readFileSync(join(comp, f), "utf8"));
    } catch {
      /* sumiu no meio: entra vazio */
    }
  }
  return assinatura(partes);
}
