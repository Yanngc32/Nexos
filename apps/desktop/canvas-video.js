/**
 * Painel VÍDEO do Canvas (plano-20260928-1230, telas "Painel Vídeo no Canvas" e "popover de
 * transição", mocks aprovados no painel de mocks). Mesmo lugar do Design System: o seletor de
 * sistema do Canvas lista os vídeos do projeto junto com os DS, e escolher um troca o board pelo
 * painel do vídeo.
 *
 * Quem desenha a cena é o daemon: cada card carrega em iframe o MESMO documento da sub-composition
 * do render (`/video-previa/<chave>/previa/cena-<id>.html`), então o frame do scrubber é o frame do
 * MP4. Conversa com o iframe por postMessage (seek, tocar, inspector) — ele é de outra origem.
 */
import { editarNome } from "./editar-nome.js";

const FORMATOS = {
  "16:9": { largura: 1920, altura: 1080 },
  "9:16": { largura: 1080, altura: 1920 },
  "1:1": { largura: 1080, altura: 1080 },
};

export const PRESETS = [
  { tipo: "corte", nome: "Corte" },
  { tipo: "fade", nome: "Fade" },
  { tipo: "fundo", nome: "Pelo fundo" },
  { tipo: "deslizar-esq", nome: "Deslizar ←" },
  { tipo: "deslizar-cima", nome: "Deslizar ↑" },
  { tipo: "mascara", nome: "Máscara circular" },
];
const NOME_TIPO = Object.fromEntries([...PRESETS.map((p) => [p.tipo, p.nome]), ["personalizada", "Personalizada"]]);

