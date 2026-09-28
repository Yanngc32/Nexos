import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { killTreeAsync } from "./kill-tree.ts";
import { log } from "./log.ts";
import { spawnBin } from "./spawn-bin.ts";
import { dsDoProjeto } from "./design-system.ts";
import {
  arquivoDaFonteBaixada,
  FAMILIAS_GENERICAS,
  familiasDoDs,
  nomeDaFamilia,
  pastaFontesBaixadas,
  assinaturaDaComposicao,
  avisarVideo,
  comporVideo,
  HYPERFRAMES_VERSAO,
  lerMeta,
  linhaDoTempo,
  pastaDoVideo,
  type InfoRender,
} from "./video.ts";

/**
 * Motor de vídeo: roda a CLI do Hyperframes (`npx hyperframes@<versão fixa>`) em processo filho
 * ASSÍNCRONO — nada de spawnSync (lição do `congelamento.ts`: o motor não pode parar de atender).
 * Medido no spike: render de 19,5 s em ~27 s com atraso máximo de 14 ms no event loop.
 *
 * - UM render por vez (Chrome headless frame a frame pesa ~1,5 GB); segundo pedido é recusado.
 * - Cancelar mata a ÁRVORE (npx → node → chrome-headless-shell/ffmpeg) com `killTreeAsync`.
 * - Falha loga o stderr do hyperframes e devolve uma frase clara pra UI.
 * - Telemetria do Hyperframes fica como vem (decisão do plano; PRIVACY.md explica como desligar).
 */

export type QualidadeRender = "draft" | "high";

export type EstadoRender = {
  projectPath: string;
  videoId: string;
  qualidade: QualidadeRender;
  frame: number;
  frames: number;
  pct: number;
  fase: string;
  inicio: number;
};

let renderAtual: (EstadoRender & { filho: ChildProcess; cancelado: boolean }) | null = null;

export function renderEmAndamento(): EstadoRender | null {
  if (!renderAtual) return null;
  const { filho: _f, cancelado: _c, ...e } = renderAtual;
  return e;
}

/* ---------------------------------------------------------------------------
 * FFmpeg
 * ------------------------------------------------------------------------- */

/** Onde o `winget install Gyan.FFmpeg` põe o atalho: não entra no PATH de processo que já rodava. */
function pastaWingetLinks(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(local, "Microsoft", "WinGet", "Links");
}

/** PATH do filho: o do motor + a pasta do winget (FFmpeg instalado depois do motor subir). */
export function envDoMotor(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") {
    const chave = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
    const links = pastaWingetLinks();
    if (!(env[chave] ?? "").toLowerCase().includes(links.toLowerCase())) env[chave] = `${env[chave] ?? ""}${delimiter}${links}`;
  }
  // `npx` não pode parar pra perguntar "Ok to proceed?" (stdin fechado = trava)
  env.npm_config_yes = "true";
  env.HYPERFRAMES_SKIP_SKILLS = "1";
  return env;
}

export type StatusFfmpeg = { instalado: boolean; versao?: string; caminho?: string; motivo?: string };
let cacheFfmpeg: { em: number; st: StatusFfmpeg } | null = null;

/** `ffmpeg -version` assíncrono, cache de 30 s (a faixa do painel pergunta em todo GET). */
export function statusFfmpeg(forcar = false): Promise<StatusFfmpeg> {
  if (!forcar && cacheFfmpeg && Date.now() - cacheFfmpeg.em < 30_000) return Promise.resolve(cacheFfmpeg.st);
  return new Promise((resolve) => {
    const fim = (st: StatusFfmpeg) => {
      cacheFfmpeg = { em: Date.now(), st };
      resolve(st);
    };
    let saida = "";
    let filho: ChildProcess;
    try {
      filho = spawn("ffmpeg", ["-hide_banner", "-version"], { env: envDoMotor(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log.aviso("video", "não consegui procurar o FFmpeg", { erro: (e as Error).message });
      return fim({ instalado: false, motivo: "FFmpeg não encontrado no PATH" });
    }
    const t = setTimeout(() => {
      filho.kill();
      log.aviso("video", "ffmpeg -version não respondeu em 10 s");
      fim({ instalado: false, motivo: "FFmpeg não respondeu" });
    }, 10_000);
    filho.stdout?.on("data", (d: Buffer) => (saida += d.toString()));
    filho.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(t);
      // ENOENT é o caso previsto (não instalado): calado. Outro erro loga a causa.
      if (e.code !== "ENOENT") log.aviso("video", "erro ao rodar ffmpeg -version", { erro: e.message, codigo: e.code });
      fim({ instalado: false, motivo: "FFmpeg não encontrado no PATH" });
    });
    filho.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) return fim({ instalado: false, motivo: `ffmpeg -version saiu com ${code}` });
      const versao = /ffmpeg version (\S+)/.exec(saida)?.[1];
      fim({ instalado: true, ...(versao ? { versao } : {}) });
    });
  });
}

