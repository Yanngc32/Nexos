import type { Conjunto, Ferramenta, Saida } from "./mcp.ts";
import {
  avisarVideo,
  batidasDaMusica,
  catalogoDeEfeitos,
  criarVideo,
  definirMusica,
  definirTransicao,
  fmtS,
  importarTela,
  lerVideo,
  listarVideos,
  mudarVideo,
  musicasDoNexos,
  NOMES_TRANSICAO,
  ordenarCenas,
  removerEfeito,
  salvarCena,
  salvarEfeito,
  telasImportaveis,
  TIPOS_TRANSICAO,
  type VideoCompleto,
} from "./video.ts";
import { checarVideo, gerarCapa, iniciarRender, snapshotVideo } from "./video-motor.ts";

/**
 * Ferramentas `nexo_video_*`: o agente (e a skill `nexo-video`) monta o vídeo no PAINEL do Canvas
 * — nada de arquivo solto em `brag-output/`. A pessoa aprova as cenas e só ela dispara o render
 * final ("Aprovar cenas antes do render final"): aqui só sai rascunho.
 */
export const MCP_TOOLS_VIDEO = [
  "mcp__nexo__nexo_video_listar",
  "mcp__nexo__nexo_video_criar",
  "mcp__nexo__nexo_video_cena_salvar",
  "mcp__nexo__nexo_video_importar_tela",
  "mcp__nexo__nexo_video_ordem",
  "mcp__nexo__nexo_video_transicao",
  "mcp__nexo__nexo_video_audio",
  "mcp__nexo__nexo_video_print",
  "mcp__nexo__nexo_video_check",
  "mcp__nexo__nexo_video_render",
  "mcp__nexo__nexo_video_entrega",
];

const erroDe = (e: unknown): Saida => ({ ok: false, texto: (e as Error).message });

/** O Canvas aberto troca pro painel desse vídeo (stream `/v1/videos/events`). */
function mostrarNoCanvas(projectPath: string, id: string): void {
  avisarVideo(projectPath, { type: "video_ativo", id });
}

function resumo(v: VideoCompleto): string {
  const linhas = v.linha.cenas.map((c, i) => {
    const cena = v.cenas.find((x) => x.id === c.id)!;
    const t = v.linha.transicoes[i];
    const trans = t && t.tipo !== "corte" ? ` → ${t.tipo === "personalizada" ? `✦ ${t.nome}` : NOMES_TRANSICAO[t.tipo]} ${fmtS(t.duracao)}` : i < v.linha.cenas.length - 1 ? " → corte" : "";
    return `${i + 1}. ${c.id} · "${cena.nome}" · ${fmtS(c.duracao)} (de ${fmtS(c.inicio)} a ${fmtS(c.fim)})${cena.origem ? ` · de: ${cena.origem.titulo}` : ""}${trans}`;
  });
  const m = v.audio.musica;
  return [
    `Vídeo "${v.nome}" (id ${v.id}) · ${v.formato} · ${fmtS(v.linha.total)} · tokens do DS ${v.ds ? `"${v.ds.nome}"` : "padrão (projeto sem DS)"}`,
    ...(linhas.length ? linhas : ["(sem cenas)"]),
    `Música: ${m ? `${m.nome} (${m.fonte}, volume ${m.volume})` : "nenhuma"} · efeitos: ${v.audio.efeitos.length ? v.audio.efeitos.map((e) => `${e.rotulo}@${e.cena}+${e.t}s`).join(", ") : "nenhum"}`,
    `Render: ${v.render ? `${v.render.arquivo} (${v.render.qualidade})` : "não renderizado aqui"}`,
  ].join("\n");
}

const REGRAS_CENA =
  "Cena = FRAGMENTO HTML (sem <html>/<body>): <style> + marcação + <script> opcional. Só var(--token) do DS oficial (cores, fontes, espaço). " +
  "O <script> recebe `tl` (timeline GSAP pausada, tempo LOCAL: 0 = início da cena) e `cena` (elemento raiz); anime com tl.fromTo(seletor, de, para, posição). " +
  "Determinístico: nada de Date.now, Math.random, setTimeout, fetch, <script src> ou URL externa. CSS e seletor são escopados por cena. " +
  "Texto legível: gancho nos 2 primeiros segundos, ~0,3 s por palavra de leitura.";

