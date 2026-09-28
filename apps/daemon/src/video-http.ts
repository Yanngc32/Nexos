import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { log } from "./log.ts";
import { RaizIndisponivelError } from "./projeto-dir.ts";
import {
  apagarCena,
  apagarVideo,
  batidasDaMusica,
  canalVideo,
  catalogoDeEfeitos,
  comporVideo,
  criarVideo,
  definirMusica,
  definirTransicao,
  desfazerTransicao,
  duplicarCena,
  gravarMusicaPropria,
  importarTela,
  lerMeta,
  lerVideo,
  listarVideos,
  mudarVideo,
  musicasDoNexos,
  ordenarCenas,
  pastaDeAssets,
  pastaDoVideo,
  removerEfeito,
  restaurarEfeitos,
  salvarCena,
  salvarEfeito,
  telasImportaveis,
  textoParaPostar,
  transicoesPersonalizadas,
  videoBus,
  type Efeito,
} from "./video.ts";
import { calcularBatidas, cancelarRender, checarVideo, gerarCapa, iniciarRender, renderEmAndamento, snapshotVideo, statusFfmpeg } from "./video-motor.ts";

/**
 * Rotas do painel de vídeo (`/v1/videos/*`, com bearer como todo `/v1`) e a PRÉVIA
 * (`/video-previa/<chave>/*`, sem bearer): o card de cena no Canvas é um iframe que carrega o
 * MESMO documento que o render usa. iframe não manda header de auth, e srcdoc herdaria o CSP do
 * app (que bloqueia script) — então a prévia sai do daemon por uma URL de capacidade: chave
 * aleatória de 128 bits por vídeo, entregue a quem já tem o token (campo `previa` do `GET /v1/videos/:id`), servindo só
 * arquivos de `render/comp` daquele vídeo.
 */

type Previa = { projectPath: string; videoId: string };
const previas = new Map<string, Previa>();
const chavePorVideo = new Map<string, string>();

export function chaveDePrevia(projectPath: string, videoId: string): string {
  const k = `${resolve(projectPath).toLowerCase()}|${videoId}`;
  let chave = chavePorVideo.get(k);
  if (!chave) {
    chave = randomBytes(16).toString("hex");
    chavePorVideo.set(k, chave);
    previas.set(chave, { projectPath, videoId });
  }
  return chave;
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".json": "application/json",
};

/** Arquivo dentro de `raiz`, sem escapar dela (`..`, caminho absoluto, barra invertida). */
function dentroDe(raiz: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const alvo = normalize(join(raiz, rel));
  const base = normalize(raiz.endsWith(sep) ? raiz : raiz + sep);
  return alvo.startsWith(base) ? alvo : null;
}

function servirArquivo(c: Context, caminho: string, cachear = false): Response {
  const st = statSync(caminho);
  const tipo = TIPOS[extname(caminho).toLowerCase()] ?? "application/octet-stream";
  const range = c.req.header("range");
  // <audio>/<video> pedem por faixa: sem 206 o Chrome não deixa buscar posição (seek) no áudio
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    const ini = m[1] ? Number(m[1]) : 0;
    const fim = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (ini <= fim && ini < st.size) {
      return new Response(Readable.toWeb(createReadStream(caminho, { start: ini, end: fim })) as ReadableStream, {
        status: 206,
        headers: { "content-type": tipo, "content-length": String(fim - ini + 1), "content-range": `bytes ${ini}-${fim}/${st.size}`, "accept-ranges": "bytes", "cache-control": "no-store" },
      });
    }
  }
  if (!cachear) {
    return new Response(Readable.toWeb(createReadStream(caminho)) as ReadableStream, {
      headers: { "content-type": tipo, "content-length": String(st.size), "accept-ranges": "bytes", "cache-control": "no-store" },
    });
  }
  // prévia: cada card de cena é um iframe que pede gsap/base.css/fontes — revalida (304) em vez de baixar de novo
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const cab = { etag, "cache-control": "no-cache", "accept-ranges": "bytes" };
  if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: cab });
  return new Response(Readable.toWeb(createReadStream(caminho)) as ReadableStream, {
    headers: { ...cab, "content-type": tipo, "content-length": String(st.size) },
  });
}