/* ---------------------------------------------------------------------------
 * Rodar a CLI
 * ------------------------------------------------------------------------- */

export type SaidaCli = { codigo: number | null; stdout: string; stderr: string; cancelado: boolean; erroSpawn?: string };

/** Frase clara pra UI a partir da saída crua (nunca o erro do npm cru). */
export function motivoDaFalha(s: SaidaCli): string {
  const tudo = `${s.stderr}\n${s.stdout}`;
  if (s.erroSpawn) return /ENOENT/.test(s.erroSpawn) ? "Node/npx não encontrado — o motor de vídeo precisa do npx" : `Não consegui rodar o motor de vídeo: ${s.erroSpawn}`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|getaddrinfo|registry\.npmjs\.org/i.test(tudo) && /npm (ERR|error)/i.test(tudo)) {
    return "Precisa de internet pra baixar o motor de vídeo na primeira vez";
  }
  if (/ffmpeg/i.test(tudo) && /not found|não encontrado|ENOENT|missing/i.test(tudo)) return "FFmpeg não encontrado no PATH";
  const linhas = tudo
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && !/^\[INFO\]|^\s*█|Render:trace/.test(l));
  const erro = linhas.find((l) => /error|erro|✗|failed|falhou/i.test(l)) ?? linhas.at(-1) ?? "";
  return erro.slice(0, 300) || `o motor de vídeo saiu com código ${s.codigo}`;
}

/**
 * `npx` de verdade: o `npx.cmd` que vem com o Node no Windows não é shim do npm (o `spawnBin` não
 * acha o .js nele e cairia no shell). Resolve o `npx-cli.js` ao lado dele e roda com o `node.exe`
 * DA MESMA PASTA — não com `process.execPath`, que no app empacotado é o Electron (sem npm).
 * `where` assíncrono e cacheado: nada de spawnSync no caminho do painel.
 */