export function ferramentasDeVideo(projectPath: string, home: string): Conjunto {
  return () => {
    const f: Ferramenta[] = [
      {
        name: "nexo_video_listar",
        description: "Lista os vídeos do painel de vídeo do projeto; com `video`, mostra cenas (id, nome, duração, início/fim), transições, áudio e render daquele vídeo. Também lista as músicas do Nexos, as telas do DS importáveis e (com `efeitos: true`) o catálogo de efeitos sonoros.",
        inputSchema: {
          type: "object",
          properties: { video: { type: "string" }, efeitos: { type: "boolean" } },
        },
        executar: (a) => {
          try {
            if (typeof a.video === "string" && a.video) {
              const v = lerVideo(projectPath, home, a.video);
              const html = v.cenas.map((c) => `\n--- cena ${c.id} ---\n${v.html[c.id] ?? ""}`).join("\n");
              return { ok: true, texto: `${resumo(v)}\n${html}` };
            }
            const vids = listarVideos(projectPath, home);
            const musicas = musicasDoNexos().map((m) => `- ${m.fonte} · ${m.nome} · ${m.bpm} BPM · ${Math.round(m.duracao)} s`);
            const telas = telasImportaveis(projectPath, home).map((t) => `- ${t.sistema}/${t.card} · ${t.titulo} (${t.secao})`);
            const efeitos = a.efeitos
              ? catalogoDeEfeitos().map((e) => `- ${e.arquivo} · ${e.categoria} · ${e.duracao.toFixed(2)} s${e.cansa ? " · CANSA (evite repetir)" : ""}`)
              : ["(peça com efeitos: true)"];
            return {
              ok: true,
              texto: [
                vids.length ? vids.map((v) => `- ${v.id} · "${v.nome}" · ${v.formato} · ${v.cenas} cena(s) · ${fmtS(v.total)}`).join("\n") : "Nenhum vídeo ainda (crie com nexo_video_criar).",
                "\nMúsicas do Nexos (ende.app, CC BY 4.0):",
                ...musicas,
                "\nTelas do DS que dá pra importar como cena (cópia):",
                ...(telas.length ? telas : ["(nenhuma)"]),
                "\nEfeitos (Kenney, CC0):",
                ...efeitos,
              ].join("\n"),
            };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_criar",
        description: "Cria um vídeo no painel de vídeo do Canvas (herda os tokens do DS oficial) e mostra ele no Canvas. Formato: 16:9 (padrão, 1920×1080), 9:16 (1080×1920) ou 1:1.",
        inputSchema: {
          type: "object",
          properties: { nome: { type: "string" }, formato: { type: "string", enum: ["16:9", "9:16", "1:1"] } },
          required: ["nome"],
        },
        executar: (a) => {
          try {
            const m = criarVideo(projectPath, home, a);
            mostrarNoCanvas(projectPath, m.id);
            return { ok: true, texto: `Vídeo criado: ${m.id} ("${m.nome}", ${m.formato}). Agora crie as cenas com nexo_video_cena_salvar (ou importe telas do DS com nexo_video_importar_tela).` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_cena_salvar",
        description: `Cria ou atualiza uma cena do vídeo (card no painel). Sem \`id\` = cena nova (no fim, ou em \`posicao\`). ${REGRAS_CENA} Depois confira com nexo_video_print.`,
        inputSchema: {
          type: "object",
          properties: {
            video: { type: "string" },
            id: { type: "string", description: "id da cena pra atualizar" },
            nome: { type: "string" },
            duracao: { type: "number", description: "segundos (0,2–120)" },
            html: { type: "string" },
            posicao: { type: "number", description: "índice (0 = primeira)" },
          },
          required: ["video"],
        },
        executar: (a) => {
          try {
            const r = salvarCena(projectPath, home, String(a.video), a);
            mostrarNoCanvas(projectPath, String(a.video));
            const v = lerVideo(projectPath, home, String(a.video));
            return {
              ok: true,
              texto: `Cena ${r.cena.id} salva ("${r.cena.nome}", ${fmtS(r.cena.duracao)}).${r.avisos.length ? `\n\nAvisos — corrija e grave de novo:\n${r.avisos.map((x) => `- ${x}`).join("\n")}` : ""}\n\n${resumo(v)}`,
            };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_importar_tela",
        description: "Importa uma tela do DS oficial ou do painel de mocks como cena nova no fim do vídeo — CÓPIA do HTML (sem vínculo com a original), já num palco do tamanho do vídeo e com uma entrada simples. Mostrar a coisa real vale mais que redesenhar: prefira isto. Depois anime com nexo_video_cena_salvar.",
        inputSchema: {
          type: "object",
          properties: { video: { type: "string" }, sistema: { type: "string" }, card: { type: "string" } },
          required: ["video", "sistema", "card"],
        },
        executar: (a) => {
          try {
            const r = importarTela(projectPath, home, String(a.video), String(a.sistema), String(a.card));
            mostrarNoCanvas(projectPath, String(a.video));
            return { ok: true, texto: `Tela importada como cena ${r.cena.id} ("${r.cena.nome}", ${fmtS(r.cena.duracao)}).` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_ordem",
        description: "Reordena as cenas do vídeo (lista com TODOS os ids de cena, na ordem nova). A composição é regenerada.",
        inputSchema: {
          type: "object",
          properties: { video: { type: "string" }, ordem: { type: "array", items: { type: "string" } } },
          required: ["video", "ordem"],
        },
        executar: (a) => {
          try {
            ordenarCenas(projectPath, home, String(a.video), a.ordem);
            return { ok: true, texto: resumo(lerVideo(projectPath, home, String(a.video))) };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_transicao",
        description:
          `Define a transição entre duas cenas VIZINHAS (de → para). Tipos prontos: ${TIPOS_TRANSICAO.filter((t) => t !== "personalizada").join(", ")}. ` +
          "A transição SOBREPÕE as cenas (os últimos T s de A tocam com os primeiros T s de B), então encurta o vídeo em T; máximo = metade da cena mais curta. " +
          "Fade entre duas telas cheias fica borrado: use `fundo`. Pedido livre (prompt) = tipo `personalizada` com `codigo`: corpo JS que recebe (tl, a, b, inicio, duracao) — " +
          "`a`/`b` são os elementos das cenas, `tl` a timeline raiz (tempo absoluto); use só tl.fromTo/tl.to/tl.set a partir de `inicio`, dentro de `duracao`, determinístico. " +
          "Antes de escrever à mão, veja se há bloco pronto com `npx hyperframes@0.8.82 catalog --query <termo>`. Depois confira o frame do meio com nexo_video_print (t = início + duração/2).",
        inputSchema: {
          type: "object",
          properties: {
            video: { type: "string" },
            de: { type: "string" },
            para: { type: "string" },
            tipo: { type: "string", enum: TIPOS_TRANSICAO },
            duracao: { type: "number", description: "segundos (0,1–2,0); corte = 0" },
            nome: { type: "string", description: "personalizada: nome curto pro chip (ex.: Giro + logo)" },
            codigo: { type: "string", description: "personalizada: corpo JS com (tl, a, b, inicio, duracao)" },
            prompt: { type: "string", description: "personalizada: o pedido da pessoa, guardado junto" },
          },
          required: ["video", "de", "para", "tipo"],
        },
        executar: (a) => {
          try {
            const r = definirTransicao(projectPath, home, String(a.video), a);
            const v = lerVideo(projectPath, home, String(a.video));
            const t = v.linha.transicoes.find((x) => x.de === r.transicao.de && x.para === r.transicao.para);
            const meio = t ? t.inicio + t.duracao / 2 : 0;
            return {
              ok: true,
              texto:
                `Transição ${r.transicao.de} → ${r.transicao.para}: ${r.transicao.tipo === "personalizada" ? `✦ ${r.transicao.nome}` : NOMES_TRANSICAO[r.transicao.tipo]} ${fmtS(r.transicao.duracao)}.` +
                (r.limitada ? ` Limitada a ${fmtS(r.maximo)} (metade da cena mais curta).` : "") +
                (t && t.duracao > 0 ? ` Frame do meio em t = ${meio.toFixed(2)} s (confira com nexo_video_print).` : "") +
                ` Vídeo agora tem ${fmtS(v.linha.total)}.`,
            };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_audio",
        description:
          "Trilha de áudio do vídeo. `musica`: fonte `nexos:<id>` (as 5 da ende.app que vêm com o Nexos, veja nexo_video_listar) ou vazio pra tirar; `volume` 0,3–0,4 (nunca > 0,5). " +
          "`efeito`: adiciona/move um efeito sonoro (arquivo do catálogo Kenney) preso a uma CENA (`cena` + `t` relativo a ela) ou num tempo absoluto (`tAbsoluto`, que encaixa na batida mais próxima a ≤ 0,15 s). Volume de efeito 0,55–0,85. " +
          "`remover`: id do efeito a tirar. A música é cortada no fim do vídeo com fade-out de 1 s. Devolve as batidas fortes pra sincronizar cortes.",
        inputSchema: {
          type: "object",
          properties: {
            video: { type: "string" },
            musica: { type: "string" },
            volume: { type: "number" },
            repetir: { type: "boolean" },
            efeito: {
              type: "object",
              properties: {
                id: { type: "string" },
                arquivo: { type: "string" },
                cena: { type: "string" },
                t: { type: "number" },
                tAbsoluto: { type: "number" },
                volume: { type: "number" },
                rotulo: { type: "string" },
              },
            },
            remover: { type: "string" },
          },
          required: ["video"],
        },
        executar: (a) => {
          try {
            const id = String(a.video);
            const extras: string[] = [];
            if (a.musica !== undefined || a.volume !== undefined || a.repetir !== undefined) {
              const atual = lerVideo(projectPath, home, id).audio.musica;
              const fonte = a.musica !== undefined ? String(a.musica) : (atual?.fonte ?? "");
              definirMusica(projectPath, home, id, fonte ? { fonte, volume: a.volume, repetir: a.repetir } : null);
              if (typeof a.volume === "number" && a.volume > 0.5) extras.push("Volume da música acima do recomendado (0,5).");
            }
            if (a.efeito && typeof a.efeito === "object") {
              const r = salvarEfeito(projectPath, home, id, a.efeito as Record<string, unknown>);
              extras.push(`Efeito ${r.efeito.id} (${r.efeito.rotulo}) na cena ${r.efeito.cena} + ${r.efeito.t} s${r.naBatida ? " · na batida" : ""}.`);
            }
            if (typeof a.remover === "string") removerEfeito(projectPath, home, id, a.remover);
            const v = lerVideo(projectPath, home, id);
            const fortes = batidasDaMusica(projectPath, home, id, v.audio.musica)
              .filter((b) => b.forte && b.t <= v.linha.total)
              .map((b) => b.t.toFixed(2));
            return { ok: true, texto: `${extras.join(" ")}\n${resumo(v)}\nBatidas fortes até o fim do vídeo: ${fortes.slice(0, 40).join(", ") || "(sem guia)"}` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_print",
        description: "Frame do vídeo no tempo `t` (segundos, tempo do vídeo inteiro), renderizado pelo mesmo motor do MP4. Use pra conferir cena e frame do meio da transição. Leva uns 5 s.",
        inputSchema: { type: "object", properties: { video: { type: "string" }, t: { type: "number" } }, required: ["video", "t"] },
        executar: async (a) => {
          try {
            const s = await snapshotVideo(projectPath, home, String(a.video), Number(a.t) || 0);
            if (!s.ok) return { ok: false, texto: `Não consegui gerar o frame: ${s.motivo}` };
            return { ok: true, texto: `Frame em ${s.t.toFixed(2)} s.`, imagem: { dataBase64: s.png.toString("base64"), mimeType: "image/png" } };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_check",
        description: "Roda o `hyperframes check` (lint + runtime + layout + contraste) na composição do vídeo. É o portão antes de render: corrija os erros.",
        inputSchema: { type: "object", properties: { video: { type: "string" } }, required: ["video"] },
        executar: async (a) => {
          try {
            const r = await checarVideo(projectPath, home, String(a.video));
            if (r.motivo) return { ok: false, texto: `Check não rodou: ${r.motivo}` };
            const lista = r.achados
              .filter((x) => x.severidade !== "info")
              .map((x) => `- [${x.severidade}] ${x.cena ? `cena ${x.cena}: ` : ""}${x.msg}${x.dica ? ` (dica: ${x.dica})` : ""}`);
            return { ok: true, texto: `${r.ok ? "Check ok" : "Check com erro"} · ${r.erros} erro(s), ${r.avisos} aviso(s)${lista.length ? `\n${lista.slice(0, 30).join("\n")}` : ""}` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_render",
        description: "Renderiza um RASCUNHO do vídeo (MP4 de conferência). O render FINAL é só a pessoa que dispara, no painel, depois de aprovar as cenas. Um render por vez; o progresso aparece no painel.",
        inputSchema: { type: "object", properties: { video: { type: "string" } }, required: ["video"] },
        executar: async (a) => {
          try {
            const r = await iniciarRender(projectPath, home, String(a.video), "draft");
            const fim = await r.fim;
            if (!fim.ok) return { ok: false, texto: fim.cancelado ? "Render cancelado." : `Render falhou: ${fim.motivo}` };
            return { ok: true, texto: `Rascunho pronto: ${fim.info.caminho} (${(fim.info.bytes / 1024 / 1024).toFixed(1)} MB, ${fmtS(fim.info.duracao)}).` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
      {
        name: "nexo_video_entrega",
        description: "Anexa a entrega no painel: `texto` pra postar (o crédito da música entra sozinho) e `capa` = tempo (s) do melhor frame já assentado (não o frame 0) — gera render/capa.png.",
        inputSchema: {
          type: "object",
          properties: { video: { type: "string" }, texto: { type: "string" }, capa: { type: "number" } },
          required: ["video"],
        },
        executar: async (a) => {
          try {
            const id = String(a.video);
            mudarVideo(projectPath, home, id, { ...(typeof a.texto === "string" ? { textoPost: a.texto } : {}), ...(typeof a.capa === "number" ? { capaEm: a.capa } : {}) });
            let capa = "";
            if (typeof a.capa === "number") {
              const r = await gerarCapa(projectPath, home, id, a.capa);
              capa = r.ok ? ` Capa: ${r.caminho}.` : ` Capa não saiu: ${r.motivo}.`;
            }
            return { ok: true, texto: `Entrega anexada no painel.${capa}` };
          } catch (e) {
            return erroDe(e);
          }
        },
      },
    ];
    return f;
  };
}