export function registrarRotasDeVideo(app: Hono, home: string): void {
  const falha = (c: Context, e: unknown) => {
    if (e instanceof RaizIndisponivelError) throw e; // vira 503 no onError, igual ao resto
    const err = e as Error & { status?: number; ffmpegNaoInstalado?: boolean };
    return c.json({ error: err.message, ...(err.ffmpegNaoInstalado ? { ffmpegNaoInstalado: true } : {}) }, (err.status ?? 400) as 400);
  };
  const pp = (c: Context) => c.req.query("projectPath") || "";
  const semProjeto = (c: Context) => c.json({ error: "projectPath obrigatório" }, 400);
  const corpo = async <T>(c: Context) => (await c.req.json().catch(() => ({}))) as T;

  /** Estado + prévia de um vídeo (o que o painel precisa pra desenhar tudo). */
  const completo = async (projectPath: string, id: string) => {
    const v = lerVideo(projectPath, home, id);
    comporVideo(projectPath, home, id);
    const r = renderEmAndamento();
    return {
      ...v,
      previa: `/video-previa/${chaveDePrevia(projectPath, id)}/`,
      ffmpeg: await statusFfmpeg(),
      renderando: r && r.projectPath === projectPath ? r : null,
      batidas: batidasDaMusica(projectPath, home, id, v.audio.musica),
      personalizadas: transicoesPersonalizadas(v),
      textoParaPostar: textoParaPostar(v),
      capa: existsSync(join(v.pastaAbs, "render", "capa.png")) ? join(v.pastaAbs, "render", "capa.png") : null,
    };
  };

  app.get("/v1/videos", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      return c.json({ videos: listarVideos(projectPath, home), ffmpeg: await statusFfmpeg() });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ nome?: unknown; formato?: unknown }>(c);
      const meta = criarVideo(projectPath, home, b);
      return c.json(await completo(projectPath, meta.id), 201);
    } catch (e) {
      return falha(c, e);
    }
  });

  /** Músicas do Nexos, catálogo de efeitos e telas do DS importáveis. */
  app.get("/v1/videos/catalogo", (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      return c.json({
        musicas: musicasDoNexos().map(({ arquivo: _a, ...m }) => m),
        efeitos: catalogoDeEfeitos(),
        telas: telasImportaveis(projectPath, home),
      });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.get("/v1/videos/ffmpeg", async (c) => c.json(await statusFfmpeg(c.req.query("forcar") === "1")));

  app.get("/v1/videos/render", (c) => c.json({ render: renderEmAndamento() }));
  app.delete("/v1/videos/render", async (c) => c.json({ cancelado: await cancelarRender() }));

  app.get("/v1/videos/events", (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    return streamSSE(c, async (stream) => {
      const canal = canalVideo(projectPath);
      const ouvir = (ev: unknown) => void stream.writeSSE({ data: JSON.stringify(ev) });
      videoBus.on(canal, ouvir);
      await new Promise<void>((res) => stream.onAbort(() => res()));
      videoBus.off(canal, ouvir);
    });
  });

  app.get("/v1/videos/:id", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  app.patch("/v1/videos/:id", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      mudarVideo(projectPath, home, c.req.param("id"), await corpo(c));
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  app.delete("/v1/videos/:id", (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      apagarVideo(projectPath, home, c.req.param("id"));
      return c.json({ ok: true });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.put("/v1/videos/:id/ordem", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ ordem?: unknown }>(c);
      ordenarCenas(projectPath, home, c.req.param("id"), b.ordem);
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/cenas", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const r = salvarCena(projectPath, home, c.req.param("id"), await corpo(c));
      return c.json({ cena: r.cena, avisos: r.avisos, video: await completo(projectPath, c.req.param("id")) }, 201);
    } catch (e) {
      return falha(c, e);
    }
  });

  app.put("/v1/videos/:id/cenas/:cena", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<Record<string, unknown>>(c);
      const r = salvarCena(projectPath, home, c.req.param("id"), { ...b, id: c.req.param("cena") });
      return c.json({ cena: r.cena, avisos: r.avisos, video: await completo(projectPath, c.req.param("id")) });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.delete("/v1/videos/:id/cenas/:cena", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const r = apagarCena(projectPath, home, c.req.param("id"), c.req.param("cena"));
      return c.json({ efeitosRemovidos: r.efeitosRemovidos, video: await completo(projectPath, c.req.param("id")) });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/cenas/:cena/duplicar", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const r = duplicarCena(projectPath, home, c.req.param("id"), c.req.param("cena"));
      return c.json({ cena: r.cena, video: await completo(projectPath, c.req.param("id")) }, 201);
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/importar", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ sistema?: string; card?: string }>(c);
      const r = importarTela(projectPath, home, c.req.param("id"), String(b.sistema ?? ""), String(b.card ?? ""));
      return c.json({ cena: r.cena, video: await completo(projectPath, c.req.param("id")) }, 201);
    } catch (e) {
      return falha(c, e);
    }
  });

  app.put("/v1/videos/:id/transicoes", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const r = definirTransicao(projectPath, home, c.req.param("id"), await corpo(c));
      return c.json({ transicao: r.transicao, limitada: r.limitada, maximo: r.maximo, video: await completo(projectPath, c.req.param("id")) });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/transicoes/desfazer", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ de?: string; para?: string }>(c);
      desfazerTransicao(projectPath, home, c.req.param("id"), String(b.de ?? ""), String(b.para ?? ""));
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  app.put("/v1/videos/:id/musica", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ fonte?: unknown; volume?: unknown; repetir?: unknown; duracao?: unknown } | null>(c);
      definirMusica(projectPath, home, c.req.param("id"), b);
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  /** Música própria: corpo cru (o arquivo), nome no `?nome=`; calcula as batidas em seguida. */
  app.post("/v1/videos/:id/musica/arquivo", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    const id = c.req.param("id");
    try {
      const dados = Buffer.from(await c.req.arrayBuffer());
      const arq = gravarMusicaPropria(projectPath, home, id, c.req.query("nome") || "musica.mp3", dados);
      definirMusica(projectPath, home, id, { fonte: `propria:${arq}`, duracao: c.req.query("duracao") ? Number(c.req.query("duracao")) : undefined });
      const batidas = await calcularBatidas(projectPath, home, id, arq);
      return c.json({ arquivo: arq, batidas, video: await completo(projectPath, id) }, 201);
    } catch (e) {
      return falha(c, e);
    }
  });

  app.put("/v1/videos/:id/efeitos", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const r = salvarEfeito(projectPath, home, c.req.param("id"), await corpo(c));
      return c.json({ efeito: r.efeito, naBatida: r.naBatida, video: await completo(projectPath, c.req.param("id")) });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.delete("/v1/videos/:id/efeitos/:efeito", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      removerEfeito(projectPath, home, c.req.param("id"), c.req.param("efeito"));
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/efeitos/restaurar", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ efeitos?: Efeito[] }>(c);
      restaurarEfeitos(projectPath, home, c.req.param("id"), Array.isArray(b.efeitos) ? b.efeitos : []);
      return c.json(await completo(projectPath, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/check", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      return c.json(await checarVideo(projectPath, home, c.req.param("id")));
    } catch (e) {
      return falha(c, e);
    }
  });

  /** Frame no tempo `t` (PNG) — frame do meio da transição, conferência do agente. */
  app.post("/v1/videos/:id/snapshot", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ t?: number }>(c);
      const s = await snapshotVideo(projectPath, home, c.req.param("id"), Number(b.t) || 0);
      if (!s.ok) return c.json({ error: `Não consegui gerar o frame: ${s.motivo}` }, 422);
      return c.json({ t: s.t, png: `data:image/png;base64,${s.png.toString("base64")}` });
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/render", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ qualidade?: string }>(c);
      const qualidade = b.qualidade === "high" || b.qualidade === "final" ? "high" : "draft";
      const r = await iniciarRender(projectPath, home, c.req.param("id"), qualidade);
      // o resultado vai por SSE; aqui só registra falha inesperada (o evento já foi emitido)
      r.fim.catch((e: Error) => log.erro("video", `render de ${c.req.param("id")} quebrou`, { erro: e.message }));
      return c.json({ ok: true, render: renderEmAndamento() }, 202);
    } catch (e) {
      return falha(c, e);
    }
  });

  app.post("/v1/videos/:id/capa", async (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const b = await corpo<{ t?: number }>(c);
      const meta = lerMeta(projectPath, home, c.req.param("id"));
      const t = typeof b.t === "number" ? b.t : (meta.capaEm ?? 0);
      const r = await gerarCapa(projectPath, home, c.req.param("id"), t);
      if (!r.ok) return c.json({ error: `Não consegui gerar a capa: ${r.motivo}` }, 422);
      return c.json({ caminho: r.caminho });
    } catch (e) {
      return falha(c, e);
    }
  });

  /** MP4 renderizado (o app abre/mostra na pasta pelo caminho; isto serve o player). */
  app.get("/v1/videos/:id/mp4", (c) => {
    const projectPath = pp(c);
    if (!projectPath) return semProjeto(c);
    try {
      const v = lerVideo(projectPath, home, c.req.param("id"));
      if (!v.render) return c.json({ error: "Não renderizado aqui" }, 404);
      return servirArquivo(c, v.render.caminho);
    } catch (e) {
      return falha(c, e);
    }
  });

  /* ---------- prévia: sem bearer, só com a chave ---------- */

  app.get("/video-previa/:chave/*", (c) => {
    const p = previas.get(c.req.param("chave"));
    if (!p) return c.text("prévia expirada — reabra o painel", 404);
    const rel = decodeURIComponent(c.req.path.split("/").slice(3).join("/")) || "player.html";
    try {
      const comp = join(pastaDoVideo(p.projectPath, home, p.videoId, false), "render", "comp");
      // composição some quando o render/ é limpo à mão: monta de novo
      if (!existsSync(join(comp, "index.html"))) comporVideo(p.projectPath, home, p.videoId);
      const arq = dentroDe(comp, rel);
      if (arq && existsSync(arq) && statSync(arq).isFile()) return servirArquivo(c, arq, true);
      // efeito que ainda não foi copiado (ouvir no seletor antes de pôr no vídeo)
      if (rel.startsWith("assets/efeitos/") || rel.startsWith("assets/musica-nexos/")) {
        const sub = rel.startsWith("assets/efeitos/") ? join("efeitos", rel.slice(15)) : join("musicas", rel.slice(20));
        const alvo = dentroDe(pastaDeAssets(), sub);
        if (alvo && existsSync(alvo)) return servirArquivo(c, alvo, true);
      }
      return c.text("não achei", 404);
    } catch (e) {
      log.aviso("video", `prévia ${rel} falhou`, { erro: (e as Error).message });
      return c.text("erro", 500);
    }
  });
}

/** Só pra teste. */
export function resetPreviasForTest(): void {
  previas.clear();
  chavePorVideo.clear();
}