/** "3,0 s" — uma casa, vírgula. */
export function fmtS(s) {
  return `${(Math.round((Number(s) || 0) * 10) / 10).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** "1:48" pra duração de música. */
export function fmtMin(s) {
  const t = Math.round(Number(s) || 0);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function fmtMb(bytes) {
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

/** Máximo de uma transição: metade da cena mais curta (arredonda pra baixo em 0,1 s). */
export function maximoDaTransicao(durA, durB) {
  return Math.floor((Math.min(durA, durB) / 2) * 10 + 1e-9) / 10;
}

/** Texto do chip do conector: "Corte", "Fade 0,6 s", "✦ Giro + logo". */
export function rotuloDaTransicao(t) {
  if (!t || t.tipo === "corte" || !(t.duracao > 0)) return "Corte";
  if (t.tipo === "personalizada") return `✦ ${t.nome || "Personalizada"}`;
  return `${NOME_TIPO[t.tipo] || t.tipo} ${fmtS(t.duracao)}`;
}

/** Nova ordem depois de mover o item `id` pra posição `para` (índice na lista SEM ele). */
export function moverNaOrdem(ordem, id, para) {
  const sem = ordem.filter((x) => x !== id);
  const i = Math.max(0, Math.min(sem.length, para));
  return [...sem.slice(0, i), id, ...sem.slice(i)];
}

/** Uma cena "cheia" (tela do DS importada ou fundo que cobre tudo) — fade entre duas borra. */
export function ehTelaCheia(cena) {
  return !!cena?.origem;
}

export const VOLUME_MUSICA = { padrao: 0.35, recomendadoMax: 0.5 };
export const VOLUME_EFEITO = { padrao: 0.7, min: 0.55, max: 0.85 };

/** Volume da música acima do recomendado (mostra "Acima do recomendado", não bloqueia). */
export function volumeMusicaAcima(vol) {
  return Number(vol) > VOLUME_MUSICA.recomendadoMax + 1e-9;
}

/** Volume de efeito fora da faixa recomendada (0,55–0,85). */
export function volumeEfeitoForaDaFaixa(vol) {
  const v = Number(vol);
  return v < VOLUME_EFEITO.min - 1e-9 || v > VOLUME_EFEITO.max + 1e-9;
}

/** Duração que a música ocupa quando ainda não se sabe a real (trata como do tamanho do vídeo). */
export function duracaoEfetivaDaMusica(musica, total) {
  if (!musica) return 0;
  return musica.duracao && musica.duracao > 0 ? musica.duracao : total;
}

/** Espelha `audiosDoVideo` (video.ts): sem repetir e mais curta que o vídeo = acaba antes. */
export function musicaMaisCurtaQueOVideo(musica, total) {
  return !!musica && !musica.repetir && duracaoEfetivaDaMusica(musica, total) < total - 0.05;
}

/** Deslocamento até a próxima batida na direção pedida (Shift+seta no marcador de efeito). */
export function passoParaBatida(tAtual, direcao, batidas) {
  const bs = (batidas || [])
    .map((b) => b.t)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (direcao < 0) {
    const cands = bs.filter((t) => t < tAtual - 0.005);
    return cands.length ? cands[cands.length - 1] - tAtual : -0.1;
  }
  const cands = bs.filter((t) => t > tAtual + 0.005);
  return cands.length ? cands[0] - tAtual : 0.1;
}

/** Picos (0–1) → `d` de um `<path>` de forma de onda, viewBox 0 0 N 56. */
export function picosParaCaminhoSvg(picos) {
  if (!picos || !picos.length) return "";
  return picos.map((p, i) => `${i === 0 ? "M" : "L"}${i} ${28 - Math.max(0, Math.min(1, p)) * 26}`).join(" ");
}

/** Contexto que vai pro chat junto com o prompt da transição (decisão "Prompt da transição vai pro chat em foco"). */
export function pedidoDeTransicao(video, de, para, prompt) {
  const a = video.cenas.find((c) => c.id === de);
  const b = video.cenas.find((c) => c.id === para);
  const t = video.linha.transicoes.find((x) => x.de === de && x.para === para);
  const ia = video.cenas.findIndex((c) => c.id === de) + 1;
  return [
    `Transição no vídeo "${video.nome}" (id ${video.id}), entre a cena ${ia} "${a?.nome}" (${de}, ${fmtS(a?.duracao)}) e a cena ${ia + 1} "${b?.nome}" (${para}, ${fmtS(b?.duracao)}).`,
    `Efeito atual: ${rotuloDaTransicao(t)}. Máximo: ${fmtS(maximoDaTransicao(a?.duracao ?? 0, b?.duracao ?? 0))}.`,
    `Pedido: ${prompt}`,
    `Escreva a transição com nexo_video_transicao (tipo "personalizada", nome curto pro chip, codigo com tl/a/b/inicio/duracao) e confira o frame do meio com nexo_video_print.`,
  ].join("\n");
}

export function createVideoPanel({
  req,
  api,
  el,
  getProjectPath,
  isOk = () => true,
  lerEventos,
  headers,
  fetchImpl = (...a) => fetch(...a),
  avisar = (msg) => Promise.resolve(window.alert(msg)),
  confirmar = (msg) => Promise.resolve(window.confirm(msg)),
  /** Manda pro chat em foco (abre um ao lado sem tirar o foco se não houver). */
  aoMandarNoChat = () => {},
  /** Põe um texto no campo do chat, sem mandar (a pessoa completa). */
  aoPedirNoChat = () => {},
  abrirLink = async () => {},
  /** Chama quando o painel abre/fecha: o Canvas esconde/mostra o board do DS. */
  aoMudarModo = () => {},
  /** A lista de vídeos mudou (criou, apagou, renomeou): o Canvas repinta o seletor. */
  aoMudarLista = () => {},
  instalarFfmpeg = async () => ({ metodo: "pagina" }),
  abrirArquivo = async () => {},
  mostrarNaPasta = async () => {},
  copiarTexto = async (t) => navigator.clipboard.writeText(t),
  doc = document,
  win = window,
}) {
  /** `GET /v1/videos?projectPath` */
  let lista = [];
  let ffmpeg = null;
  /** vídeo aberto (resposta completa de `GET /v1/videos/:id`) ou null */
  let video = null;
  let ativoId = null;
  let selecionada = null;
  let check = null;
  let render = null;
  let falhaRender = null;
  let sse = null;
  let projetoCarregado = "";
  const cardsDom = new Map(); // cena → { raiz, frame, range, tempo, html, pronto }
  let inspecionando = false;
  let apontados = [];
  let toastTimer = 0;
  /** Trilha de áudio: recolhida lembra o estado (localStorage), cursor sincroniza com o Preview. */
  let trilhaAberta = (() => {
    try {
      return win.localStorage?.getItem("nexos-video-trilha") !== "0";
    } catch {
      return true;
    }
  })();
  let cursorT = 0;
  let previewAudio = null; // <audio> solto pros ▶ de conferência (seletor de música/efeito)
  let seletorEfeitoAberto = null; // { t, trocarDe }
  const ondaCache = new Map(); // url → Promise<picos|null>
  let catalogo = null; // GET /v1/videos/catalogo (músicas, efeitos, telas), cacheado por vídeo aberto

  const qs = () => `projectPath=${encodeURIComponent(getProjectPath())}`;
  const raiz = () => el("video-painel");

  /* ---------- lista e seletor do Canvas ---------- */

  async function recarregarLista() {
    if (!getProjectPath()) {
      lista = [];
      return lista;
    }
    try {
      const r = await req(`/v1/videos?${qs()}`);
      lista = r.videos || [];
      ffmpeg = r.ffmpeg || ffmpeg;
    } catch {
      lista = [];
    }
    aoMudarLista();
    return lista;
  }

  /** Canvas abriu (ou trocou de projeto): lista os vídeos e escuta o stream deles. */
  async function ativarCanvas() {
    ligarUmaVez();
    if (getProjectPath() !== projetoCarregado) trocouProjeto();
    await recarregarLista();
    if (!sse) ouvir();
  }

  function opcoes(nomeDoOficial) {
    return lista.map((v) => ({ valor: `video:${v.id}`, rotulo: `${v.nome} (vídeo${nomeDoOficial ? ` de ${nomeDoOficial}` : ""})` }));
  }

  function ativo() {
    return ativoId;
  }

  async function abrir(id) {
    ligarUmaVez();
    if (getProjectPath() !== projetoCarregado) trocouProjeto();
    ativoId = id;
    aoMudarModo(true);
    raiz().classList.remove("hidden");
    pintarCarregando();
    await carregar();
    if (!sse) ouvir();
  }

  function fechar() {
    ativoId = null;
    video = null;
    check = null;
    falhaRender = null;
    limparCards();
    fecharPopover();
    fecharDrawer();
    fecharSeletorEfeito();
    fecharSeletorMusica();
    previewAudio?.pause();
    raiz()?.classList.add("hidden");
    aoMudarModo(false);
  }

  function trocouProjeto() {
    projetoCarregado = getProjectPath();
    ativoId = null;
    video = null;
    lista = [];
    catalogo = null;
    limparCards();
    pararSse();
  }

  async function carregar() {
    if (!ativoId) return;
    try {
      const v = await req(`/v1/videos/${encodeURIComponent(ativoId)}?${qs()}`);
      // o SSE avisa também das mudanças que o próprio painel acabou de aplicar: igual, não repinta
      if (video && video.id === v.id && JSON.stringify(v) === JSON.stringify(video)) return;
      aplicar(v);
    } catch (e) {
      if (e.status === 404) {
        fechar();
        await recarregarLista();
        return;
      }
      // 503 (pasta do Drive montando) vem com o mesmo texto do resto do app
      mostrarErro(e.message);
    }
  }

  function aplicar(v) {
    video = v;
    ffmpeg = v.ffmpeg || ffmpeg;
    render = v.renderando && v.renderando.videoId === v.id ? v.renderando : render && render.videoId === v.id ? render : null;
    if (selecionada && !v.cenas.some((c) => c.id === selecionada)) selecionada = null;
    const i = lista.findIndex((x) => x.id === v.id);
    const resumo = { id: v.id, nome: v.nome, formato: v.formato, cenas: v.cenas.length, total: v.linha.total };
    if (i >= 0) lista[i] = resumo;
    else lista.push(resumo);
    pintar();
  }

  /* ---------- SSE ---------- */

  function ouvir() {
    pararSse();
    if (!isOk() || !getProjectPath()) return;
    const ac = new AbortController();
    sse = ac;
    fetchImpl(api(`/v1/videos/events?${qs()}`), { headers: headers(), signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) return;
        await lerEventos(res, (ev) => receber(ev));
        religar();
      })
      .catch(() => religar());
    function religar() {
      if (sse !== ac) return;
      win.setTimeout(() => {
        if (sse !== ac || !isOk()) return;
        sse = null;
        void carregar().then(ouvir);
      }, 1500);
    }
  }

  function pararSse() {
    sse?.abort();
    sse = null;
  }

  let recarregarTimer = 0;
  function receber(ev) {
    // o agente criou/mexeu num vídeo (nexo_video_*): o Canvas mostra o painel dele
    if (ev?.type === "video_ativo") {
      if (ev.id !== ativoId) void recarregarLista().then(() => abrir(ev.id));
      return;
    }
    if (!ev || ev.id !== ativoId) {
      if (ev?.type === "video-mudou") void recarregarLista();
      return;
    }
    if (ev.type === "video-mudou") {
      win.clearTimeout(recarregarTimer);
      recarregarTimer = win.setTimeout(() => void carregar(), 120);
    } else if (ev.type === "render") {
      if (ev.estado === "rodando") {
        render = ev.progresso;
        falhaRender = null;
      } else if (ev.estado === "pronto") {
        render = null;
        toast("Vídeo pronto");
        void carregar();
      } else if (ev.estado === "falhou") {
        render = null;
        falhaRender = { motivo: ev.motivo, log: ev.log };
      } else if (ev.estado === "cancelado") {
        render = null;
        toast("Render cancelado");
      }
      pintarStatus();
      pintarBarra();
    } else if (ev.type === "check") {
      if (ev.estado === "pronto") check = ev.resultado;
      else check = { rodando: true };
      pintarBarra();
    } else if (ev.type === "transicao-salva") {
      aoTransicaoSalva(ev);
    }
  }

  /* ---------- pintura ---------- */

  function pintarCarregando() {
    const r = raiz();
    r.querySelector(".vp-board").innerHTML = `<div class="vp-cena vp-sk"><div class="vp-sk-l"></div><div class="vp-sk-t"></div></div><div class="vp-cena vp-sk"><div class="vp-sk-l"></div><div class="vp-sk-t"></div></div>`;
  }

  function mostrarErro(msg) {
    const p = raiz().querySelector(".vp-erro");
    p.textContent = msg || "";
    p.classList.toggle("hidden", !msg);
  }

  function pintar() {
    if (!video) return;
    mostrarErro("");
    pintarBarra();
    pintarStatus();
    pintarBoard();
    pintarFaixa();
    pintarTrilha();
    if (popover) pintarPopover();
  }

  function pintarBarra() {
    if (!video) return;
    const r = raiz();
    r.querySelector(".vp-nome").textContent = video.nome;
    const fmt = FORMATOS[video.formato];
    const sel = r.querySelector(".vp-formato");
    sel.value = video.formato;
    sel.title = `${video.formato} · ${fmt.largura}×${fmt.altura}`;
    r.querySelector(".vp-total").textContent = fmtS(video.linha.total);
    // chip do check
    const chip = r.querySelector(".vp-check-chip");
    chip.className = "vp-pill vp-check-chip";
    chip.classList.toggle("hidden", !check);
    if (check?.rodando) {
      chip.textContent = "Checando…";
    } else if (check?.motivo) {
      chip.classList.add("vp-er");
      chip.textContent = `Check não rodou`;
      chip.title = check.motivo;
    } else if (check) {
      const erroCena = check.achados?.find((a) => a.severidade === "erro");
      if (check.erros) {
        chip.classList.add("vp-er");
        const n = erroCena?.cena ? video.cenas.findIndex((c) => c.id === erroCena.cena) + 1 : 0;
        chip.textContent = n ? `Erro na cena ${n}` : `${check.erros} erro${check.erros > 1 ? "s" : ""}`;
      } else if (check.avisos) {
        chip.classList.add("vp-av");
        chip.textContent = `${check.avisos} aviso${check.avisos > 1 ? "s" : ""}`;
      } else {
        chip.classList.add("vp-ok");
        chip.textContent = "Check ok";
      }
      chip.title = (check.achados || [])
        .filter((a) => a.severidade !== "info")
        .map((a) => `${a.cena ? `Cena ${video.cenas.findIndex((c) => c.id === a.cena) + 1}: ` : ""}${a.msg}`)
        .join("\n");
    }
    const semCena = !video.cenas.length;
    r.querySelector(".vp-btn-check").disabled = semCena || !!check?.rodando;
    r.querySelector(".vp-btn-preview").disabled = semCena;
    const btnRender = r.querySelector(".vp-btn-render");
    btnRender.textContent = render ? "Cancelar" : "Render ▾";
    btnRender.classList.toggle("vp-dan", !!render);
    btnRender.classList.toggle("vp-pri", !render);
    btnRender.disabled = !render && (semCena || !ffmpeg?.instalado);
    btnRender.title = !ffmpeg?.instalado ? "Pra renderizar precisa do FFmpeg" : "";
    r.querySelector(".vp-btn-apontar").setAttribute("aria-pressed", inspecionando ? "true" : "false");
  }

  function pintarStatus() {
    if (!video) return;
    const box = raiz().querySelector(".vp-status");
    box.innerHTML = "";
    if (ffmpeg && !ffmpeg.instalado) {
      box.append(
        alerta("aviso", `Pra renderizar precisa do FFmpeg.`, ffmpeg.motivo || "FFmpeg não encontrado no PATH", [
          ["Instalar (winget)", "vp-pri", () => void instalar()],
          ["Ver como instalar", "vp-fant", () => void abrirLink("https://www.gyan.dev/ffmpeg/builds/")],
        ]),
      );
    }
    if (render) {
      const d = doc.createElement("div");
      d.className = "vp-box vp-render";
      d.setAttribute("aria-live", "polite");
      const pct = render.pct || 0;
      const txt = render.frame ? `Renderizando ${render.frame}/${render.frames} frames · ${pct}%` : render.fase || "Preparando motor de vídeo…";
      d.innerHTML = `<div class="vp-linha"><span class="vp-render-txt"></span><span class="vp-esp"></span></div><div class="vp-prog"><b style="width:${pct}%"></b></div>`;
      d.querySelector(".vp-render-txt").textContent = `${render.qualidade === "high" ? "Final · " : "Rascunho · "}${txt}`;
      box.append(d);
    }
    if (falhaRender) {
      const a = alerta("erro", "Render falhou:", falhaRender.motivo, [
        ["Ver log", "vp-fant", () => void avisar(falhaRender.log || falhaRender.motivo)],
        ["✕", "vp-fant", () => ((falhaRender = null), pintarStatus())],
      ]);
      box.append(a);
    }
    if (video.render) {
      const r = video.render;
      const d = doc.createElement("div");
      d.className = "vp-box vp-mp4";
      d.innerHTML = `<div class="vp-mp4-info"><b></b><span class="vp-mono"></span></div><span class="vp-esp"></span>`;
      d.querySelector("b").textContent = r.arquivo;
      d.querySelector(".vp-mono").textContent = `${fmtS(r.duracao)} · ${fmtMb(r.bytes)} · ${r.qualidade === "high" ? "final" : "rascunho"} · só neste computador`;
      d.append(
        botao("Abrir", "vp-pri", () => void abrirArquivo(r.caminho).catch((e) => avisar(e.message))),
        botao("Mostrar na pasta", "", () => void mostrarNaPasta(r.caminho).catch((e) => avisar(e.message))),
        botao("Copiar texto pra postar", "vp-fant", () => void copiarTexto(video.textoParaPostar).then(() => toast("Texto copiado"))),
      );
      box.append(d);
    } else if (video.cenas.length && !render) {
      const d = doc.createElement("div");
      d.className = "vp-box vp-mp4 vp-mp4-nao";
      d.innerHTML = `<div class="vp-mp4-info"><span class="vp-mono">Não renderizado aqui</span></div><span class="vp-esp"></span>`;
      if (ffmpeg?.instalado) d.append(botao("Renderizar", "", () => void renderizar("draft")));
      if (video.textoParaPostar) d.append(botao("Copiar texto pra postar", "vp-fant", () => void copiarTexto(video.textoParaPostar).then(() => toast("Texto copiado"))));
      box.append(d);
    }
  }

  function alerta(tipo, titulo, detalhe, acoes = []) {
    const d = doc.createElement("div");
    d.className = `vp-alerta ${tipo === "erro" ? "vp-alerta-er" : ""}`;
    d.setAttribute("role", tipo === "erro" ? "alert" : "status");
    const ic = tipo === "erro" ? "⨯" : "⚠";
    d.innerHTML = `<span class="vp-alerta-ic" aria-hidden="true">${ic}</span><span class="vp-alerta-txt"><b></b> <span class="vp-mono"></span></span><span class="vp-esp"></span>`;
    d.querySelector("b").textContent = titulo;
    d.querySelector(".vp-mono").textContent = detalhe || "";
    for (const [rot, cls, fn] of acoes) d.append(botao(rot, cls, fn));
    return d;
  }

  function botao(rotulo, cls, fn) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = `vp-btn ${cls || ""}`;
    b.textContent = rotulo;
    b.addEventListener("click", fn);
    return b;
  }

  function limparCards() {
    for (const c of cardsDom.values()) {
      observador?.unobserve(c.tela);
      visibilidade?.unobserve(c.tela);
      c.raiz.remove();
    }
    cardsDom.clear();
  }

  function urlDaCena(id, html) {
    // hash do html na URL: cena editada recarrega; igual, o iframe fica (não pisca)
    let h = 0;
    for (let i = 0; i < html.length; i++) h = (h * 31 + html.charCodeAt(i)) | 0;
    return api(`${video.previa}previa/cena-${encodeURIComponent(id)}.html?v=${(h >>> 0).toString(36)}-${video.formato}`);
  }

  function pintarBoard() {
    const board = raiz().querySelector(".vp-board");
    board.querySelectorAll(".vp-sk").forEach((x) => x.remove());
    const vazio = raiz().querySelector(".vp-vazio");
    vazio.classList.toggle("hidden", video.cenas.length > 0);
    const vivas = new Set(video.cenas.map((c) => c.id));
    for (const [id, c] of cardsDom) {
      if (!vivas.has(id)) {
        observador?.unobserve(c.tela);
        visibilidade?.unobserve(c.tela);
        c.raiz.remove();
        cardsDom.delete(id);
      }
    }
    const fmt = FORMATOS[video.formato];
    board.dataset.formato = video.formato;
    video.cenas.forEach((cena, i) => {
      let c = cardsDom.get(cena.id);
      if (!c) {
        c = criarCard(cena);
        cardsDom.set(cena.id, c);
      }
      board.append(c.raiz); // na ordem
      c.raiz.classList.toggle("sel", selecionada === cena.id);
      c.raiz.querySelector(".vp-cena-nome").textContent = `${i + 1} · ${cena.nome}`;
      const de = c.raiz.querySelector(".vp-de");
      de.textContent = cena.origem ? `de: ${cena.origem.titulo}` : "";
      de.classList.toggle("hidden", !cena.origem);
      c.raiz.querySelector(".vp-dur").textContent = fmtS(cena.duracao);
      c.range.max = String(cena.duracao);
      c.tela.style.aspectRatio = `${fmt.largura} / ${fmt.altura}`;
      c.frame.style.width = `${fmt.largura}px`;
      c.frame.style.height = `${fmt.altura}px`;
      const url = urlDaCena(cena.id, video.html[cena.id] || "");
      if (c.url !== url) {
        c.url = url;
        c.pronto = false;
        if (c.visivel) c.frame.src = url;
      }
      escalar(c);
    });
  }

  function escalar(c) {
    const fmt = FORMATOS[video?.formato || "16:9"];
    const w = c.tela.clientWidth || 1;
    c.frame.style.transform = `scale(${w / fmt.largura})`;
  }

  const observador = typeof ResizeObserver !== "undefined" ? new ResizeObserver((ents) => {
    for (const e of ents) {
      const c = [...cardsDom.values()].find((x) => x.tela === e.target);
      if (c) escalar(c);
    }
  }) : null;

  // iframe da cena (documento 1920×1080 com GSAP) só carrega quando o card chega perto da tela
  const visibilidade = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (!e.isIntersecting) continue;
      const c = [...cardsDom.values()].find((x) => x.tela === e.target);
      if (!c) continue;
      c.visivel = true;
      visibilidade.unobserve(e.target);
      if (c.url) c.frame.src = c.url;
    }
  }, { rootMargin: "400px" }) : null;

  function criarCard(cena) {
    const raizCard = doc.createElement("article");
    raizCard.className = "vp-cena";
    raizCard.dataset.cena = cena.id;
    raizCard.tabIndex = 0;
    raizCard.innerHTML = `
      <header class="vp-cab"><b class="vp-cena-nome"></b><span class="vp-de hidden"></span><button type="button" class="vp-dur" title="Duplo clique pra mudar a duração"></button></header>
      <div class="vp-tela"><iframe class="vp-frame" title="Cena" tabindex="-1"></iframe></div>
      <footer class="vp-scrub">
        <button type="button" class="vp-play" aria-label="Tocar a cena"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg></button>
        <input type="range" class="vp-range" min="0" step="0.01" value="0" aria-label="Tempo da cena" />
        <span class="vp-mono vp-t">0,0 s</span>
      </footer>`;
    const c = {
      raiz: raizCard,
      tela: raizCard.querySelector(".vp-tela"),
      frame: raizCard.querySelector(".vp-frame"),
      range: raizCard.querySelector(".vp-range"),
      tempo: raizCard.querySelector(".vp-t"),
      tocando: false,
      pronto: false,
      url: "",
      visivel: !visibilidade,
    };
    observador?.observe(c.tela);
    visibilidade?.observe(c.tela);
    c.range.addEventListener("input", () => {
      c.mexeu = true;
      const t = Number(c.range.value);
      c.tempo.textContent = fmtS(t);
      postar(c, { tipo: "seek", t });
    });
    raizCard.querySelector(".vp-play").addEventListener("click", () => {
      const cenaAtual = video?.cenas.find((x) => x.id === cena.id);
      if (!cenaAtual) return;
      if (c.tocando) {
        postar(c, { tipo: "parar" });
        c.tocando = false;
      } else {
        const de = Number(c.range.value) >= cenaAtual.duracao - 0.05 ? 0 : Number(c.range.value);
        postar(c, { tipo: "tocar", de, ate: cenaAtual.duracao });
        c.tocando = true;
      }
      pintarPlay(c);
    });
    raizCard.addEventListener("click", (e) => {
      if (e.target.closest("button,input")) return;
      selecionar(cena.id);
    });
    raizCard.querySelector(".vp-dur").addEventListener("dblclick", () => editarDuracao(cena.id, raizCard.querySelector(".vp-dur")));
    raizCard.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      menuDaCena(cena.id, e.clientX, e.clientY);
    });
    c.frame.addEventListener("load", () => {
      if (inspecionando) postar(c, { tipo: "inspecionar", ligado: true });
      const t = Number(c.range.value);
      if (t) postar(c, { tipo: "seek", t });
    });
    return c;
  }

  function pintarPlay(c) {
    c.raiz.querySelector(".vp-play").innerHTML = c.tocando
      ? `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1h2v8H2zM6 1h2v8H6z" fill="currentColor"/></svg>`
      : `<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg>`;
    c.raiz.querySelector(".vp-play").setAttribute("aria-label", c.tocando ? "Pausar a cena" : "Tocar a cena");
  }

  function postar(c, msg) {
    try {
      c.frame.contentWindow?.postMessage(msg, "*");
    } catch {
      /* iframe ainda sem documento */
    }
  }

  /** Mensagens dos iframes (cenas e player): tempo, fim, pronto, elemento apontado. */
  function aoMensagem(e) {
    const m = e.data || {};
    if (m.nexosPlayer) return aoMensagemDoPlayer(m);
    if (!m.nexosCena) return;
    const c = cardsDom.get(m.nexosCena);
    if (!c || e.source !== c.frame.contentWindow) return;
    if (m.tipo === "pronta") {
      c.pronto = true;
      if (m.erro) c.raiz.querySelector(".vp-t").textContent = `erro: ${m.erro}`;
      // card novo abre num frame já assentado (em t=0 quase tudo ainda está entrando)
      if (!c.mexeu) {
        const cena = video?.cenas.find((x) => x.id === m.nexosCena);
        const t = cena ? Math.min(cena.duracao * 0.6, 2.5) : 0;
        c.range.value = String(t);
        c.tempo.textContent = fmtS(t);
        postar(c, { tipo: "seek", t });
      }
    } else if (m.tipo === "tempo") {
      c.range.value = String(m.t);
      c.tempo.textContent = fmtS(m.t);
    } else if (m.tipo === "parou") {
      c.tocando = false;
      c.range.value = String(m.t);
      c.tempo.textContent = fmtS(m.t);
      pintarPlay(c);
    } else if (m.tipo === "inspecionado") {
      apontar(m.nexosCena, m);
    }
  }

  function selecionar(id) {
    selecionada = selecionada === id ? null : id;
    for (const [cid, c] of cardsDom) c.raiz.classList.toggle("sel", cid === selecionada);
    pintarFaixa();
  }

  async function editarDuracao(id, alvo) {
    const cena = video?.cenas.find((c) => c.id === id);
    if (!cena) return;
    await editarNome(alvo, {
      atual: String(cena.duracao).replace(".", ","),
      max: 6,
      salvar: async (txt) => {
        const n = Math.round(Number(String(txt).replace(",", ".").replace(/[^\d.]/g, "")) * 10) / 10;
        if (!(n >= 0.2 && n <= 120)) throw new Error("Duração entre 0,2 e 120 s");
        const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/cenas/${encodeURIComponent(id)}?${qs()}`, { method: "PUT", body: JSON.stringify({ duracao: n }) });
        if (r.avisos?.length) toast(r.avisos[r.avisos.length - 1]);
        aplicar(r.video);
      },
      aoFalhar: (e) => toast(e.message),
    });
    pintarBoard();
  }

  /* ---------- menu da cena ---------- */

  let menuAberto = null;
  function menuDaCena(id, x, y) {
    fecharMenu();
    const m = doc.createElement("div");
    m.className = "vp-menu";
    m.setAttribute("role", "menu");
    m.style.left = `${x}px`;
    m.style.top = `${y}px`;
    const item = (rot, fn, cls = "") => {
      const b = botao(rot, `vp-menu-item ${cls}`, () => {
        fecharMenu();
        fn();
      });
      b.setAttribute("role", "menuitem");
      m.append(b);
    };
    item("Duplicar", () => void duplicar(id));
    item("Mandar pro chat", () => {
      const cena = video.cenas.find((c) => c.id === id);
      const n = video.cenas.findIndex((c) => c.id === id) + 1;
      aoPedirNoChat(`No vídeo "${video.nome}" (id ${video.id}), cena ${n} "${cena?.nome}" (id ${id}, ${fmtS(cena?.duracao)}): `);
    });
    item("Apagar", () => void apagar(id), "vp-menu-dan");
    doc.body.append(m);
    menuAberto = m;
    m.querySelector("button")?.focus();
  }
  function fecharMenu() {
    menuAberto?.remove();
    menuAberto = null;
  }

  async function duplicar(id) {
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/cenas/${encodeURIComponent(id)}/duplicar?${qs()}`, { method: "POST", body: "{}" });
      aplicar(r.video);
    } catch (e) {
      toast(e.message);
    }
  }

  async function apagar(id) {
    const cena = video.cenas.find((c) => c.id === id);
    if (!cena || !(await confirmar(`Apagar a cena "${cena.nome}"?`))) return;
    // guarda o que precisa pra desfazer: a cena volta no mesmo lugar e os efeitos dela junto
    const copia = { ...cena, html: video.html[id] || "", posicao: video.cenas.indexOf(cena) };
    const vid = video.id;
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(vid)}/cenas/${encodeURIComponent(id)}?${qs()}`, { method: "DELETE" });
      aplicar(r.video);
      const efeitos = r.efeitosRemovidos || [];
      toast(efeitos.length ? `Cena apagada (e ${efeitos.length} efeito(s) dela)` : "Cena apagada", [
        "Desfazer",
        async () => {
          try {
            const v = await req(`/v1/videos/${encodeURIComponent(vid)}/cenas?${qs()}`, { method: "POST", body: JSON.stringify(copia) });
            aplicar(efeitos.length ? await req(`/v1/videos/${encodeURIComponent(vid)}/efeitos/restaurar?${qs()}`, { method: "POST", body: JSON.stringify({ efeitos }) }) : v.video);
          } catch (e) {
            toast(e.message);
          }
        },
      ]);
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------- faixa de cenas (filmstrip) ---------- */

  function pintarFaixa() {
    if (!video) return;
    const faixa = raiz().querySelector(".vp-fita");
    faixa.innerHTML = "";
    const regua = raiz().querySelector(".vp-regua");
    regua.innerHTML = "";
    const total = video.linha.total || 1;
    const passo = total > 40 ? 10 : 5;
    for (let s = 0; s < total; s += passo) {
      const t = doc.createElement("span");
      t.textContent = `${s} s`;
      t.style.left = `${(s / total) * 100}%`;
      regua.append(t);
    }
    const fim = doc.createElement("span");
    fim.textContent = fmtS(total);
    fim.style.right = "0";
    fim.className = "vp-regua-fim";
    regua.append(fim);
    video.cenas.forEach((cena, i) => {
      const mini = doc.createElement("div");
      mini.className = "vp-mini";
      mini.classList.toggle("sel", selecionada === cena.id);
      mini.style.flex = `${cena.duracao} 1 0`;
      mini.draggable = true;
      mini.tabIndex = 0;
      mini.dataset.cena = cena.id;
      mini.setAttribute("role", "listitem");
      mini.setAttribute("aria-label", `Cena ${i + 1}: ${cena.nome}, ${fmtS(cena.duracao)}. Alt + setas reordena.`);
      mini.innerHTML = `<span></span><b></b>`;
      mini.querySelector("span").textContent = fmtS(cena.duracao);
      mini.querySelector("b").textContent = `${i + 1} · ${cena.nome}`;
      mini.addEventListener("click", () => {
        selecionar(cena.id);
        cardsDom.get(cena.id)?.raiz.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      mini.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/x-nexos-cena", cena.id);
        e.dataTransfer.effectAllowed = "move";
        mini.classList.add("arrastando");
      });
      mini.addEventListener("dragend", () => mini.classList.remove("arrastando"));
      mini.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes("text/x-nexos-cena")) return;
        e.preventDefault();
        const r = mini.getBoundingClientRect();
        mini.dataset.soltar = e.clientX < r.left + r.width / 2 ? "antes" : "depois";
      });
      mini.addEventListener("dragleave", () => delete mini.dataset.soltar);
      mini.addEventListener("drop", (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/x-nexos-cena");
        const lado = mini.dataset.soltar;
        delete mini.dataset.soltar;
        if (!id || id === cena.id) return;
        const ordem = video.cenas.map((c) => c.id);
        const semArrastada = ordem.filter((x) => x !== id);
        const alvo = semArrastada.indexOf(cena.id) + (lado === "depois" ? 1 : 0);
        void reordenar(moverNaOrdem(ordem, id, alvo));
      });
      mini.addEventListener("keydown", (e) => {
        if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        const ordem = video.cenas.map((c) => c.id);
        const idx = ordem.indexOf(cena.id);
        const para = e.key === "ArrowLeft" ? idx - 1 : idx + 1;
        if (para < 0 || para >= ordem.length) return;
        void reordenar(moverNaOrdem(ordem, cena.id, para)).then(() => raiz().querySelector(`.vp-mini[data-cena="${CSS.escape(cena.id)}"]`)?.focus());
      });
      faixa.append(mini);
      const prox = video.cenas[i + 1];
      if (prox) {
        const t = video.linha.transicoes.find((x) => x.de === cena.id && x.para === prox.id);
        const con = doc.createElement("button");
        con.type = "button";
        con.className = "vp-con";
        con.classList.toggle("ia", t?.tipo === "personalizada");
        con.dataset.de = cena.id;
        con.dataset.para = prox.id;
        con.textContent = rotuloDaTransicao(t);
        con.setAttribute("aria-label", `Transição entre cena ${i + 1} e ${i + 2}: ${rotuloDaTransicao(t)}`);
        con.addEventListener("click", () => abrirPopover(cena.id, prox.id, con));
        faixa.append(con);
      }
    });
  }

  async function reordenar(ordem) {
    try {
      const v = await req(`/v1/videos/${encodeURIComponent(video.id)}/ordem?${qs()}`, { method: "PUT", body: JSON.stringify({ ordem }) });
      aplicar(v);
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------- barra: nome, formato, nova cena, importar, check, render ---------- */

  async function renomear() {
    if (!video) return;
    await editarNome(raiz().querySelector(".vp-nome"), {
      atual: video.nome,
      max: 120,
      salvar: async (nome) => aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}?${qs()}`, { method: "PATCH", body: JSON.stringify({ nome }) })),
      aoFalhar: (e) => toast(e.message),
    });
  }

  async function trocarFormato(formato) {
    if (!video || formato === video.formato) return;
    if (video.cenas.length && !(await confirmar(`Trocar pra ${formato}? As cenas refluem no tamanho novo — confira cada uma depois.`))) {
      raiz().querySelector(".vp-formato").value = video.formato;
      return;
    }
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}?${qs()}`, { method: "PATCH", body: JSON.stringify({ formato }) }));
    } catch (e) {
      toast(e.message);
    }
  }

  async function novaCena() {
    if (!video) return;
    const n = video.cenas.length + 1;
    const html = `<style>\n.titulo{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:64px;font-family:var(--font-family-display);font-weight:var(--font-weight-semibold);letter-spacing:var(--font-letter-spacing-title);font-size:96px;color:var(--color-text)}\n</style>\n<h1 class="titulo">Cena ${n}</h1>\n<script>\ntl.fromTo(".titulo", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 0.2);\n</script>\n`;
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/cenas?${qs()}`, { method: "POST", body: JSON.stringify({ nome: `Cena ${n}`, duracao: 3, html }) });
      aplicar(r.video);
      selecionar(r.cena.id);
    } catch (e) {
      toast(e.message);
    }
  }

  async function rodarCheck() {
    if (!video) return;
    check = { rodando: true };
    pintarBarra();
    try {
      check = await req(`/v1/videos/${encodeURIComponent(video.id)}/check?${qs()}`, { method: "POST", body: "{}" });
    } catch (e) {
      check = { motivo: e.message, erros: 1, achados: [] };
    }
    pintarBarra();
    const erro = check.achados?.find((a) => a.severidade === "erro" && a.cena);
    if (erro) {
      selecionar(erro.cena);
      cardsDom.get(erro.cena)?.raiz.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (check.motivo) toast(`Check não rodou: ${check.motivo}`);
  }

  function menuRender(ancora) {
    if (render) {
      void req(`/v1/videos/render?${qs()}`, { method: "DELETE" }).catch((e) => toast(e.message));
      return;
    }
    fecharMenu();
    const r = ancora.getBoundingClientRect();
    const m = doc.createElement("div");
    m.className = "vp-menu";
    m.setAttribute("role", "menu");
    m.style.left = `${r.right - 200}px`;
    m.style.top = `${r.bottom + 4}px`;
    for (const [rot, q, dica] of [
      ["Rascunho", "draft", "Rápido, pra conferir"],
      ["Final", "high", "Qualidade alta, depois de aprovar as cenas"],
    ]) {
      const b = botao("", "vp-menu-item", () => {
        fecharMenu();
        void renderizar(q);
      });
      b.setAttribute("role", "menuitem");
      b.innerHTML = `<b></b><small></small>`;
      b.querySelector("b").textContent = rot;
      b.querySelector("small").textContent = dica;
      m.append(b);
    }
    doc.body.append(m);
    menuAberto = m;
    m.querySelector("button")?.focus();
  }

  async function renderizar(qualidade) {
    if (!video) return;
    falhaRender = null;
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/render?${qs()}`, { method: "POST", body: JSON.stringify({ qualidade }) });
      render = r.render;
    } catch (e) {
      if (e.status === 409) toast("Já tem um render rodando");
      else if (e.data?.ffmpegNaoInstalado) {
        ffmpeg = { instalado: false, motivo: "FFmpeg não encontrado no PATH" };
      } else falhaRender = { motivo: e.message };
    }
    pintarStatus();
    pintarBarra();
  }

  async function instalar() {
    toast("Instalando o FFmpeg pelo winget…");
    try {
      const r = await instalarFfmpeg();
      if (r.metodo === "pagina") {
        toast("Abri a página do FFmpeg — depois de instalar, volte aqui.");
      } else {
        ffmpeg = await req(`/v1/videos/ffmpeg?forcar=1`);
        toast(ffmpeg.instalado ? "FFmpeg instalado" : "Instalou, mas o motor ainda não achou o FFmpeg — reinicie o motor");
      }
    } catch (e) {
      toast(`Não consegui instalar: ${e.message}`);
    }
    pintarStatus();
    pintarBarra();
  }

  /* ---------- importar tela do DS ---------- */

  async function abrirImportar() {
    if (!video) return;
    const modal = raiz().querySelector(".vp-modal-importar");
    const listaEl = modal.querySelector(".vp-imp-lista");
    const busca = modal.querySelector(".vp-imp-busca");
    listaEl.innerHTML = `<p class="vp-nota">Carregando…</p>`;
    modal.classList.remove("hidden");
    busca.value = "";
    busca.focus();
    let telas = [];
    try {
      telas = (await req(`/v1/videos/catalogo?${qs()}`)).telas || [];
    } catch (e) {
      listaEl.innerHTML = "";
      listaEl.append(alerta("erro", "Não consegui ler o DS:", e.message));
      return;
    }
    const desenhar = () => {
      const termo = busca.value.trim().toLowerCase();
      const filtradas = telas.filter((t) => !termo || `${t.titulo} ${t.secao} ${t.card}`.toLowerCase().includes(termo));
      listaEl.innerHTML = "";
      if (!telas.length) {
        listaEl.innerHTML = `<p class="vp-nota">Nenhuma tela no DS oficial ainda.</p>`;
        return;
      }
      if (!filtradas.length) {
        listaEl.innerHTML = `<p class="vp-nota">Nada com “${termo.replace(/</g, "&lt;")}”.</p>`;
        return;
      }
      const grupos = new Map();
      for (const t of filtradas) {
        const k = `${t.nome} · ${t.secao}`;
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(t);
      }
      for (const [k, itens] of grupos) {
        const h = doc.createElement("p");
        h.className = "vp-rot";
        h.textContent = k;
        listaEl.append(h);
        for (const t of itens) {
          const b = botao("", "vp-imp-item", async () => {
            modal.classList.add("hidden");
            try {
              const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/importar?${qs()}`, { method: "POST", body: JSON.stringify({ sistema: t.sistema, card: t.card }) });
              aplicar(r.video);
              selecionar(r.cena.id);
              cardsDom.get(r.cena.id)?.raiz.scrollIntoView({ behavior: "smooth", block: "nearest" });
            } catch (e) {
              toast(e.message);
            }
          });
          b.innerHTML = `<b></b><span class="vp-mono"></span>`;
          b.querySelector("b").textContent = t.titulo;
          b.querySelector(".vp-mono").textContent = t.card;
          listaEl.append(b);
        }
      }
    };
    busca.oninput = desenhar;
    desenhar();
  }

  /* ---------- inspector ---------- */

  function alternarInspector() {
    inspecionando = !inspecionando;
    for (const c of cardsDom.values()) postar(c, { tipo: "inspecionar", ligado: inspecionando });
    raiz().querySelector(".vp-mira").classList.toggle("hidden", !inspecionando && !apontados.length);
    pintarBarra();
  }

  function apontar(cenaId, m) {
    apontados.push({ cena: cenaId, seletor: m.seletor, texto: m.texto, tag: m.tag });
    pintarMira();
  }

  function pintarMira() {
    const box = raiz().querySelector(".vp-mira");
    box.classList.toggle("hidden", !inspecionando && !apontados.length);
    const ul = box.querySelector("ul");
    ul.innerHTML = "";
    apontados.forEach((a, i) => {
      const li = doc.createElement("li");
      const n = video.cenas.findIndex((c) => c.id === a.cena) + 1;
      li.textContent = `Cena ${n} → ${a.seletor}${a.texto ? ` “${a.texto.slice(0, 40)}”` : ""}`;
      const x = botao("✕", "vp-fant", () => {
        apontados.splice(i, 1);
        pintarMira();
      });
      x.setAttribute("aria-label", "Remover");
      li.append(x);
      ul.append(li);
    });
  }

  function mandarMira() {
    const pedido = raiz().querySelector(".vp-mira textarea").value.trim();
    if (!pedido && !apontados.length) return;
    const elementos = apontados.map((a, i) => {
      const n = video.cenas.findIndex((c) => c.id === a.cena) + 1;
      return {
        rotulo: `${a.tag} ${i + 1}`,
        seletor: `vídeo ${video.id} · cena ${n} (${a.cena}) → ${a.seletor}`,
        ...(a.texto ? { texto: a.texto } : {}),
        html: "",
      };
    });
    const texto = `${pedido}\n\n(Vídeo "${video.nome}", id ${video.id}: edite a cena com nexo_video_cena_salvar e confira com nexo_video_print.)`;
    aoMandarNoChat(texto, elementos);
    apontados = [];
    raiz().querySelector(".vp-mira textarea").value = "";
    if (inspecionando) alternarInspector();
    pintarMira();
  }

  /* ---------- player (Preview) ---------- */

  let playerTocando = false;
  function abrirDrawer() {
    if (!video) return;
    const d = raiz().querySelector(".vp-drawer");
    d.classList.remove("hidden");
    const f = d.querySelector("iframe");
    f.src = api(`${video.previa}player.html?v=${Date.now().toString(36)}`);
    d.querySelector(".vp-player-range").max = String(video.linha.total);
    d.querySelector(".vp-player-range").value = "0";
    d.querySelector(".vp-player-t").textContent = `0,0 s / ${fmtS(video.linha.total)}`;
    playerTocando = false;
    pintarPlayer();
  }
  function fecharDrawer() {
    const d = raiz()?.querySelector(".vp-drawer");
    if (!d) return;
    d.querySelector("iframe").src = "about:blank";
    d.classList.add("hidden");
  }
  function postarPlayer(msg) {
    raiz().querySelector(".vp-drawer iframe").contentWindow?.postMessage(msg, "*");
  }
  function pintarPlayer() {
    raiz().querySelector(".vp-player-play").textContent = playerTocando ? "❚❚ Pausar" : "▶ Tocar";
  }
  function aoMensagemDoPlayer(m) {
    const d = raiz().querySelector(".vp-drawer");
    if (m.tipo === "tempo") {
      d.querySelector(".vp-player-range").value = String(m.t);
      d.querySelector(".vp-player-t").textContent = `${fmtS(m.t)} / ${fmtS(video?.linha.total)}`;
      cursorT = m.t;
      pintarCursor();
      popoverPlayerTempo?.(m.t);
    } else if (m.tipo === "fim") {
      playerTocando = false;
      pintarPlayer();
      anunciarCursorParado();
      popoverPlayerFim?.();
    }
  }

  /* ---------- popover de transição ---------- */

  let popover = null; // { de, para, ancora, gerando, frame, frameT, erro }
  let popoverPlayerTempo = null;
  let popoverPlayerFim = null;
  let debounceDur = 0;

  function abrirPopover(de, para, ancora) {
    fecharPopover();
    popover = { de, para, ancora, gerando: false, frame: null, frameT: null, erro: null, carregando: false };
    const p = raiz().querySelector(".vp-pop");
    p.classList.remove("hidden");
    pintarPopover();
    posicionarPopover();
    pedirFrame();
    p.querySelector(".vp-ef.on, .vp-ef")?.focus();
  }

  function fecharPopover() {
    const p = raiz()?.querySelector(".vp-pop");
    if (!p || !popover) return;
    const ancora = popover.ancora;
    popover = null;
    p.classList.add("hidden");
    const mini = p.querySelector(".vp-pop-player iframe");
    if (mini) mini.src = "about:blank";
    // devolve o foco ao conector (a faixa pode ter sido repintada: acha pelo par)
    const con = ancora?.isConnected ? ancora : null;
    con?.focus();
  }

  function posicionarPopover() {
    const p = raiz().querySelector(".vp-pop");
    if (!popover) return;
    const estreito = win.innerWidth < 720;
    p.classList.toggle("vp-pop-drawer", estreito);
    if (estreito) {
      p.style.left = "";
      p.style.top = "";
      return;
    }
    const con = raiz().querySelector(`.vp-con[data-de="${CSS.escape(popover.de)}"][data-para="${CSS.escape(popover.para)}"]`) || popover.ancora;
    const r = con.getBoundingClientRect();
    const base = raiz().getBoundingClientRect();
    const larg = 360;
    const left = Math.max(8, Math.min(base.width - larg - 8, r.left - base.left + r.width / 2 - larg / 2));
    p.style.left = `${left}px`;
    p.style.top = "";
    p.style.bottom = `${base.bottom - r.top + 8}px`;
  }

  function transicaoAtual() {
    if (!video || !popover) return null;
    return video.linha.transicoes.find((t) => t.de === popover.de && t.para === popover.para) || { tipo: "corte", duracao: 0, inicio: 0, maximo: 0 };
  }

  function pintarPopover() {
    const p = raiz().querySelector(".vp-pop");
    if (!popover || !video) return;
    const a = video.cenas.find((c) => c.id === popover.de);
    const b = video.cenas.find((c) => c.id === popover.para);
    if (!a || !b) return fecharPopover();
    const ia = video.cenas.indexOf(a) + 1;
    const t = transicaoAtual();
    const bruta = video.transicoes.find((x) => x.de === popover.de && x.para === popover.para);
    const maximo = maximoDaTransicao(a.duracao, b.duracao);
    p.setAttribute("aria-label", `Transição entre cena ${ia} e cena ${ia + 1}`);
    p.querySelector(".vp-pop-tit").textContent = `Cena ${ia} → Cena ${ia + 1}`;
    p.querySelector(".vp-pop-sub").textContent = `${a.nome} → ${b.nome}`;
    // grade de efeitos (+ personalizadas já geradas no vídeo, reaplicáveis)
    const grade = p.querySelector(".vp-grade");
    grade.innerHTML = "";
    const itens = [...PRESETS.map((x) => ({ ...x })), ...(video.personalizadas || []).map((x) => ({ tipo: "personalizada", nome: `✦ ${x.nome || "Personalizada"}`, codigo: x.codigo, nomeCurto: x.nome, duracao: x.duracao }))];
    for (const it of itens) {
      const ativoAqui = it.tipo === t.tipo && (it.tipo !== "personalizada" || it.codigo === bruta?.codigo);
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = `vp-ef${ativoAqui ? " on" : ""}${it.tipo === "personalizada" ? " ia" : ""}`;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", ativoAqui ? "true" : "false");
      btn.tabIndex = ativoAqui ? 0 : -1;
      btn.innerHTML = `<span class="vp-ic vp-ic-${it.tipo}" aria-hidden="true"><i></i><i></i></span><span></span>`;
      btn.lastElementChild.textContent = it.nome;
      btn.addEventListener("click", () =>
        void aplicarTransicao(it.tipo === "personalizada" ? { tipo: "personalizada", codigo: it.codigo, nome: it.nomeCurto, duracao: it.duracao || 0.8 } : { tipo: it.tipo }),
      );
      btn.addEventListener("keydown", (e) => {
        const todos = [...grade.querySelectorAll(".vp-ef")];
        const i = todos.indexOf(btn);
        const alvo = e.key === "ArrowRight" || e.key === "ArrowDown" ? todos[(i + 1) % todos.length] : e.key === "ArrowLeft" || e.key === "ArrowUp" ? todos[(i - 1 + todos.length) % todos.length] : null;
        if (alvo) {
          e.preventDefault();
          alvo.focus();
        }
      });
      grade.append(btn);
    }
    // duração
    const secDur = p.querySelector(".vp-pop-dur");
    secDur.classList.toggle("hidden", t.tipo === "corte");
    const slider = p.querySelector(".vp-dur-range");
    const campo = p.querySelector(".vp-dur-num");
    const valor = bruta?.duracao ?? t.duracao ?? 0.6;
    if (doc.activeElement !== slider) slider.value = String(Math.min(2, Math.max(0.1, valor)));
    if (doc.activeElement !== campo) campo.value = String(t.duracao || valor).replace(".", ",");
    slider.setAttribute("aria-valuetext", `${String(t.duracao).replace(".", ",")} segundo`);
    const limite = p.querySelector(".vp-dur-limite");
    const curta = a.duracao <= b.duracao ? { n: ia, d: a.duracao } : { n: ia + 1, d: b.duracao };
    const noLimite = t.tipo !== "corte" && (bruta?.duracao ?? 0) > maximo - 1e-9 && (bruta?.duracao ?? 0) >= maximo;
    limite.textContent = `Máx. ${fmtS(maximo)}: a cena ${curta.n} tem ${fmtS(curta.d)}`;
    limite.classList.toggle("hidden", !noLimite);
    // aviso de borrão: fade entre duas telas cheias
    p.querySelector(".vp-borrao").classList.toggle("hidden", !(t.tipo === "fade" && ehTelaCheia(a) && ehTelaCheia(b)));
    // prompt
    const motor = isOk();
    const ta = p.querySelector(".vp-prompt");
    ta.disabled = popover.gerando || !motor;
    p.querySelector(".vp-gerar").disabled = popover.gerando || !motor;
    p.querySelector(".vp-prompt-dica").textContent = motor ? "Vai pro chat em foco" : "Motor desligado: ligue pra gerar a transição";
    const gerando = p.querySelector(".vp-gerando");
    gerando.classList.toggle("hidden", !popover.gerando);
    // frame do meio
    const fr = p.querySelector(".vp-pop-frame");
    fr.style.aspectRatio = `${FORMATOS[video.formato].largura} / ${FORMATOS[video.formato].altura}`;
    const leg = p.querySelector(".vp-pop-leg");
    fr.innerHTML = "";
    fr.className = "vp-pop-frame";
    if (t.tipo === "corte") {
      fr.classList.add("vp-pop-vazio");
      fr.textContent = "Corte seco, sem frame intermediário";
      leg.classList.add("hidden");
    } else if (popover.erro) {
      fr.classList.add("vp-pop-vazio");
      fr.append(alerta("erro", "Não consegui gerar o frame:", popover.erro, [["Tentar de novo", "", () => pedirFrame()]]));
      leg.classList.add("hidden");
    } else if (popover.carregando || !popover.frame) {
      fr.classList.add("vp-sk-t");
      leg.classList.add("hidden");
    } else {
      const img = doc.createElement("img");
      img.src = popover.frame;
      img.alt = `Frame em ${fmtS(popover.frameT)}`;
      fr.append(img);
      leg.classList.remove("hidden");
      leg.querySelector(".vp-pop-t").textContent = `Frame do meio · ${fmtS(popover.frameT)}`;
    }
    p.querySelector(".vp-desfazer").disabled = !bruta?.anterior;
    p.querySelector(".vp-tocar").disabled = t.tipo === "corte";
  }

  async function aplicarTransicao(corpo) {
    if (!video || !popover) return;
    // efeito pronto cancela a espera do prompt
    popover.gerando = false;
    const bruta = video.transicoes.find((x) => x.de === popover.de && x.para === popover.para);
    const duracao = corpo.duracao ?? (bruta && bruta.tipo !== "corte" ? bruta.duracao : 0.6);
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/transicoes?${qs()}`, {
        method: "PUT",
        body: JSON.stringify({ de: popover.de, para: popover.para, ...corpo, duracao }),
      });
      aplicar(r.video);
      pedirFrame();
    } catch (e) {
      toast(e.message);
    }
  }

  async function mudarDuracao(valor) {
    const n = Math.round(Number(String(valor).replace(",", ".")) * 10) / 10;
    if (!(n >= 0.1)) return;
    const bruta = video.transicoes.find((x) => x.de === popover.de && x.para === popover.para);
    win.clearTimeout(debounceDur);
    debounceDur = win.setTimeout(() => {
      void aplicarTransicao({ tipo: bruta?.tipo && bruta.tipo !== "corte" ? bruta.tipo : "fade", duracao: Math.min(2, n), ...(bruta?.tipo === "personalizada" ? { codigo: bruta.codigo, nome: bruta.nome } : {}) });
    }, 300);
  }

  let pedidoFrame = 0;
  async function pedirFrame(deslocar = 0) {
    if (!video || !popover) return;
    const t = transicaoAtual();
    if (!t || t.tipo === "corte" || !(t.duracao > 0)) {
      pintarPopover();
      return;
    }
    const meio = t.inicio + t.duracao / 2;
    const alvo = popover.frameT != null && deslocar ? Math.min(t.inicio + t.duracao, Math.max(t.inicio, popover.frameT + deslocar)) : meio;
    const meu = ++pedidoFrame;
    popover.carregando = true;
    popover.erro = null;
    pintarPopover();
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/snapshot?${qs()}`, { method: "POST", body: JSON.stringify({ t: alvo }) });
      if (meu !== pedidoFrame || !popover) return;
      popover.frame = r.png;
      popover.frameT = r.t;
    } catch (e) {
      if (meu !== pedidoFrame || !popover) return;
      popover.erro = e.message.replace(/^Não consegui gerar o frame:\s*/, "");
    }
    popover.carregando = false;
    pintarPopover();
  }

  function gerarPorPrompt() {
    if (!video || !popover) return;
    const ta = raiz().querySelector(".vp-prompt");
    const prompt = ta.value.trim();
    if (!prompt || !isOk()) return;
    popover.gerando = true;
    pintarPopover();
    aoMandarNoChat(pedidoDeTransicao(video, popover.de, popover.para, prompt), []);
  }

  function aoTransicaoSalva(ev) {
    void carregar().then(() => {
      if (popover && ev.de === popover.de && ev.para === popover.para) {
        popover.gerando = false;
        if (ev.tipo === "personalizada") raiz().querySelector(".vp-prompt").value = "";
        pedirFrame();
      }
    });
  }

  async function desfazerTransicao() {
    if (!video || !popover) return;
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/transicoes/desfazer?${qs()}`, { method: "POST", body: JSON.stringify({ de: popover.de, para: popover.para }) }));
      pedirFrame();
    } catch (e) {
      toast(e.message);
    }
  }

  /** Toca de 0,5 s antes a 0,5 s depois da transição, num player pequeno dentro do popover. */
  function tocarTransicao() {
    const t = transicaoAtual();
    if (!t || t.tipo === "corte") return;
    const box = raiz().querySelector(".vp-pop-player");
    box.classList.remove("hidden");
    box.style.aspectRatio = `${FORMATOS[video.formato].largura} / ${FORMATOS[video.formato].altura}`;
    const f = box.querySelector("iframe");
    const de = Math.max(0, t.inicio - 0.5);
    const ate = Math.min(video.linha.total, t.inicio + t.duracao + 0.5);
    const tocar = () => {
      f.contentWindow?.postMessage({ tipo: "tocar", de }, "*");
      popoverPlayerTempo = (tt) => {
        if (tt >= ate) {
          f.contentWindow?.postMessage({ tipo: "parar" }, "*");
          popoverPlayerTempo = null;
        }
      };
    };
    if (!f.dataset.carregado || f.dataset.carregado !== video.previa + video.linha.total) {
      f.dataset.carregado = video.previa + video.linha.total;
      f.onload = () => win.setTimeout(tocar, 300);
      f.src = api(`${video.previa}player.html?v=${Date.now().toString(36)}`);
    } else tocar();
  }

  /* ---------- trilha de áudio ---------- */

  /** URL da música ATUAL (já copiada pra composição): serve tanto de fonte do <audio> quanto de forma de onda. */
  function urlDaMusicaAtual() {
    const m = video?.audio.musica;
    if (!m || !video) return "";
    const arq = m.fonte.startsWith("nexos:") ? `${m.fonte.slice(6)}.mp3` : m.fonte.slice(8);
    return api(`${video.previa}assets/musica/${encodeURIComponent(arq)}`);
  }

  async function garantirCatalogo() {
    if (catalogo) return catalogo;
    catalogo = await req(`/v1/videos/catalogo?${qs()}`);
    return catalogo;
  }

  /** Toca um trecho de conferência (▶ do seletor de música/efeito) — um de cada vez. */
  function tocarPreview(url, limiteS) {
    previewAudio?.pause();
    const a = new Audio(url);
    a.volume = 0.8;
    previewAudio = a;
    a.play().catch(() => {});
    if (limiteS) win.setTimeout(() => previewAudio === a && a.pause(), limiteS * 1000);
  }

  /** Forma de onda real (decodifica o áudio uma vez, cacheada por URL); `null` = sem suporte/erro, desenha reta. */
  async function formaDeOnda(url) {
    if (!url) return null;
    if (ondaCache.has(url)) return ondaCache.get(url);
    const p = (async () => {
      try {
        const AC = win.AudioContext || win.webkitAudioContext;
        if (!AC) throw new Error("sem AudioContext");
        const buf = await (await fetchImpl(url)).arrayBuffer();
        const ctx = new AC();
        const audio = await ctx.decodeAudioData(buf);
        const dados = audio.getChannelData(0);
        const N = 300;
        const tam = Math.max(1, Math.floor(dados.length / N));
        const picos = [];
        for (let i = 0; i < N; i++) {
          let max = 0;
          const ini = i * tam;
          for (let j = ini; j < Math.min(ini + tam, dados.length); j++) max = Math.max(max, Math.abs(dados[j]));
          picos.push(max);
        }
        void ctx.close?.();
        return picos;
      } catch {
        return null; // sem rede/AudioContext: fallback silencioso pra linha reta
      }
    })();
    ondaCache.set(url, p);
    return p;
  }

  function tempoDoClique(e, el) {
    const r = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return Math.round(frac * (video?.linha.total || 0) * 100) / 100;
  }

  function pintarCursor() {
    const cur = raiz()?.querySelector(".vp-cursor");
    if (!cur) return;
    const total = video?.linha.total || 1;
    cur.style.left = `${(cursorT / total) * 100}%`;
  }

  /** Aria-live só quando o play PARA (regra de acessibilidade — nada de anunciar a cada frame). */
  function anunciarCursorParado() {
    const s = raiz()?.querySelector(".vp-cursor-status");
    if (s) s.textContent = `Parado em ${fmtS(cursorT)}`;
  }

  function aoClicarNaLinhaDoTempo(e, el) {
    if (!video) return;
    const t = tempoDoClique(e, el);
    cursorT = t;
    pintarCursor();
    const jaAberto = !raiz().querySelector(".vp-drawer").classList.contains("hidden");
    abrirDrawer();
    playerTocando = true;
    pintarPlayer();
    win.setTimeout(() => postarPlayer({ tipo: "tocar", de: t }), jaAberto ? 0 : 300);
  }

  function pintarTrilha() {
    if (!video) return;
    const trilha = raiz().querySelector(".vp-trilha");
    const total = video.linha.total || 0;
    const m = video.audio.musica;
    const efeitos = video.audio.efeitos || [];
    trilha.classList.toggle("aberta", trilhaAberta);
    trilha.querySelector(".vp-trilha-colapsar").setAttribute("aria-expanded", trilhaAberta ? "true" : "false");
    const resumo = trilha.querySelector(".vp-trilha-resumo");
    resumo.textContent = `${m ? `♪ ${m.nome.replace(/\s*—\s*ende\.app$/, "")}` : "Sem música"} · ${efeitos.length} efeito${efeitos.length === 1 ? "" : "s"}`;
    resumo.classList.toggle("hidden", trilhaAberta);
    trilha.querySelector(".vp-trilha-corpo").classList.toggle("hidden", !trilhaAberta);
    if (!trilhaAberta) return;

    const nomeBtn = trilha.querySelector(".vp-trilha-musica-nome");
    nomeBtn.textContent = m ? m.nome : "Sem música";
    nomeBtn.classList.toggle("vp-fant", !m);
    const vol = trilha.querySelector(".vp-musica-vol");
    vol.disabled = !m;
    if (doc.activeElement !== vol) vol.value = String(m?.volume ?? VOLUME_MUSICA.padrao);
    trilha.querySelector(".vp-musica-vol-val").textContent = (m?.volume ?? VOLUME_MUSICA.padrao).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    trilha.querySelector(".vp-musica-vol-aviso").classList.toggle("hidden", !volumeMusicaAcima(m?.volume ?? 0));

    // linhas finas nas divisas das cenas (mesma escala % que a régua acima)
    const divs = trilha.querySelector(".vp-trilha-divs");
    divs.innerHTML = "";
    for (const c of video.linha.cenas.slice(0, -1)) {
      const l = doc.createElement("span");
      l.style.left = `${total ? (c.fim / total) * 100 : 0}%`;
      divs.append(l);
    }

    const onda = trilha.querySelector(".vp-onda");
    const musSvg = onda.querySelector("svg");
    const tracej = trilha.querySelector(".vp-onda-vazia");
    const skeleton = trilha.querySelector(".vp-onda-sk");
    const batidasEl = trilha.querySelector(".vp-batidas");
    const rampa = trilha.querySelector(".vp-fade-rampa");
    const avisoCurta = trilha.querySelector(".vp-musica-curta");
    batidasEl.innerHTML = "";
    if (!m) {
      tracej.classList.remove("hidden");
      musSvg.classList.add("hidden");
      skeleton.classList.add("hidden");
      rampa.classList.add("hidden");
      avisoCurta.classList.add("hidden");
    } else {
      tracej.classList.add("hidden");
      const curta = musicaMaisCurtaQueOVideo(m, total);
      const efetiva = total ? Math.min(duracaoEfetivaDaMusica(m, total), total) : duracaoEfetivaDaMusica(m, total);
      onda.style.setProperty("--vp-onda-largura", `${total ? Math.min(100, (efetiva / total) * 100) : 100}%`);
      for (const b of video.batidas || []) {
        if (b.t > efetiva + 0.01) break;
        const t = doc.createElement("span");
        t.className = b.forte ? "forte" : "";
        t.style.left = `${total ? (b.t / total) * 100 : 0}%`;
        batidasEl.append(t);
      }
      rampa.classList.toggle("hidden", curta);
      if (!curta && total) rampa.style.left = `${((total - 1) / total) * 100}%`;
      avisoCurta.classList.toggle("hidden", !curta);
      if (curta) {
        avisoCurta.querySelector(".vp-mono").textContent = `A música acaba em ${fmtS(efetiva)} e o vídeo tem ${fmtS(total)}`;
      }
      const url = urlDaMusicaAtual();
      skeleton.classList.remove("hidden");
      musSvg.classList.add("hidden");
      void formaDeOnda(url).then((picos) => {
        if (!video || urlDaMusicaAtual() !== url) return; // música trocou enquanto decodificava
        skeleton.classList.add("hidden");
        musSvg.classList.remove("hidden");
        const d = picosParaCaminhoSvg(picos);
        musSvg.innerHTML = d
          ? `<path d="${d}" fill="none" stroke="var(--faint)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
          : `<line x1="0" y1="28" x2="300" y2="28" stroke="var(--faint)" stroke-width="1.5"/>`;
      });
    }

    pintarEfeitosNaTrilha();
    pintarCursor();
  }

  async function mudarVolumeMusica(volume) {
    if (!video?.audio.musica) return;
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/musica?${qs()}`, { method: "PUT", body: JSON.stringify({ volume }) }));
    } catch (e) {
      toast(e.message);
    }
  }

  async function repetirMusica(repetir) {
    if (!video?.audio.musica) return;
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/musica?${qs()}`, { method: "PUT", body: JSON.stringify({ repetir }) }));
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------- efeitos na trilha: marcadores, arrastar, mini popover ---------- */

  function pintarEfeitosNaTrilha() {
    const pista = raiz().querySelector(".vp-efeitos-pista");
    pista.innerHTML = "";
    if (!video) return;
    const total = video.linha.total || 1;
    for (const ef of video.audio.efeitos) {
      const cena = video.linha.cenas.find((c) => c.id === ef.cena);
      if (!cena) continue;
      const tAbs = Math.round((cena.inicio + ef.t) * 1000) / 1000;
      if (tAbs > total + 0.05) continue;
      const marcador = doc.createElement("button");
      marcador.type = "button";
      marcador.className = "vp-efeito-marcador";
      marcador.style.left = `${(tAbs / total) * 100}%`;
      marcador.style.setProperty("--vp-alt", `${8 + Math.round((ef.volume || 0) * 24)}px`);
      marcador.dataset.efeito = ef.id;
      marcador.tabIndex = 0;
      marcador.title = `${ef.rotulo} · ${fmtS(tAbs)}`;
      marcador.setAttribute("aria-label", `Efeito ${ef.rotulo} em ${fmtS(tAbs)}, volume ${String(Math.round(ef.volume * 100) / 100).replace(".", ",")}`);
      marcador.innerHTML = `<i></i><span></span>`;
      marcador.querySelector("span").textContent = ef.rotulo;
      marcador.draggable = true;
      marcador.addEventListener("click", (e) => {
        e.stopPropagation();
        abrirMiniPopoverEfeito(ef, marcador);
      });
      marcador.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/x-nexos-efeito", ef.id);
        e.dataTransfer.effectAllowed = "move";
      });
      marcador.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          void removerEfeitoDaTrilha(ef.id);
          return;
        }
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const passo = e.shiftKey ? passoParaBatida(tAbs, dir, video.batidas) : dir * 0.1;
        void moverEfeito(ef, tAbs + passo, false);
      });
      pista.append(marcador);
    }
  }

  async function moverEfeito(ef, tAbsoluto, encaixar) {
    if (!video) return;
    try {
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/efeitos?${qs()}`, {
        method: "PUT",
        body: JSON.stringify({ id: ef.id, tAbsoluto, encaixar }),
      });
      aplicar(r.video);
    } catch (e) {
      toast(e.message);
    }
  }

  async function salvarVolumeEfeito(id, volume) {
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/efeitos?${qs()}`, { method: "PUT", body: JSON.stringify({ id, volume }) }));
    } catch (e) {
      toast(e.message);
    }
  }

  async function removerEfeitoDaTrilha(id) {
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/efeitos/${encodeURIComponent(id)}?${qs()}`, { method: "DELETE" }));
    } catch (e) {
      toast(e.message);
    }
  }

  function mostrarDicaArrasto(pista, e, t, naBatida) {
    let dica = pista.querySelector(".vp-arrasto-dica");
    if (!dica) {
      dica = doc.createElement("div");
      dica.className = "vp-arrasto-dica";
      pista.append(dica);
    }
    const r = pista.getBoundingClientRect();
    dica.style.left = `${Math.max(0, Math.min(r.width, e.clientX - r.left))}px`;
    dica.textContent = `${fmtS(t)}${naBatida ? " · na batida" : ""}`;
  }
  function esconderDicaArrasto() {
    raiz()?.querySelector(".vp-arrasto-dica")?.remove();
  }

  /** Mini popover ao clicar num marcador: tocar, volume, trocar, remover (spec: "clicar num marcador"). */
  function abrirMiniPopoverEfeito(ef, ancora) {
    fecharMenu();
    const m = doc.createElement("div");
    m.className = "vp-menu vp-menu-efeito";
    m.setAttribute("role", "menu");
    const r = ancora.getBoundingClientRect();
    m.style.left = `${Math.max(8, r.left - 90)}px`;
    m.style.top = `${r.top}px`;
    m.innerHTML = `
      <div class="vp-linha vp-menu-efeito-cab">
        <button type="button" class="vp-play" aria-label="Tocar"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg></button>
        <b></b>
      </div>
      <label class="vp-linha vp-menu-efeito-vol"><span class="vp-dica">Volume</span><input type="range" min="0" max="1" step="0.01" /><span class="vp-mono"></span></label>
      <div class="vp-linha"><button type="button" class="vp-btn vp-fant vp-menu-efeito-trocar">Trocar</button><span class="vp-esp"></span><button type="button" class="vp-btn vp-fant vp-menu-dan vp-menu-efeito-remover">Remover</button></div>`;
    m.querySelector("b").textContent = ef.rotulo;
    const slider = m.querySelector("input");
    const val = m.querySelector(".vp-menu-efeito-vol .vp-mono");
    const fmtVol = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    slider.value = String(ef.volume);
    val.textContent = fmtVol(ef.volume);
    let deb = 0;
    slider.addEventListener("input", () => {
      val.textContent = fmtVol(slider.value);
      win.clearTimeout(deb);
      deb = win.setTimeout(() => void salvarVolumeEfeito(ef.id, Number(slider.value)), 250);
    });
    m.querySelector(".vp-menu-efeito-play").addEventListener("click", () => tocarPreview(api(`${video.previa}assets/efeitos/${encodeURIComponent(ef.arquivo)}`)));
    m.querySelector(".vp-menu-efeito-trocar").addEventListener("click", () => {
      fecharMenu();
      abrirSeletorEfeito(null, ancora, ef);
    });
    m.querySelector(".vp-menu-efeito-remover").addEventListener("click", () => {
      fecharMenu();
      void removerEfeitoDaTrilha(ef.id);
    });
    doc.body.append(m);
    menuAberto = m;
  }

  /* ---------- seletor de efeito (popover do "+ Efeito" ou do clique na faixa vazia) ---------- */

  function abrirSeletorEfeito(t, ancora, trocarDe = null) {
    fecharSeletorEfeito();
    seletorEfeitoAberto = { t: t ?? cursorT, trocarDe };
    const pop = raiz().querySelector(".vp-sel-efeito");
    pop.classList.remove("hidden");
    const r = ancora.getBoundingClientRect();
    const base = raiz().getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(base.width - 300, r.left - base.left))}px`;
    pop.style.bottom = `${Math.max(8, base.bottom - r.top + 8)}px`;
    pop.querySelector(".vp-sel-busca").value = "";
    const cats = [...pop.querySelectorAll(".vp-sel-cat")];
    cats.forEach((b, i) => b.classList.toggle("on", i === 0));
    void desenharListaDeEfeitos();
    pop.querySelector(".vp-sel-busca").focus();
  }
  function fecharSeletorEfeito() {
    raiz()?.querySelector(".vp-sel-efeito")?.classList.add("hidden");
    seletorEfeitoAberto = null;
  }

  async function desenharListaDeEfeitos() {
    const pop = raiz().querySelector(".vp-sel-efeito");
    const lista = pop.querySelector(".vp-sel-lista");
    lista.innerHTML = `<p class="vp-nota">Carregando…</p>`;
    let cat;
    try {
      cat = await garantirCatalogo();
    } catch (e) {
      lista.innerHTML = "";
      lista.append(alerta("erro", "Não consegui listar os efeitos:", e.message));
      return;
    }
    if (!seletorEfeitoAberto) return;
    const termo = pop.querySelector(".vp-sel-busca").value.trim().toLowerCase();
    const catAtiva = pop.querySelector(".vp-sel-cat.on")?.dataset.cat || "";
    const itens = cat.efeitos.filter((e) => (!catAtiva || e.categoria === catAtiva) && (!termo || e.arquivo.toLowerCase().includes(termo) || (e.uso || "").toLowerCase().includes(termo)));
    lista.innerHTML = "";
    if (!itens.length) {
      lista.innerHTML = `<p class="vp-nota">Nada encontrado.</p>`;
      return;
    }
    for (const e of itens.slice(0, 150)) {
      const li = doc.createElement("div");
      li.className = "vp-sel-item";
      li.innerHTML = `<button type="button" class="vp-play" aria-label="Tocar"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg></button><span class="vp-sel-nome"></span>`;
      li.querySelector(".vp-sel-nome").textContent = e.arquivo.split("/").pop().replace(/\.(ogg|mp3|wav)$/i, "");
      if (e.cansa) {
        const tag = doc.createElement("span");
        tag.className = "vp-pill vp-av";
        tag.textContent = "cansa";
        li.append(tag);
      }
      li.querySelector("button").addEventListener("click", (ev) => {
        ev.stopPropagation();
        tocarPreview(api(`${video.previa}assets/efeitos/${encodeURIComponent(e.arquivo)}`));
      });
      li.addEventListener("click", () => void escolherEfeito(e.arquivo));
      lista.append(li);
    }
  }

  async function escolherEfeito(arquivo) {
    if (!seletorEfeitoAberto || !video) return;
    const { t, trocarDe } = seletorEfeitoAberto;
    fecharSeletorEfeito();
    try {
      const body = trocarDe ? { id: trocarDe.id, arquivo } : { tAbsoluto: t, arquivo };
      const r = await req(`/v1/videos/${encodeURIComponent(video.id)}/efeitos?${qs()}`, { method: "PUT", body: JSON.stringify(body) });
      aplicar(r.video);
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------- seletor de música (modal) ---------- */

  function mostrarAbaMusica(aba) {
    const modal = raiz().querySelector(".vp-modal-musica");
    modal.querySelectorAll(".vp-mus-aba").forEach((b) => b.classList.toggle("on", b.dataset.aba === aba));
    modal.querySelectorAll(".vp-mus-painel").forEach((p) => p.classList.toggle("hidden", p.dataset.aba !== aba));
  }

  async function abrirSeletorMusica() {
    if (!video) return;
    const modal = raiz().querySelector(".vp-modal-musica");
    modal.classList.remove("hidden");
    mostrarAbaMusica("nexos");
    const listaEl = modal.querySelector(".vp-mus-lista-nexos");
    listaEl.innerHTML = `<p class="vp-nota">Carregando…</p>`;
    let cat;
    try {
      cat = await garantirCatalogo();
    } catch (e) {
      listaEl.innerHTML = "";
      listaEl.append(alerta("erro", "Não consegui listar as músicas:", e.message));
      return;
    }
    listaEl.innerHTML = "";
    for (const musica of cat.musicas) {
      const li = doc.createElement("div");
      li.className = "vp-mus-item";
      li.classList.toggle("on", video.audio.musica?.fonte === musica.fonte);
      li.innerHTML = `<button type="button" class="vp-play" aria-label="Tocar 10 segundos"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg></button><span class="vp-mus-nome"></span><span class="vp-esp"></span><span class="vp-mono"></span>`;
      li.querySelector(".vp-mus-nome").textContent = musica.nome;
      li.querySelector(".vp-mono").textContent = `${musica.bpm} BPM · ${fmtMin(musica.duracao)}`;
      li.querySelector("button").addEventListener("click", (ev) => {
        ev.stopPropagation();
        tocarPreview(api(`${video.previa}assets/musica-nexos/${encodeURIComponent(musica.fonte.slice(6))}.mp3`), 10);
      });
      li.addEventListener("click", () => void escolherMusicaNexos(musica.fonte));
      listaEl.append(li);
    }
  }

  function fecharSeletorMusica() {
    raiz()?.querySelector(".vp-modal-musica")?.classList.add("hidden");
  }

  async function escolherMusicaNexos(fonte) {
    fecharSeletorMusica();
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/musica?${qs()}`, { method: "PUT", body: JSON.stringify({ fonte }) }));
    } catch (e) {
      toast(e.message);
    }
  }

  async function tirarMusica() {
    fecharSeletorMusica();
    try {
      aplicar(await req(`/v1/videos/${encodeURIComponent(video.id)}/musica?${qs()}`, { method: "PUT", body: "null" }));
    } catch (e) {
      toast(e.message);
    }
  }

  function duracaoDoArquivo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const a = new Audio();
      a.preload = "metadata";
      a.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(Math.round(a.duration));
      };
      a.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("sem duração"));
      };
      a.src = url;
    });
  }

  async function subirMusicaPropria(file, status) {
    status.className = "vp-nota";
    status.textContent = "Enviando…";
    const duracao = await duracaoDoArquivo(file).catch(() => 0);
    try {
      const url = `/v1/videos/${encodeURIComponent(video.id)}/musica/arquivo?${qs()}&nome=${encodeURIComponent(file.name)}${duracao ? `&duracao=${duracao}` : ""}`;
      const res = await fetchImpl(api(url), { method: "POST", headers: { authorization: headers().authorization, "content-type": file.type || "application/octet-stream" }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      fecharSeletorMusica();
      aplicar(data.video);
      if (!data.batidas?.ok) toast(data.batidas?.motivo || "Não achei as batidas; a música entra sem guia");
    } catch (e) {
      status.className = "vp-nota ag-err";
      status.textContent = e.message;
    }
  }

  /* ---------- toast ---------- */

  function toast(msg, acao) {
    const t = raiz()?.querySelector(".vp-toast");
    if (!t) return;
    t.innerHTML = "";
    const s = doc.createElement("span");
    s.textContent = msg;
    t.append(s);
    if (acao) t.append(botao(acao[0], "vp-fant", () => void acao[1]()));
    t.classList.remove("hidden");
    win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => t.classList.add("hidden"), 4500);
  }

  /* ---------- DOM fixo ---------- */

  let ligado = false;
  function ligarUmaVez() {
    if (ligado) return;
    ligado = true;
    const r = raiz();
    r.innerHTML = `
      <div class="vp-barra">
        <span class="vp-nome vp-tit" title="Duplo clique pra renomear"></span>
        <select class="vp-formato vp-pill-sel" aria-label="Formato do vídeo">
          <option value="16:9">16:9 · 1920×1080</option>
          <option value="9:16">9:16 · 1080×1920</option>
          <option value="1:1">1:1 · 1080×1080</option>
        </select>
        <span class="vp-mono vp-total" aria-label="Duração total"></span>
        <span class="vp-sep"></span>
        <button type="button" class="vp-btn vp-btn-nova">+ Nova cena</button>
        <button type="button" class="vp-btn vp-fant vp-btn-importar">Importar tela do DS</button>
        <span class="vp-esp"></span>
        <button type="button" class="vp-pill vp-check-chip hidden"></button>
        <button type="button" class="vp-btn vp-fant vp-btn-apontar" aria-pressed="false" title="Apontar elementos das cenas e mandar pro chat">Apontar</button>
        <button type="button" class="vp-btn vp-fant vp-btn-preview">▶ Preview</button>
        <button type="button" class="vp-btn vp-btn-check">Check</button>
        <button type="button" class="vp-btn vp-pri vp-btn-render" aria-haspopup="menu">Render ▾</button>
      </div>
      <p class="vp-erro ag-err hidden"></p>
      <div class="vp-status"></div>
      <div class="vp-corpo">
        <div class="vp-vazio hidden">
          <p>Nenhuma cena ainda. Peça no chat: <em>monta um vídeo de lançamento da v0.11</em>, crie uma cena ou importe uma tela do DS.</p>
          <div class="vp-acoes"><button type="button" class="vp-btn vp-pri vp-vazio-nova">Nova cena</button><button type="button" class="vp-btn vp-vazio-importar">Importar tela do DS</button></div>
        </div>
        <div class="vp-board" role="list" aria-label="Cenas do vídeo"></div>
      </div>
      <div class="vp-faixa">
        <div class="vp-regua" aria-label="Linha do tempo do vídeo — clique pra tocar a partir daqui"></div>
        <div class="vp-fita" role="list" aria-label="Ordem das cenas"></div>
        <div class="vp-trilha">
          <span class="vp-cursor-status vp-sr-only" aria-live="polite"></span>
          <button type="button" class="vp-trilha-colapsar" aria-expanded="true" title="Recolher/expandir a trilha de áudio">▾</button>
          <span class="vp-trilha-resumo hidden"></span>
          <div class="vp-trilha-corpo">
            <div class="vp-trilha-cab">
              <span aria-hidden="true">♪</span>
              <button type="button" class="vp-trilha-musica-nome vp-fant" title="Trocar a música"></button>
              <span class="vp-linha vp-trilha-vol">
                <input type="range" class="vp-musica-vol" min="0" max="1" step="0.01" aria-label="Volume da música" />
                <span class="vp-mono vp-musica-vol-val"></span>
                <span class="vp-aviso vp-musica-vol-aviso hidden">Acima do recomendado</span>
              </span>
              <span class="vp-esp"></span>
              <button type="button" class="vp-btn vp-fant vp-btn-efeito">+ Efeito</button>
            </div>
            <div class="vp-musica-curta vp-alerta hidden"><span class="vp-alerta-ic" aria-hidden="true">⚠</span><span class="vp-mono"></span><span class="vp-esp"></span><button type="button" class="vp-btn vp-repetir-musica">Repetir música</button><button type="button" class="vp-btn vp-fant vp-silencio-musica">Deixar silêncio no fim</button></div>
            <div class="vp-trilha-pista">
              <div class="vp-trilha-divs" aria-hidden="true"></div>
              <div class="vp-onda">
                <div class="vp-onda-sk hidden"></div>
                <svg viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true"></svg>
                <div class="vp-batidas" aria-hidden="true"></div>
                <div class="vp-fade-rampa hidden" aria-hidden="true"></div>
                <div class="vp-onda-vazia hidden">Sem música. <button type="button" class="vp-btn vp-escolher-musica">Escolher música</button></div>
              </div>
              <div class="vp-efeitos-pista" role="list" aria-label="Efeitos sonoros"></div>
              <div class="vp-cursor" aria-hidden="true"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="vp-sel-efeito vp-modal-pop hidden" role="dialog" aria-label="Escolher efeito sonoro">
        <div class="vp-linha vp-pop-cab"><b>Efeito</b><span class="vp-esp"></span><button type="button" class="vp-x vp-sel-fechar" aria-label="Fechar">✕</button></div>
        <input type="search" class="vp-imp-busca vp-sel-busca" placeholder="Buscar efeito" aria-label="Buscar efeito" />
        <div class="vp-sel-cats">
          <button type="button" class="vp-pill vp-sel-cat on" data-cat="">Todos</button>
          <button type="button" class="vp-pill vp-sel-cat" data-cat="Transição">Transição</button>
          <button type="button" class="vp-pill vp-sel-cat" data-cat="Interface">Interface</button>
          <button type="button" class="vp-pill vp-sel-cat" data-cat="Impacto">Impacto</button>
          <button type="button" class="vp-pill vp-sel-cat" data-cat="Sutil">Sutil</button>
        </div>
        <div class="vp-sel-lista"></div>
      </div>
      <div class="vp-modal-musica vp-modal hidden" role="dialog" aria-label="Música de fundo">
        <div class="vp-modal-caixa">
          <header class="vp-linha"><b>Música de fundo</b><span class="vp-esp"></span><button type="button" class="vp-x vp-mus-fechar" aria-label="Fechar">✕</button></header>
          <div class="vp-mus-abas" role="tablist">
            <button type="button" class="vp-mus-aba on" role="tab" data-aba="nexos">Do Nexos</button>
            <button type="button" class="vp-mus-aba" role="tab" data-aba="minha">Minha música</button>
            <button type="button" class="vp-mus-aba" role="tab" data-aba="sem">Sem música</button>
          </div>
          <div class="vp-mus-painel" data-aba="nexos">
            <div class="vp-mus-lista-nexos"></div>
            <p class="vp-dica vp-mus-credito">Música: ende.app (CC BY 4.0)</p>
          </div>
          <div class="vp-mus-painel hidden" data-aba="minha">
            <div class="vp-mus-drop">Solte o arquivo aqui ou <button type="button" class="vp-btn vp-mus-escolher">Escolher arquivo</button><p class="vp-dica">mp3, wav ou m4a, até 30 MB</p></div>
            <input type="file" class="vp-mus-arquivo hidden" accept=".mp3,.wav,.m4a,audio/*" />
            <p class="vp-mus-status vp-nota"></p>
          </div>
          <div class="vp-mus-painel hidden" data-aba="sem">
            <p class="vp-nota">O vídeo fica sem música de fundo.</p>
            <button type="button" class="vp-btn vp-pri vp-mus-tirar">Usar sem música</button>
          </div>
        </div>
      </div>
      <div class="vp-pop hidden" role="dialog" aria-modal="false">
        <div class="vp-pop-sec vp-pop-cab"><div><b class="vp-pop-tit"></b><small class="vp-pop-sub"></small></div><button type="button" class="vp-x vp-pop-fechar" aria-label="Fechar">✕</button></div>
        <div class="vp-pop-sec"><span class="vp-rot">Efeitos prontos</span><div class="vp-grade" role="radiogroup" aria-label="Efeito da transição"></div></div>
        <div class="vp-pop-sec vp-pop-dur"><span class="vp-rot">Duração</span>
          <div class="vp-linha"><input type="range" class="vp-dur-range" min="0.1" max="2" step="0.1" aria-label="Duração da transição" /><input type="text" class="vp-dur-num" inputmode="decimal" aria-label="Duração em segundos" /></div>
          <span class="vp-dur-limite vp-aviso hidden"></span>
          <div class="vp-borrao vp-alerta hidden"><span class="vp-alerta-ic" aria-hidden="true">⚠</span><span>Fade entre telas cheias fica borrado. Use <em>Pelo fundo</em>.</span><span class="vp-esp"></span><button type="button" class="vp-btn vp-trocar-fundo">Trocar</button></div>
        </div>
        <div class="vp-pop-sec"><span class="vp-rot">Ou descreva</span>
          <textarea class="vp-prompt" rows="2" placeholder="Ex.: a tela sai girando e o logo entra no centro"></textarea>
          <div class="vp-linha"><span class="vp-dica vp-prompt-dica">Vai pro chat em foco</span><span class="vp-esp"></span><button type="button" class="vp-btn vp-pri vp-gerar" title="Ctrl+Enter">Gerar</button></div>
          <div class="vp-gerando vp-linha hidden" aria-live="polite"><span class="vp-spin" aria-hidden="true"></span><span>Gerando no chat…</span></div>
        </div>
        <div class="vp-pop-sec">
          <div class="vp-pop-frame"></div>
          <div class="vp-pop-leg vp-linha hidden"><button type="button" class="vp-seta vp-seta-ant" aria-label="Voltar 0,1 s">‹</button><span class="vp-pop-t"></span><button type="button" class="vp-seta vp-seta-prox" aria-label="Avançar 0,1 s">›</button></div>
          <div class="vp-pop-player hidden"><iframe title="Transição" tabindex="-1"></iframe></div>
        </div>
        <div class="vp-pop-sec vp-linha"><button type="button" class="vp-btn vp-tocar">▶ Tocar transição</button><span class="vp-esp"></span><button type="button" class="vp-btn vp-fant vp-desfazer">Desfazer</button></div>
      </div>
      <aside class="vp-mira hidden" aria-label="Elementos apontados nas cenas">
        <header class="vp-linha"><b>Elementos apontados</b><span class="vp-esp"></span><button type="button" class="vp-x vp-mira-fechar" aria-label="Descartar">✕</button></header>
        <p class="vp-dica">Clique nos elementos das cenas.</p>
        <ul></ul>
        <textarea rows="3" placeholder="O que fazer? Ex.: título entra digitando"></textarea>
        <div class="vp-linha"><span class="vp-esp"></span><button type="button" class="vp-btn vp-pri vp-mira-mandar">Mandar</button></div>
      </aside>
      <div class="vp-drawer hidden" role="dialog" aria-label="Preview do vídeo">
        <header class="vp-linha"><b>Preview</b><span class="vp-esp"></span><button type="button" class="vp-x vp-drawer-fechar" aria-label="Fechar">✕</button></header>
        <div class="vp-player"><iframe title="Preview do vídeo"></iframe></div>
        <div class="vp-linha"><button type="button" class="vp-btn vp-pri vp-player-play">▶ Tocar</button><input type="range" class="vp-player-range" min="0" step="0.01" value="0" aria-label="Tempo do vídeo" /><span class="vp-mono vp-player-t"></span></div>
      </div>
      <div class="vp-modal-importar vp-modal hidden" role="dialog" aria-label="Importar tela do DS">
        <div class="vp-modal-caixa">
          <header class="vp-linha"><b>Importar tela do DS</b><span class="vp-esp"></span><button type="button" class="vp-x vp-imp-fechar" aria-label="Fechar">✕</button></header>
          <input type="search" class="vp-imp-busca" placeholder="Buscar (ex.: chats, popup)" aria-label="Buscar tela" />
          <p class="vp-dica">A tela entra como CÓPIA no fim da faixa: mudar a original depois não mexe na cena.</p>
          <div class="vp-imp-lista"></div>
        </div>
      </div>
      <div class="vp-toast hidden" role="status" aria-live="polite"></div>`;
    const q = (s) => r.querySelector(s);
    q(".vp-nome").addEventListener("dblclick", () => void renomear());
    q(".vp-formato").addEventListener("change", (e) => void trocarFormato(e.target.value));
    q(".vp-btn-nova").addEventListener("click", () => void novaCena());
    q(".vp-vazio-nova").addEventListener("click", () => void novaCena());
    q(".vp-btn-importar").addEventListener("click", () => void abrirImportar());
    q(".vp-vazio-importar").addEventListener("click", () => void abrirImportar());
    q(".vp-imp-fechar").addEventListener("click", () => q(".vp-modal-importar").classList.add("hidden"));
    q(".vp-btn-check").addEventListener("click", () => void rodarCheck());
    q(".vp-check-chip").addEventListener("click", () => {
      const erro = check?.achados?.find((a) => a.severidade !== "info");
      if (erro?.cena) {
        selecionar(erro.cena);
        cardsDom.get(erro.cena)?.raiz.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      if (erro) toast(erro.msg);
    });
    q(".vp-btn-render").addEventListener("click", (e) => menuRender(e.currentTarget));
    q(".vp-btn-preview").addEventListener("click", abrirDrawer);
    q(".vp-btn-apontar").addEventListener("click", alternarInspector);
    q(".vp-mira-fechar").addEventListener("click", () => {
      apontados = [];
      if (inspecionando) alternarInspector();
      pintarMira();
    });
    q(".vp-mira-mandar").addEventListener("click", mandarMira);
    q(".vp-drawer-fechar").addEventListener("click", fecharDrawer);
    q(".vp-player-play").addEventListener("click", () => {
      if (playerTocando) {
        postarPlayer({ tipo: "parar" });
        anunciarCursorParado();
      } else postarPlayer({ tipo: "tocar", de: Number(q(".vp-player-range").value) >= (video?.linha.total ?? 0) - 0.05 ? 0 : Number(q(".vp-player-range").value) });
      playerTocando = !playerTocando;
      pintarPlayer();
    });
    q(".vp-player-range").addEventListener("input", (e) => {
      playerTocando = false;
      pintarPlayer();
      postarPlayer({ tipo: "seek", t: Number(e.target.value) });
      q(".vp-player-t").textContent = `${fmtS(e.target.value)} / ${fmtS(video?.linha.total)}`;
    });
    // popover
    q(".vp-pop-fechar").addEventListener("click", fecharPopover);
    q(".vp-dur-range").addEventListener("input", (e) => {
      q(".vp-dur-num").value = String(e.target.value).replace(".", ",");
      e.target.setAttribute("aria-valuetext", `${String(e.target.value).replace(".", ",")} segundo`);
      void mudarDuracao(e.target.value);
    });
    q(".vp-dur-num").addEventListener("change", (e) => void mudarDuracao(e.target.value));
    q(".vp-trocar-fundo").addEventListener("click", () => void aplicarTransicao({ tipo: "fundo" }));
    q(".vp-gerar").addEventListener("click", gerarPorPrompt);
    q(".vp-prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        gerarPorPrompt();
      }
    });
    q(".vp-seta-ant").addEventListener("click", () => void pedirFrame(-0.1));
    q(".vp-seta-prox").addEventListener("click", () => void pedirFrame(0.1));
    q(".vp-desfazer").addEventListener("click", () => void desfazerTransicao());
    q(".vp-tocar").addEventListener("click", tocarTransicao);
    // trilha de áudio
    q(".vp-trilha-colapsar").addEventListener("click", () => {
      trilhaAberta = !trilhaAberta;
      try {
        win.localStorage?.setItem("nexos-video-trilha", trilhaAberta ? "1" : "0");
      } catch {
        /* sem storage: só não lembra entre sessões */
      }
      pintarTrilha();
    });
    for (const sel of [".vp-trilha-musica-nome", ".vp-escolher-musica"]) q(sel).addEventListener("click", () => void abrirSeletorMusica());
    q(".vp-musica-vol").addEventListener("input", (e) => {
      q(".vp-musica-vol-val").textContent = Number(e.target.value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      q(".vp-musica-vol-aviso").classList.toggle("hidden", !volumeMusicaAcima(e.target.value));
    });
    q(".vp-musica-vol").addEventListener("change", (e) => void mudarVolumeMusica(Number(e.target.value)));
    q(".vp-repetir-musica").addEventListener("click", () => void repetirMusica(true));
    q(".vp-silencio-musica").addEventListener("click", () => void repetirMusica(false));
    q(".vp-btn-efeito").addEventListener("click", (e) => abrirSeletorEfeito(cursorT, e.currentTarget));
    const pistaEfeitos = q(".vp-efeitos-pista");
    pistaEfeitos.addEventListener("click", (e) => {
      if (e.target.closest(".vp-efeito-marcador") || !video) return;
      abrirSeletorEfeito(tempoDoClique(e, pistaEfeitos), e.currentTarget);
    });
    pistaEfeitos.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/x-nexos-efeito")) return;
      e.preventDefault();
      const t = tempoDoClique(e, pistaEfeitos);
      const naBatida = !e.altKey && (video?.batidas || []).some((b) => Math.abs(b.t - t) <= 0.15);
      mostrarDicaArrasto(pistaEfeitos, e, t, naBatida);
    });
    pistaEfeitos.addEventListener("dragleave", esconderDicaArrasto);
    pistaEfeitos.addEventListener("drop", (e) => {
      e.preventDefault();
      esconderDicaArrasto();
      const id = e.dataTransfer.getData("text/x-nexos-efeito");
      const ef = video?.audio.efeitos.find((x) => x.id === id);
      if (!ef) return;
      void moverEfeito(ef, tempoDoClique(e, pistaEfeitos), !e.altKey);
    });
    q(".vp-regua").addEventListener("click", (e) => aoClicarNaLinhaDoTempo(e, e.currentTarget));
    q(".vp-trilha-pista").addEventListener("click", (e) => {
      if (e.target.closest(".vp-efeito-marcador,.vp-efeitos-pista")) return;
      aoClicarNaLinhaDoTempo(e, e.currentTarget);
    });
    // seletor de efeito
    q(".vp-sel-fechar").addEventListener("click", fecharSeletorEfeito);
    q(".vp-sel-busca").addEventListener("input", () => void desenharListaDeEfeitos());
    for (const b of r.querySelectorAll(".vp-sel-cat")) {
      b.addEventListener("click", () => {
        for (const x of r.querySelectorAll(".vp-sel-cat")) x.classList.toggle("on", x === b);
        void desenharListaDeEfeitos();
      });
    }
    // seletor de música
    q(".vp-mus-fechar").addEventListener("click", fecharSeletorMusica);
    for (const b of r.querySelectorAll(".vp-mus-aba")) b.addEventListener("click", () => mostrarAbaMusica(b.dataset.aba));
    q(".vp-mus-tirar").addEventListener("click", () => void tirarMusica());
    const dropMusica = q(".vp-mus-drop");
    const inputMusica = q(".vp-mus-arquivo");
    const escolherArquivo = () => inputMusica.click();
    q(".vp-mus-escolher").addEventListener("click", escolherArquivo);
    dropMusica.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropMusica.classList.add("sobre");
    });
    dropMusica.addEventListener("dragleave", () => dropMusica.classList.remove("sobre"));
    dropMusica.addEventListener("drop", (e) => {
      e.preventDefault();
      dropMusica.classList.remove("sobre");
      const f = e.dataTransfer.files?.[0];
      if (f) void subirMusicaPropria(f, q(".vp-mus-status"));
    });
    inputMusica.addEventListener("change", () => {
      const f = inputMusica.files?.[0];
      inputMusica.value = "";
      if (f) void subirMusicaPropria(f, q(".vp-mus-status"));
    });
    win.addEventListener("message", aoMensagem);
    doc.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (menuAberto) return fecharMenu();
      if (popover) return fecharPopover();
      if (seletorEfeitoAberto) return fecharSeletorEfeito();
      if (!q(".vp-modal-musica").classList.contains("hidden")) return fecharSeletorMusica();
      if (!q(".vp-modal-importar").classList.contains("hidden")) return q(".vp-modal-importar").classList.add("hidden");
      if (inspecionando) alternarInspector();
    });
    doc.addEventListener("mousedown", (e) => {
      if (menuAberto && !menuAberto.contains(e.target)) fecharMenu();
      if (popover && !q(".vp-pop").contains(e.target) && !e.target.closest?.(".vp-con")) fecharPopover();
      if (seletorEfeitoAberto && !q(".vp-sel-efeito").contains(e.target) && !e.target.closest?.(".vp-btn-efeito,.vp-efeitos-pista,.vp-menu-efeito-trocar")) fecharSeletorEfeito();
    });
    win.addEventListener("resize", () => popover && posicionarPopover());
  }

  /** "+ Vídeo" do cabeçalho do Canvas: cria e já abre. */
  async function criar(nome, formato) {
    const v = await req(`/v1/videos?${qs()}`, { method: "POST", body: JSON.stringify({ nome, formato }) });
    await recarregarLista();
    await abrir(v.id);
    return v;
  }

  return {
    ativarCanvas,
    criar,
    parar: pararSse,
    recarregarLista,
    opcoes,
    ativo,
    abrir,
    fechar,
    trocouProjeto,
    /** o agente criou/abriu um vídeo (`video_ativo` no stream do Canvas) */
    async mostrar(id) {
      await recarregarLista();
      await abrir(id);
    },
    _estado: () => ({ video, render, check, popover, selecionada }),
    _toast: toast,
  };
}