type Npx = { bin: string; prefixo: string[] } | null;
let npxCache: Promise<Npx> | null = null;
export function resolverNpx(): Promise<Npx> {
  if (process.platform !== "win32") return Promise.resolve({ bin: "npx", prefixo: [] });
  npxCache ??= new Promise<Npx>((resolve) => {
    let out = "";
    let filho: ChildProcess;
    try {
      filho = spawn("where", ["npx"], { env: envDoMotor(), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      log.aviso("video", "não consegui procurar o npx", { erro: (e as Error).message });
      resolve(null);
      return;
    }
    filho.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    filho.on("error", (e) => {
      log.aviso("video", "não consegui procurar o npx", { erro: e.message });
      resolve(null);
    });
    filho.on("close", () => {
      for (const l of out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
        const pasta = dirname(l);
        const cli = join(pasta, "node_modules", "npm", "bin", "npx-cli.js");
        const node = join(pasta, "node.exe");
        if (existsSync(cli) && existsSync(node)) return resolve({ bin: node, prefixo: [cli] });
      }
      if (!out.trim()) log.aviso("video", "npx não está no PATH — o motor de vídeo precisa do Node.js instalado");
      resolve(out.trim() ? { bin: "npx", prefixo: [] } : null);
    });
  });
  return npxCache;
}

async function rodarHyperframes(
  args: string[],
  cwd: string,
  opts: { aoLinha?: (linha: string) => void; aoFilho?: (f: ChildProcess) => void; timeoutMs?: number } = {},
): Promise<SaidaCli> {
  const npx = await resolverNpx();
  if (!npx) return { codigo: null, stdout: "", stderr: "", cancelado: false, erroSpawn: "ENOENT npx" };
  return new Promise((resolve) => {
    let filho: ChildProcess;
    try {
      const argv = [...npx.prefixo, "-y", `hyperframes@${HYPERFRAMES_VERSAO}`, ...args];
      const spawnOpts = { cwd, env: envDoMotor(), stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], windowsHide: true };
      filho = npx.prefixo.length ? spawn(npx.bin, argv, spawnOpts) : spawnBin(npx.bin, argv, spawnOpts);
    } catch (e) {
      resolve({ codigo: null, stdout: "", stderr: "", cancelado: false, erroSpawn: (e as Error).message });
      return;
    }
    opts.aoFilho?.(filho);
    let stdout = "";
    let stderr = "";
    let resto = "";
    const linhas = (d: Buffer, acc: "out" | "err") => {
      const s = d.toString("utf8");
      if (acc === "out") stdout = (stdout + s).slice(-200_000);
      else stderr = (stderr + s).slice(-200_000);
      if (!opts.aoLinha) return;
      const partes = (resto + s).split(/\r|\n/);
      resto = partes.pop() ?? "";
      for (const l of partes) if (l.trim()) opts.aoLinha(l);
    };
    filho.stdout?.on("data", (d: Buffer) => linhas(d, "out"));
    filho.stderr?.on("data", (d: Buffer) => linhas(d, "err"));
    let cancelado = false;
    // sem timeout curto: 1ª vez o npx baixa o pacote (spec: "Preparando motor de vídeo…")
    const t = opts.timeoutMs
      ? setTimeout(() => {
          cancelado = true;
          if (filho.pid) void killTreeAsync(filho.pid);
        }, opts.timeoutMs)
      : null;
    let erroSpawn: string | undefined;
    filho.on("error", (e) => (erroSpawn = e.message));
    filho.on("close", (codigo) => {
      if (t) clearTimeout(t);
      resolve({ codigo, stdout, stderr, cancelado, ...(erroSpawn ? { erroSpawn } : {}) });
    });
  });
}

/* ---------------------------------------------------------------------------
 * Fontes do DS que não vêm com o Nexos
 * ------------------------------------------------------------------------- */

const UA_FONTES = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const fontesTentadas = new Set<string>();

/**
 * O render é offline (`@font-face` local): família do DS que não vem com o Nexos é baixada do
 * Google Fonts UMA vez (subconjunto latin, fonte variável) pra `~/.nexos/video-fontes`. Falhou
 * (sem rede, família que não existe lá) = fallback do DS, com a causa no log.
 */
export async function garantirFontes(projectPath: string, home: string): Promise<void> {
  let familias: string[] = [];
  try {
    familias = familiasDoDs(dsDoProjeto(projectPath, home));
  } catch (e) {
    log.avisoUmaVez(`video-fontes-ds:${projectPath}`, "video", "não consegui ler o DS pra achar as fontes do vídeo", { erro: (e as Error).message });
    return;
  }
  const pasta = pastaFontesBaixadas(home);
  for (const f of familias) {
    if (FAMILIAS_GENERICAS.test(f) || ["inter", "inter tight", "jetbrains mono"].includes(f)) continue;
    const destino = join(pasta, arquivoDaFonteBaixada(f));
    if (existsSync(destino) || fontesTentadas.has(f)) continue;
    fontesTentadas.add(f);
    try {
      const nome = nomeDaFamilia(f).replace(/ /g, "+");
      const resp = await fetch(`https://fonts.googleapis.com/css2?family=${nome}:wght@400..700&display=swap`, { headers: { "user-agent": UA_FONTES }, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) throw new Error(`o Google Fonts respondeu ${resp.status}`);
      const css = await resp.text();
      const bloco = /\/\* latin \*\/[\s\S]*?url\((https:[^)]+\.woff2)\)/.exec(css) ?? /url\((https:[^)]+\.woff2)\)/.exec(css);
      if (!bloco) throw new Error("o Google Fonts não tem essa família");
      const r = await fetch(bloco[1]!, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      mkdirSync(pasta, { recursive: true });
      writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
      log.info("video", `fonte ${f} baixada pro vídeo`, { destino });
    } catch (e) {
      log.aviso("video", `não consegui baixar a fonte ${f} pro vídeo — sai no fallback`, { erro: (e as Error).message });
    }
  }
}

/* ---------------------------------------------------------------------------
 * Check
 * ------------------------------------------------------------------------- */

export type Achado = { severidade: "erro" | "aviso" | "info"; regra: string; msg: string; cena?: string; t?: number; dica?: string };
export type ResultadoCheck = { ok: boolean; erros: number; avisos: number; achados: Achado[]; motivo?: string };

const cacheCheck = new Map<string, { assinatura: string; r: ResultadoCheck }>();

type FindingHf = { code?: string; severity?: string; message?: string; sourceFile?: string; time?: number; fixHint?: string };

export function achadosDoCheck(j: Record<string, { findings?: FindingHf[] } | unknown>): Achado[] {
  const out: Achado[] = [];
  for (const secao of ["lint", "runtime", "layout", "motion", "contrast"]) {
    const s = j[secao] as { findings?: FindingHf[] } | undefined;
    for (const f of s?.findings ?? []) {
      const sev = f.severity === "error" ? "erro" : f.severity === "warning" ? "aviso" : "info";
      const cena = /cena-([a-z0-9-]+)\.html/.exec(f.sourceFile ?? "")?.[1];
      out.push({
        severidade: sev,
        regra: f.code ?? secao,
        msg: f.message ?? "",
        ...(cena ? { cena } : {}),
        ...(typeof f.time === "number" ? { t: f.time } : {}),
        ...(f.fixHint ? { dica: f.fixHint } : {}),
      });
    }
  }
  return out;
}

export async function checarVideo(projectPath: string, home: string, videoId: string): Promise<ResultadoCheck> {
  await garantirFontes(projectPath, home);
  const comp = comporVideo(projectPath, home, videoId);
  const chave = `${projectPath}|${videoId}`;
  const ass = assinaturaDaComposicao(comp);
  const cache = cacheCheck.get(chave);
  if (cache && cache.assinatura === ass) return cache.r;
  avisarVideo(projectPath, { type: "check", id: videoId, estado: "rodando" });
  const s = await rodarHyperframes(["check", "--json"], comp, { timeoutMs: 10 * 60_000 });
  let r: ResultadoCheck;
  try {
    const ini = s.stdout.indexOf("{");
    const j = JSON.parse(s.stdout.slice(ini)) as Record<string, unknown> & { ok?: boolean };
    const achados = achadosDoCheck(j);
    r = { ok: !!j.ok, erros: achados.filter((a) => a.severidade === "erro").length, avisos: achados.filter((a) => a.severidade === "aviso").length, achados };
  } catch {
    const motivo = motivoDaFalha(s);
    log.aviso("video", `hyperframes check falhou em ${videoId}: ${motivo}`, { codigo: s.codigo, stderr: s.stderr.slice(-2000) });
    r = { ok: false, erros: 1, avisos: 0, achados: [], motivo };
  }
  if (!r.motivo) cacheCheck.set(chave, { assinatura: ass, r });
  avisarVideo(projectPath, { type: "check", id: videoId, estado: "pronto", resultado: r });
  return r;
}

/* ---------------------------------------------------------------------------
 * Snapshot (frame no tempo t) — `nexo_video_print`, frame do meio da transição, capa
 * ------------------------------------------------------------------------- */

export type Snapshot = { ok: true; png: Buffer; t: number } | { ok: false; motivo: string };

export async function snapshotVideo(projectPath: string, home: string, videoId: string, t: number): Promise<Snapshot> {
  await garantirFontes(projectPath, home);
  const comp = comporVideo(projectPath, home, videoId);
  const total = linhaDoTempo(lerMeta(projectPath, home, videoId)).total;
  if (total <= 0) return { ok: false, motivo: "o vídeo não tem cena" };
  const tt = Math.max(0, Math.min(total - 0.001, t));
  const dir = join(comp, "..", "snaps", `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const s = await rodarHyperframes(["snapshot", "--at", tt.toFixed(3), "--no-end", "-o", dir, "--describe", "false"], comp, { timeoutMs: 3 * 60_000 });
  try {
    const png = readdirSync(dir).find((f) => f.endsWith(".png"));
    if (s.codigo === 0 && png) return { ok: true, png: readFileSync(join(dir, png)), t: tt };
    const motivo = motivoDaFalha(s);
    log.aviso("video", `snapshot de ${videoId} em ${tt}s falhou: ${motivo}`, { codigo: s.codigo, stderr: s.stderr.slice(-2000) });
    return { ok: false, motivo };
  } catch (e) {
    const motivo = motivoDaFalha(s);
    log.aviso("video", `snapshot de ${videoId} em ${tt}s não gerou arquivo: ${motivo}`, { erro: (e as Error).message, stderr: s.stderr.slice(-2000) });
    return { ok: false, motivo };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------------------
 * Batidas de música própria
 * ------------------------------------------------------------------------- */

export async function calcularBatidas(projectPath: string, home: string, videoId: string, arquivo: string): Promise<{ ok: boolean; motivo?: string; quantas?: number }> {
  const pasta = pastaDoVideo(projectPath, home, videoId, false);
  const tmp = join(pasta, "render", "batidas");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "assets"), { recursive: true });
  try {
    writeFileSync(join(tmp, "assets", "m.bin"), readFileSync(join(pasta, "audio", arquivo)));
    renameSync(join(tmp, "assets", "m.bin"), join(tmp, "assets", arquivo));
    writeFileSync(
      join(tmp, "index.html"),
      `<!doctype html><html><body><div data-composition-id="main" data-width="1080" data-height="1080" data-duration="1"><audio id="musica" data-timeline-role="music" src="assets/${arquivo}" data-start="0" data-duration="1"></audio></div></body></html>`,
    );
    const s = await rodarHyperframes(["beats", "--json"], tmp, { timeoutMs: 5 * 60_000 });
    const j = JSON.parse(s.stdout.slice(s.stdout.indexOf("{"))) as { ok?: boolean; file?: string; count?: number };
    if (!j.ok || !j.file) throw new Error(motivoDaFalha(s));
    writeFileSync(join(pasta, "audio", `${arquivo}.beats.json`), readFileSync(join(tmp, j.file)));
    avisarVideo(projectPath, { type: "video-mudou", id: videoId });
    return { ok: true, quantas: j.count ?? 0 };
  } catch (e) {
    log.aviso("video", `batidas de ${arquivo} não saíram — a música entra sem guia`, { erro: (e as Error).message });
    return { ok: false, motivo: "Não achei as batidas; a música entra sem guia" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------------------
 * Render
 * ------------------------------------------------------------------------- */

function nomeDoMp4(nome: string): string {
  return `${
    nome
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "video"
  }.mp4`;
}

export type ResultadoRender = { ok: true; info: InfoRender } | { ok: false; motivo: string; cancelado?: boolean };

/**
 * Dispara o render e devolve logo (o progresso vai por SSE). Erro síncrono só pra "já tem um
 * rodando" e "sem FFmpeg" — o resto chega no evento `render` com `estado: "falhou"`.
 */
export async function iniciarRender(projectPath: string, home: string, videoId: string, qualidade: QualidadeRender): Promise<{ fim: Promise<ResultadoRender> }> {
  if (renderAtual) throw Object.assign(new Error("Já tem um render rodando"), { status: 409 });
  const ff = await statusFfmpeg(true);
  if (!ff.instalado) throw Object.assign(new Error("Pra renderizar precisa do FFmpeg. FFmpeg não encontrado no PATH"), { status: 412, ffmpegNaoInstalado: true });
  if (renderAtual) throw Object.assign(new Error("Já tem um render rodando"), { status: 409 });
  const meta = lerMeta(projectPath, home, videoId);
  const linha = linhaDoTempo(meta);
  if (!linha.cenas.length) throw Object.assign(new Error("o vídeo não tem cena"), { status: 400 });
  await garantirFontes(projectPath, home);
  const comp = comporVideo(projectPath, home, videoId);
  const pastaRender = join(pastaDoVideo(projectPath, home, videoId, true), "render");
  const arquivo = nomeDoMp4(meta.nome);
  const temp = join(pastaRender, `.${arquivo}.parcial.mp4`);
  rmSync(temp, { force: true });
  const frames = Math.round(linha.total * 30);
  const estado: EstadoRender = { projectPath, videoId, qualidade, frame: 0, frames, pct: 0, fase: "Preparando motor de vídeo…", inicio: Date.now() };
  // o lugar fica reservado já, antes do spawn: um segundo clique no meio do await não passa
  renderAtual = { ...estado, filho: null as unknown as ChildProcess, cancelado: false };
  const emitir = () => {
    const e = renderEmAndamento();
    if (e) avisarVideo(projectPath, { type: "render", id: videoId, estado: "rodando", progresso: e });
  };
  emitir();
  let ultimoEnvio = 0;
  const t0 = Date.now();
  const promessa = rodarHyperframes(["render", "--quality", qualidade, "-o", temp], comp, {
    aoFilho: (f) => {
      if (renderAtual) renderAtual.filho = f;
    },
    aoLinha: (l) => {
      if (!renderAtual) return;
      const limpa = l.replace(/\x1b\[[0-9;]*m/g, "");
      // só a linha de captura ("Streaming frame 214/585"): outras etapas também imprimem N/M
      const m = /frame\s+(\d+)\s*\/\s*(\d+)/i.exec(limpa);
      if (m) {
        renderAtual.frame = Number(m[1]);
        renderAtual.frames = Number(m[2]) || renderAtual.frames;
        renderAtual.pct = Math.min(99, Math.round((renderAtual.frame / Math.max(1, renderAtual.frames)) * 100));
        renderAtual.fase = "Renderizando";
      } else if (/assembl/i.test(limpa)) {
        renderAtual.fase = "Juntando áudio e vídeo";
        renderAtual.pct = Math.max(renderAtual.pct, 95);
      } else if (/setup|launch|browser|compil/i.test(limpa) && renderAtual.fase.startsWith("Preparando")) {
        renderAtual.fase = "Abrindo o navegador de render";
      }
      // no máximo 4 eventos por segundo: o SSE não vira gargalo
      if (Date.now() - ultimoEnvio > 250) {
        ultimoEnvio = Date.now();
        emitir();
      }
    },
  }).then((s): ResultadoRender => {
    const cancelado = renderAtual?.cancelado ?? false;
    renderAtual = null;
    if (cancelado) {
      rmSync(temp, { force: true });
      log.info("video", `render de ${videoId} cancelado`);
      avisarVideo(projectPath, { type: "render", id: videoId, estado: "cancelado" });
      return { ok: false, motivo: "cancelado", cancelado: true };
    }
    if (s.codigo !== 0 || !existsSync(temp)) {
      const motivo = motivoDaFalha(s);
      log.aviso("video", `render de ${videoId} falhou: ${motivo}`, { codigo: s.codigo, stderr: s.stderr.slice(-4000), stdout: s.stdout.slice(-2000) });
      rmSync(temp, { force: true });
      avisarVideo(projectPath, { type: "render", id: videoId, estado: "falhou", motivo, log: `${s.stderr}\n${s.stdout}`.slice(-6000) });
      return { ok: false, motivo };
    }
    const destino = join(pastaRender, arquivo);
    rmSync(destino, { force: true });
    renameSync(temp, destino);
    const info: InfoRender = {
      arquivo,
      caminho: destino,
      bytes: statSync(destino).size,
      duracao: linha.total,
      qualidade,
      em: new Date().toISOString(),
    };
    writeFileSync(join(pastaRender, "info.json"), JSON.stringify({ ...info, caminho: undefined }, null, 2));
    log.info("video", `render de ${videoId} pronto em ${Math.round((Date.now() - t0) / 100) / 10} s`, { bytes: info.bytes, qualidade });
    avisarVideo(projectPath, { type: "render", id: videoId, estado: "pronto", info });
    return { ok: true, info };
  });
  // objeto e não a promessa direto: `async` achataria e a rota esperaria o render inteiro
  return { fim: promessa };
}

export async function cancelarRender(): Promise<boolean> {
  const r = renderAtual;
  if (!r) return false;
  r.cancelado = true;
  if (r.filho?.pid) await killTreeAsync(r.filho.pid);
  return true;
}

/** Capa: o frame escolhido (o melhor já assentado, não o frame 0) em render/capa.png. */
export async function gerarCapa(projectPath: string, home: string, videoId: string, t: number): Promise<{ ok: boolean; caminho?: string; motivo?: string }> {
  const s = await snapshotVideo(projectPath, home, videoId, t);
  if (!s.ok) return { ok: false, motivo: s.motivo };
  const caminho = join(pastaDoVideo(projectPath, home, videoId, true), "render", "capa.png");
  writeFileSync(caminho, s.png);
  avisarVideo(projectPath, { type: "video-mudou", id: videoId });
  return { ok: true, caminho };
}

export function resetVideoMotorForTest(): void {
  fontesTentadas.clear();
  renderAtual = null;
  npxCache = null;
  cacheCheck.clear();
  cacheFfmpeg = null;
}
