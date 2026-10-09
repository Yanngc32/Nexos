/**
 * Aba "Torre": a visão geral das torres (um prédio por projeto) e, com zoom, a torre de um projeto
 * em corte lateral. A pintura é a de `torre/render.js` num canvas (escala inteira, pixel nunca
 * borrado); em cima dele ficam botões de verdade (acessíveis), plaquinhas, falas e balões em DOM.
 *
 * Desempenho: o loop só roda com a aba visível (`ativo()`); oculta, minimizada ou fechada = nenhum
 * timer e nenhum stream (`dados.pausar`). Ao voltar, tudo recomeça do retrato de agora, sem
 * reencenar o que passou. Com `prefers-reduced-motion` ninguém anda e o zoom é troca direta.
 */
import { passosLegiveis, tempoCurto } from "./painel-view.js";
import { escalaPara } from "./torre/cena.js";
import { PALETA, PROPS, corDaConta, cristalDe, mascaraDoIcone, paletaCom } from "./torre/arte.js";
import { contasDaTorre, textoDoCristal } from "./torre/contas.js";
import { chaveDoProjeto } from "./torre/feed.js";
import { torreModelo } from "./torre/modelo.js";
import { acenarNoPalco, avancarPalco, carregarQuadroNoPalco, mudancaNoQuadro, palcoNovo, recomecarPalco } from "./torre/palco.js";
import { pintorDeCanvas } from "./torre/pintor-canvas.js";
import { nivelDoCristal, pintarTorre, pintarTorreMini, posicoesDoMural } from "./torre/render.js";
import { NIVEL_GERAL, corDoEstandarteCss, miniDaTorre, nivelInicial, resumoGeral, rotuloDaTorre, torreAtiva, torresDaPaisagem } from "./torre/visao.js";

/** Quadros por segundo da torre aberta e da visão geral (só luzes mudam: pouco). */
export const INTERVALO_TORRE_MS = 50;
export const INTERVALO_GERAL_MS = 600;
export const ZOOM_MS = 300;
const ESCALA_PAISAGEM = 4;
const SEM_MOVIMENTO = "(prefers-reduced-motion: reduce)";
/** Lugar pros rótulos dos andares, à esquerda da torre (px). */
const MARGEM_ROTULOS = 130;

const ICO_SETA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const ICO_ALERTA = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>';

const ACAO_DO_ANDAR = {
  mana: { rotulo: "Abrir Configurações › Contas", acao: "contas" },
  observatorio: { rotulo: "Abrir o Planejamento", acao: "plano" },
  biblioteca: { rotulo: "Abrir a Memória do Projeto", acao: "memoria" },
  atelie: { rotulo: "Abrir o Canvas", acao: "canvas" },
};

export function createTorreView({
  el,
  dados,
  getProjetos = () => [],
  getProjetoAtual = () => "",
  aoAbrirConversa = () => {},
  aoAbrirPlano = () => {},
  aoAbrirMemoria = () => {},
  aoAbrirTarefas = () => {},
  aoAbrirCanvas = () => {},
  aoAbrirContas = () => {},
  aoLigarMotor = () => {},
  motorOk = () => true,
  doc = globalThis.document,
  win = globalThis.window ?? globalThis,
  relogio = () => Date.now(),
}) {
  let visivel = false;
  let rodando = false;
  let raf = 0;
  let ultimoQuadro = 0;
  let nivel = null; // NIVEL_GERAL ou a chave de um projeto
  let lembrado = ""; // nível escolhido na sessão
  let palco = null;
  let estado = "carregando"; // carregando | ok | fora
  let modelo = { torres: [], contas: [] };
  let sigGeral = "";
  let faseTocha = -1;
  let zoomando = false;
  let ultimaRoda = 0;
  let geracao = 0;
  const reduzido = () => Boolean(win.matchMedia?.(SEM_MOVIMENTO)?.matches);
  const ativo = () => visivel && !doc.hidden;

  const mk = (tag, cls, texto) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (texto !== undefined) n.textContent = texto;
    return n;
  };
  const corpo = () => el("tr-corpo");

  /* ------------------------------------------------------------------ */
  /*  modelo e projetos                                                  */
  /* ------------------------------------------------------------------ */

  const caminhoDaChave = (chave) => {
    const t = modelo.torres.find((x) => x.chave === chave);
    if (t?.projectPath) return t.projectPath;
    return getProjetos().find((p) => chaveDoProjeto(p) === chave) ?? "";
  };

  const lerModelo = (agora) => {
    modelo = torreModelo(dados.feed, agora, { projetosConhecidos: getProjetos() });
    return modelo;
  };

  /** Quais projetos acompanhar: na visão geral os da paisagem; na torre, só o dela. */
  function observar() {
    if (!dados.ligado) return;
    if (nivel === NIVEL_GERAL || nivel === null) {
      const { visiveis } = torresDaPaisagem(modelo.torres);
      dados.observar(visiveis.map((t) => t.projectPath).filter(Boolean), "");
    } else {
      const path = caminhoDaChave(nivel);
      dados.observar(path ? [path] : [], path);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  balão de hover / popover                                           */
  /* ------------------------------------------------------------------ */

  let balao = null;
  function esconderBalao() {
    balao?.remove();
    balao = null;
  }
  function mostrarBalao(ancora, linhas, { fixo = false, acao = null } = {}) {
    esconderBalao();
    balao = mk("div", "tr-balao");
    balao.setAttribute("role", fixo ? "dialog" : "tooltip");
    for (const [tipo, texto] of linhas) balao.append(mk(tipo === "b" ? "b" : tipo === "code" ? "code" : "i", "", texto));
    if (acao) {
      const b = mk("button", "tr-balao-acao", acao.texto);
      b.type = "button";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        esconderBalao();
        acao.fn();
      });
      balao.append(b);
    }
    const pai = corpo();
    pai.append(balao);
    const r = ancora.getBoundingClientRect();
    const rp = pai.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.right - rp.left + pai.scrollLeft + 8), Math.max(8, rp.width - 230));
    const y = Math.max(8, r.top - rp.top + pai.scrollTop - 4);
    balao.style.left = `${x}px`;
    balao.style.top = `${y}px`;
  }

  /* ------------------------------------------------------------------ */
  /*  barra                                                              */
  /* ------------------------------------------------------------------ */

  function pintarBarra(resumo, nome, cor) {
    const naTorre = nivel !== NIVEL_GERAL && nivel !== null;
    el("btn-tr-voltar").classList.toggle("hidden", !naTorre);
    el("btn-tr-centro").classList.toggle("hidden", !naTorre);
    const nomeEl = el("tr-nome");
    nomeEl.replaceChildren();
    if (naTorre) {
      const est = mk("span", "tr-est");
      est.style.background = corDoEstandarteCss(cor);
      nomeEl.append(est, doc.createTextNode(nome));
    } else nomeEl.textContent = "Torres";
    const r = el("tr-resumo");
    r.replaceChildren();
    // "1 esperando você" ganha ícone + warning (estado nunca só por cor)
    const partes = String(resumo || "").split(" · ").filter(Boolean);
    partes.forEach((p, i) => {
      if (i) r.append(mk("span", "tr-sep", "·"));
      if (/esperando você/.test(p)) {
        const s = mk("span", "tr-esp");
        s.insertAdjacentHTML("afterbegin", ICO_ALERTA);
        s.append(doc.createTextNode(p));
        r.append(s);
      } else r.append(doc.createTextNode(p));
    });
  }

  /* ------------------------------------------------------------------ */
  /*  visão geral                                                        */
  /* ------------------------------------------------------------------ */

  const escalaDaPaisagem = () => ((corpo()?.clientWidth || 800) < 420 ? 2 : ESCALA_PAISAGEM);

  function canvasPixel(w, h, escala) {
    const c = mk("canvas", "px");
    c.width = w * escala;
    c.height = h * escala;
    return c;
  }
  const ctxDe = (c) => c.getContext?.("2d") ?? null;

  function pintarCristalPequeno(c, celula, escala) {
    const ctx = ctxDe(c);
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    const nivelC = nivelDoCristal(celula);
    const paleta = paletaCom({ cristal: cristalDe(corDaConta(celula?.id ?? ""), nivelC) });
    pintorDeCanvas(ctx, escala).masc(`cristal:${corDaConta(celula?.id ?? "")}:${nivelC}`, PROPS.cristal, paleta, 0, 0);
  }

  function pintarIcone(c, nome, escala) {
    const ctx = ctxDe(c);
    const m = mascaraDoIcone(nome);
    if (!ctx || !m) return;
    ctx.clearRect(0, 0, c.width, c.height);
    pintorDeCanvas(ctx, escala).masc(`icone:${nome}`, m, PALETA, 0, 0);
  }

  function pintarMini(c, t, agora, escala) {
    const ctx = ctxDe(c);
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    pintarTorreMini(pintorDeCanvas(ctx, escala), 0, 0, miniDaTorre(t), agora);
  }

  const assinaturaGeral = (visiveis, escondidas, contas) =>
    JSON.stringify([
      estado,
      escalaDaPaisagem(),
      visiveis.map((t) => [t.chave, t.nome, t.cor, t.janelas, t.contagem, t.semLeitura.size, Boolean(t.render)]),
      escondidas.length,
      contas.map((c) => [c.id, c.uso, c.bloqueada, c.semDado, c.resetHora]),
    ]);

  function esperaDe(t) {
    return t.magos.find((m) => m.estado === "esperando") ?? t.astronomos.find((a) => a.estado === "esperando");
  }

  function pintarGeral(agora) {
    const { visiveis, escondidas } = torresDaPaisagem(modelo.torres);
    const contas = contasDaTorre(modelo.contas, agora);
    const sig = assinaturaGeral(visiveis, escondidas, contas);
    const fase = Math.floor(agora / INTERVALO_GERAL_MS) % 2;
    const esc = escalaDaPaisagem();
    if (sig !== sigGeral) {
      sigGeral = sig;
      construirGeral(visiveis, escondidas, contas, agora, esc);
    } else if (fase !== faseTocha) {
      for (const c of corpo().querySelectorAll("canvas[data-mini]")) {
        const t = visiveis.find((x) => x.chave === c.dataset.mini);
        if (t) pintarMini(c, t, agora, esc);
      }
    }
    faseTocha = fase;
    pintarBarra(estado === "ok" ? resumoGeral(visiveis) : "", "Torres", -1);
  }

  function construirGeral(visiveis, escondidas, contas, agora, esc) {
    esconderBalao();
    const focada = doc.activeElement?.dataset?.torre;
    const raiz = mk("div", "vg");
    raiz.dataset.estado = estado;
    const ceu = mk("div", "vg-ceu");
    contas.forEach((c) => {
      const w = mk("span", "vg-cristal");
      const cv = canvasPixel(7, 12, 3);
      pintarCristalPequeno(cv, c, 3);
      w.append(cv, mk("b", "", c.nome), mk("i", "", textoDoCristal(c)));
      ceu.append(w);
    });
    const paisagem = mk("div", "vg-paisagem");
    paisagem.append(mk("div", "vg-chao"));
    // carregando / motor fora: três silhuetas esmaecidas no lugar das torres de verdade
    const silhueta = () => ({ chave: "", nome: "", cor: -1, janelas: {}, contagem: { trabalhando: 0, esperando: 0, exploradores: 0, segundoPlano: 0, semMana: 0 }, magos: [], astronomos: [], bibliotecarios: [], pintor: null, semLeitura: new Set() });
    for (const t of estado === "ok" ? visiveis : [silhueta(), silhueta(), silhueta()]) {
      const ativa = torreAtiva(t);
      const b = mk("button", `vg-torre${ativa ? "" : " apagada"}`);
      b.type = "button";
      b.dataset.torre = t.chave;
      if (estado === "ok") b.setAttribute("aria-label", rotuloDaTorre(t));
      else b.disabled = true;
      const cv = canvasPixel(15, 26, esc);
      cv.dataset.mini = t.chave;
      cv.setAttribute("aria-hidden", "true");
      pintarMini(cv, t, agora, esc);
      const wrap = mk("span", "vg-img");
      wrap.append(cv);
      b.append(wrap);
      if (estado === "ok") {
        const espera = esperaDe(t);
        if (espera) {
          const q = mk("span", "vg-q");
          q.setAttribute("role", "button");
          q.tabIndex = 0;
          q.setAttribute("aria-label", `Abrir a conversa que espera você em ${t.nome}`);
          const qc = canvasPixel(9, 11, 3);
          pintarIcone(qc, "pergunta", 3);
          q.append(qc);
          const abrir = (e) => {
            e.stopPropagation();
            e.preventDefault();
            aoAbrirConversa({ threadId: espera.threadId, projectPath: t.projectPath });
          };
          q.addEventListener("click", abrir);
          q.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && abrir(e));
          b.append(q);
        }
        if (t.contagem.exploradores) {
          const x = mk("span", "vg-exp");
          x.setAttribute("aria-hidden", "true");
          const tc = canvasPixel(3, 7, 2);
          const ctx = ctxDe(tc);
          if (ctx) pintorDeCanvas(ctx, 2).masc("prop:tocha0", PROPS.tocha0, PALETA, 0, 0);
          x.append(tc, doc.createTextNode(String(t.contagem.exploradores)));
          b.append(x);
        }
        const placa = mk("span", "vg-placa");
        const est = mk("span", "tr-est");
        est.style.background = corDoEstandarteCss(t.cor);
        placa.append(est, doc.createTextNode(t.semLeitura.size ? `${t.nome} · sem leitura` : t.nome));
        b.append(placa);
        b.addEventListener("click", () => void entrar(t.chave, b));
        b.addEventListener("pointerenter", () => mostrarBalao(b, [["b", t.nome], ["i", resumoTexto(t)]]));
        b.addEventListener("pointerleave", esconderBalao);
        b.addEventListener("focus", () => mostrarBalao(b, [["b", t.nome], ["i", resumoTexto(t)]]));
        b.addEventListener("blur", esconderBalao);
        b.addEventListener("keydown", (e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const irmaos = [...paisagem.querySelectorAll(".vg-torre")];
          const i = irmaos.indexOf(b) + (e.key === "ArrowRight" ? 1 : -1);
          irmaos[Math.max(0, Math.min(irmaos.length - 1, i))]?.focus();
          e.preventDefault();
        });
      } else {
        b.append(mk("span", "vg-placa", ""));
      }
      paisagem.append(b);
    }
    if (estado === "ok" && escondidas.length) {
      const mais = mk("button", "vg-mais", `+${escondidas.length} ${escondidas.length === 1 ? "projeto parado" : "projetos parados"}`);
      mais.type = "button";
      mais.addEventListener("click", () => listarEscondidas(mais, escondidas));
      paisagem.append(mais);
    }
    raiz.append(ceu, paisagem);
    const msg = mensagemDoEstado(estado === "ok" && !visiveis.some(torreAtiva) ? "vazio" : estado);
    if (msg) raiz.append(msg);
    corpo().replaceChildren(raiz);
    if (focada) corpo().querySelector(`.vg-torre[data-torre="${CSS.escape?.(focada) ?? focada}"]`)?.focus?.();
  }

  const resumoTexto = (t) => rotuloDaTorre(t).replace(/^[^:]*: /, "");

  function mensagemDoEstado(qual) {
    if (qual === "ok") return null;
    const m = mk("div", `tr-msg tr-msg-${qual}`);
    if (qual === "carregando") m.append(mk("p", "", "Ligando o motor…"));
    else if (qual === "fora") {
      m.append(mk("p", "", "Motor desligado"));
      const b = mk("button", "primary tr-ligar", "Ligar");
      b.type = "button";
      b.addEventListener("click", () => aoLigarMotor());
      m.append(b);
    } else if (qual === "vazio") m.append(mk("p", "", "Tudo quieto no reino."));
    return m;
  }

  function listarEscondidas(ancora, torres) {
    esconderBalao();
    balao = mk("div", "tr-balao tr-lista");
    balao.setAttribute("role", "dialog");
    for (const t of torres) {
      const b = mk("button", "tr-lista-item", t.nome);
      b.type = "button";
      b.addEventListener("click", () => {
        esconderBalao();
        void entrar(t.chave);
      });
      balao.append(b);
    }
    corpo().append(balao);
    const r = ancora.getBoundingClientRect();
    const rp = corpo().getBoundingClientRect();
    balao.style.left = `${Math.max(8, r.left - rp.left + corpo().scrollLeft)}px`;
    balao.style.top = `${Math.max(8, r.top - rp.top + corpo().scrollTop - 8 - balao.childElementCount * 28)}px`;
  }

  /* ------------------------------------------------------------------ */
  /*  torre de um projeto                                                */
  /* ------------------------------------------------------------------ */

  let torreEl = null;
  let cv = null;
  let ctx = null;
  const camadas = {};

  function montarTorre(escala) {
    esconderBalao();
    const palcoEl = mk("div", "tr-palco");
    torreEl = mk("div", "tr-torre");
    cv = mk("canvas", "px tr-canvas");
    cv.setAttribute("role", "img");
    cv.dataset.escala = String(escala);
    ctx = ctxDe(cv);
    torreEl.append(cv);
    for (const nome of ["andares", "areas", "extra", "notas", "contas", "placas", "exploradores", "magos", "falas"]) {
      camadas[nome] = mk("div", `tr-camada tr-${nome}`);
      torreEl.append(camadas[nome]);
    }
    palcoEl.append(torreEl);
    const resumo = mk("p", "tr-resumo-sr");
    resumo.id = "tr-resumo-sr";
    resumo.className = "tr-sr";
    corpo().replaceChildren(palcoEl, resumo);
    torreEl.style.marginLeft = `${MARGEM_ROTULOS}px`;
  }

  const px = (v, e) => `${Math.round(v * e)}px`;

  /** Sincroniza filhos de `pai` por `chave` (cria, atualiza e remove) sem recriar os que já existem. */
  function sincronizar(pai, itens, criar, atualizar) {
    const existentes = new Map([...pai.children].map((n) => [n.dataset.k, n]));
    const vistos = new Set();
    for (const it of itens) {
      vistos.add(it.k);
      let n = existentes.get(it.k);
      if (!n) {
        n = criar(it);
        n.dataset.k = it.k;
        pai.append(n);
      }
      atualizar(n, it);
    }
    for (const [k, n] of existentes) if (!vistos.has(k)) n.remove();
  }

  const posiciona = (n, x, y, w, h, e) => {
    n.style.left = px(x, e);
    n.style.top = px(y, e);
    if (w !== undefined) {
      n.style.width = px(w, e);
      n.style.height = px(h, e);
    }
  };

  function rotuloDoMago(h) {
    const passos = h.estado === "trabalhando" || h.estado === "pensando" ? passosLegiveis(h.passos)[0] : null;
    const linhas = [["b", h.titulo]];
    const desde = h.estado === "trabalhando" || h.estado === "pensando" ? h.pedidoEm : h.fimEm;
    linhas.push(["i", `${h.texto}${desde ? ` · há ${tempoCurto(relogio() - desde)}` : ""}`]);
    if (h.pergunta?.texto) linhas.push(["code", `Pergunta · ${h.pergunta.texto}`]);
    else if (passos) linhas.push(["code", `${passos.verbo}${passos.curto ? ` · ${passos.curto}` : ""}`]);
    return linhas;
  }

  function desenharTorre(f, agora) {
    const e = Number(cv.dataset.escala);
    const cena = f.cena;
    const larg = cena.w * e;
    const alt = cena.h * e;
    if (cv.width !== larg || cv.height !== alt) {
      cv.width = larg;
      cv.height = alt;
      torreEl.style.width = `${larg}px`;
      torreEl.style.height = `${alt}px`;
    }
    if (ctx) {
      ctx.clearRect(0, 0, cv.width, cv.height);
      // só pinta quem está na área visível da torre (rolagem): com muitos personagens, o resto não custa nada
      const c = corpo();
      const topo = (c.scrollTop - torreEl.offsetTop) / e - 24;
      const base = topo + c.clientHeight / e + 48;
      const atores = c.clientHeight ? f.s.atores.filter((a) => a.y + 40 >= topo && a.y - 14 <= base) : f.s.atores;
      pintarTorre(pintorDeCanvas(ctx, e), cena, { ...f.s, atores, apagada: estado === "fora" }, agora);
    }
    cv.setAttribute("aria-label", `Torre do projeto ${f.nome} em corte lateral: ${f.resumo || "sem atividade"}`);
    const sr = doc.getElementById("tr-resumo-sr");
    if (sr) sr.textContent = [`Torre ${f.nome}.`, f.resumo, ...f.hits.magos.map((h) => h.rotulo)].filter(Boolean).join(" ");

    // rótulos dos andares + área clicável dos andares de apoio
    const andares = [...f.andares.map((a) => ({ k: a.id, a })), { k: "dungeon", a: { id: "dungeon", rotulo: "Dungeon", y: cena.dungeon.y, h: 30, x: cena.dungeon.x, w: cena.dungeon.w } }];
    sincronizar(camadas.andares, andares, () => mk("span", "tr-and"), (n, { a }) => {
      n.textContent = a.semLeitura ? `${a.rotulo} · sem leitura` : a.rotulo;
      n.classList.toggle("sem-leitura", Boolean(a.semLeitura));
      n.style.top = px(a.y + Math.floor(a.h / 2) - 3, e);
    });
    sincronizar(camadas.areas, f.andares.filter((a) => ACAO_DO_ANDAR[a.id]).map((a) => ({ k: a.id, a })), ({ a }) => {
      const b = mk("button", "tr-area");
      b.type = "button";
      b.setAttribute("aria-label", ACAO_DO_ANDAR[a.id].rotulo);
      b.title = ACAO_DO_ANDAR[a.id].rotulo;
      b.addEventListener("click", () => acaoDoAndar(ACAO_DO_ANDAR[a.id].acao));
      return b;
    }, (n, { a }) => posiciona(n, a.x, a.y, a.w, a.h, e));

    // legendas dos cristais
    sincronizar(camadas.contas, f.contas.map((c) => ({ k: c.id, c })), () => mk("span", "tr-conta"), (n, { c }) => {
      if (!n.firstChild) n.append(mk("b"), doc.createTextNode(""));
      n.firstChild.textContent = c.nome;
      n.lastChild.textContent = c.texto;
      n.dataset.nivel = c.semDado ? "sem" : c.bloqueada || c.uso >= 1 ? "esgotado" : c.uso >= 0.8 ? "pouco" : "ok";
      n.style.left = px(c.x + 3.5, e);
      n.style.top = px(cena.andares.get("mana").y + 2, e);
    });

    // plaquinhas das mesas
    sincronizar(camadas.placas, f.plaquinhas.map((p) => ({ k: p.chave, p })), () => mk("span", "tr-placa"), (n, { p }) => {
      n.textContent = p.texto;
      n.title = p.titulo;
      n.style.left = px(p.x, e);
      n.style.top = px(p.y, e);
      n.hidden = e < 2 && (corpo().clientWidth || 0) < 420;
    });

    // exploradores: botão + etiqueta
    sincronizar(camadas.exploradores, f.hits.exploradores.map((h) => ({ k: h.chave, h })), (it) => criarExplorador(it.h), (n, { h }) => {
      posiciona(n, h.x, h.y, h.w, h.h, e);
      const rot = n.querySelector(".tr-exp-rotulo");
      const t = `${h.rotulo} · ${tempoCurto(relogio() - h.abertaEm)}`;
      if (rot.textContent !== t) rot.textContent = t;
      n.dataset.fim = h.fim ? "1" : "0";
    });

    // magos e astrônomos: botões de verdade
    const pessoas = [...f.hits.magos.map((h) => ({ k: h.chave, h })), ...f.hits.astronomos.map((h) => ({ k: h.chave, h }))];
    sincronizar(camadas.magos, pessoas, (it) => {
      const b = mk("button", "tr-mago");
      b.type = "button";
      b.addEventListener("click", () => {
        const h = b._h;
        esconderBalao();
        // tchauzinho: o mago acena pra quem clicou (quem espera a resposta não larga o "?")
        if (palco && h.estado !== "esperando" && h.chave.startsWith("conv:")) acenarNoPalco(palco, h.chave, relogio());
        if (h.threadId) aoAbrirConversa({ threadId: h.threadId, projectPath: caminhoDaChave(nivel) });
      });
      b.addEventListener("pointerenter", () => mostrarBalao(b, rotuloDoMago(b._h)));
      b.addEventListener("pointerleave", esconderBalao);
      b.addEventListener("focus", () => mostrarBalao(b, rotuloDoMago(b._h)));
      b.addEventListener("blur", esconderBalao);
      void it;
      return b;
    }, (n, { h }) => {
      n._h = h;
      posiciona(n, h.x, h.y, h.w, h.h, e);
      if (n.getAttribute("aria-label") !== h.rotulo) n.setAttribute("aria-label", h.rotulo);
    });

    // textos soltos: "Nenhum plano", contador de aprendizados, % do render
    sincronizar(camadas.notas, f.notas.map((n) => ({ k: n.k, n })), () => mk("span", "tr-nota"), (n, { n: nota }) => {
      if (n.textContent !== nota.texto) n.textContent = nota.texto;
      n.title = nota.titulo ?? "";
      n.style.left = px(nota.x, e);
      n.style.top = px(nota.y, e);
    });

    // falas
    sincronizar(camadas.falas, f.falas.map((fl) => ({ k: `${fl.chave}:${fl.categoria}`, fl })), () => mk("span", "tr-fala"), (n, { fl }) => {
      if (n.textContent !== fl.texto) n.textContent = fl.texto;
      n.style.left = px(fl.x, e);
      n.style.top = px(fl.y, e);
    });

    // "+N" na porta do salão, mural e estados
    const salao = cena.andares.get("salao");
    const extras = [];
    if (f.escondidos.length) extras.push({ k: "mais", tipo: "mais", n: f.escondidos.length });
    if (f.exploradoresEscondidos) extras.push({ k: "mais-exp", tipo: "mais-exp", n: f.exploradoresEscondidos });
    extras.push({ k: "mural", tipo: "mural" });
    sincronizar(camadas.extra, extras, (it) => {
      if (it.tipo === "mural") {
        const b = mk("button", "tr-mural");
        b.type = "button";
        b.setAttribute("aria-label", "Abrir o Quadro de tarefas");
        b.addEventListener("click", () => aoAbrirTarefas(caminhoDaChave(nivel)));
        b.addEventListener("pointermove", (ev) => hoverDoMural(b, ev));
        b.addEventListener("pointerleave", esconderBalao);
        return b;
      }
      if (it.tipo === "mais-exp") return mk("span", "tr-mais tr-mais-exp");
      const b = mk("button", "tr-mais");
      b.type = "button";
      b.addEventListener("click", () => listarOcultas(b));
      return b;
    }, (n, it) => {
      if (it.tipo === "mural") {
        n._f = f;
        posiciona(n, f.mural.rect.x, f.mural.rect.y, f.mural.rect.w, f.mural.rect.h, e);
      } else if (it.tipo === "mais-exp") {
        n.textContent = `+${it.n} exploradores`;
        n.title = `${it.n} exploradores mais antigos fora da dungeon`;
        n.style.left = px(cena.dungeon.x + cena.dungeon.w - 70, e);
        n.style.top = px(cena.dungeon.y + 2, e);
      } else {
        n.textContent = `+${it.n}`;
        n.title = `${it.n} conversas paradas fora do Salão`;
        n.style.left = px(cena.torre.x + cena.torre.w - 22, e);
        n.style.top = px(salao.y - 1, e);
      }
    });
    camadas.extra._escondidos = f.escondidos;
    camadas.extra._frame = f;

    // vazio / carregando / fora
    const antiga = torreEl.querySelector(".tr-msg");
    const qual = estado !== "ok" ? estado : f.vazia ? "vazio-torre" : "";
    if (!qual && antiga) antiga.remove();
    if (qual && (!antiga || antiga.dataset.qual !== qual)) {
      antiga?.remove();
      const m = qual === "vazio-torre" ? mk("div", "tr-msg tr-msg-vazio") : mensagemDoEstado(qual);
      if (qual === "vazio-torre") m.append(mk("p", "", "Nenhum mago trabalhando neste projeto."));
      m.dataset.qual = qual;
      torreEl.append(m);
      // carregando / motor fora aparecem no alto (primeira tela); "vazio" fala do Salão e fica nele
      const andar = qual === "vazio-torre" ? salao : cena.andares.get("observatorio");
      posiciona(m, 0, andar.y - 2, cena.w, andar.h + 4, e);
    }
    pintarBarra(f.resumo, f.nome, f.cor);
    void agora;
  }

  function criarExplorador(h) {
    const b = mk("button", "tr-exp");
    b.type = "button";
    b.setAttribute("aria-label", `Explorador: ${h.rotulo}`);
    b.append(mk("span", "tr-exp-rotulo"));
    b.addEventListener("click", () => {
      const x = b._h ?? h;
      mostrarBalao(b, [["b", x.rotulo], ["i", `${x.fim ? (x.fim.erro ? "voltou com erro" : "voltou") : "explorando"} · há ${tempoCurto(relogio() - x.abertaEm)}`], ["code", x.tipo]], {
        fixo: true,
        acao: x.threadId ? { texto: "Abrir conversa", fn: () => aoAbrirConversa({ threadId: x.threadId, projectPath: caminhoDaChave(nivel) }) } : null,
      });
    });
    return b;
  }

  function listarOcultas(ancora) {
    const f = camadas.extra._frame;
    const nomes = (camadas.extra._escondidos ?? []).map((chave) => {
      const t = f?.torre?.magos?.find((m) => m.chave === chave);
      return { chave, titulo: t?.titulo ?? chave, threadId: t?.threadId };
    });
    esconderBalao();
    balao = mk("div", "tr-balao tr-lista");
    balao.setAttribute("role", "dialog");
    for (const n of nomes) {
      const b = mk("button", "tr-lista-item", n.titulo);
      b.type = "button";
      b.addEventListener("click", () => {
        esconderBalao();
        if (n.threadId) aoAbrirConversa({ threadId: n.threadId, projectPath: caminhoDaChave(nivel) });
      });
      balao.append(b);
    }
    corpo().append(balao);
    const r = ancora.getBoundingClientRect();
    const rp = corpo().getBoundingClientRect();
    balao.style.left = `${Math.max(8, r.left - rp.left + corpo().scrollLeft - 120)}px`;
    balao.style.top = `${Math.max(8, r.bottom - rp.top + corpo().scrollTop + 4)}px`;
  }

  function hoverDoMural(area, ev) {
    const f = area._f;
    if (!f) return;
    const e = Number(cv.dataset.escala);
    const r = area.getBoundingClientRect();
    const x = (ev.clientX - r.left) / e + f.mural.rect.x;
    const y = (ev.clientY - r.top) / e + f.mural.rect.y;
    const pos = posicoesDoMural(f.cena, { colunas: f.mural.colunas, tarefas: f.mural.tarefas });
    const hit = f.mural.tarefas.find((t) => {
      const p = pos.get(t.id);
      return p && x >= p.x - 1 && x <= p.x + 5 && y >= p.y - 1 && y <= p.y + 6;
    });
    if (hit?.titulo) mostrarBalao(area, [["b", hit.titulo]]);
    else esconderBalao();
  }

  function acaoDoAndar(acao) {
    const path = caminhoDaChave(nivel);
    if (acao === "contas") aoAbrirContas();
    else if (acao === "plano") aoAbrirPlano(path);
    else if (acao === "memoria") aoAbrirMemoria(path);
    else if (acao === "canvas") aoAbrirCanvas(path);
  }

  function centralizar() {
    const f = camadas.extra._frame;
    const c = corpo();
    if (!f || !c) return;
    const e = Number(cv.dataset.escala);
    const salao = f.cena.andares.get("salao");
    const alvo = (salao.y + salao.h / 2) * e - c.clientHeight / 2;
    c.scrollTo?.({ top: Math.max(0, alvo), behavior: reduzido() ? "auto" : "smooth" });
  }

  /* ------------------------------------------------------------------ */
  /*  níveis e zoom                                                      */
  /* ------------------------------------------------------------------ */

  function escalaDaTorre() {
    return escalaPara((corpo()?.clientWidth || 800) - MARGEM_ROTULOS - 24);
  }

  function iniciarNivel(novo) {
    nivel = novo;
    lembrado = novo;
    sigGeral = "";
    faseTocha = -1;
    esconderBalao();
    if (novo === NIVEL_GERAL) {
      palco = null;
      torreEl = null;
      cv = null;
      ctx = null;
      lerModelo(relogio());
      observar();
      pintarGeral(relogio());
      return;
    }
    palco = palcoNovo(novo);
    recomecarPalco(palco);
    const q = dados.feed.quadros.get(novo);
    if (q) carregarQuadroNoPalco(palco, { colunas: q.colunas }, q.tarefas);
    lerModelo(relogio());
    observar();
    montarTorre(escalaDaTorre());
    quadroDaTorre(relogio());
    corpo().scrollTop = 0;
  }

  function animar(elemento, quadros, opcoes) {
    if (reduzido() || !elemento?.animate) return Promise.resolve();
    return elemento.animate(quadros, { duration: ZOOM_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both", ...opcoes }).finished.catch(() => {});
  }

  /** Zoom in: a câmera aproxima na torre clicada e a aba mostra a torre completa. */
  async function entrar(chave, origem) {
    if (zoomando) return;
    zoomando = true;
    try {
      const c = corpo();
      if (origem && !reduzido()) {
        const r = origem.getBoundingClientRect();
        const rc = c.getBoundingClientRect();
        c.style.transformOrigin = `${r.left - rc.left + r.width / 2}px ${r.top - rc.top + r.height / 2}px`;
        await animar(c, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(2.4)", opacity: 0 }]);
      }
      iniciarNivel(chave);
      c.style.transformOrigin = "50% 40%";
      await animar(c, [{ transform: "scale(0.7)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }]);
      c.getAnimations?.().forEach((a) => a.cancel());
    } finally {
      zoomando = false;
    }
  }

  /** Zoom out: "← Todas as torres", Esc ou a roda pra trás no topo da torre. */
  async function sair() {
    if (zoomando || nivel === NIVEL_GERAL || nivel === null) return;
    zoomando = true;
    try {
      const c = corpo();
      c.style.transformOrigin = "50% 40%";
      await animar(c, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.7)", opacity: 0 }]);
      iniciarNivel(NIVEL_GERAL);
      await animar(c, [{ transform: "scale(1.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }]);
      c.getAnimations?.().forEach((a) => a.cancel());
    } finally {
      zoomando = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  loop                                                               */
  /* ------------------------------------------------------------------ */

  function quadroDaTorre(agora) {
    if (!palco || !torreEl) return;
    lerModelo(agora);
    const f = avancarPalco(palco, { modelo, feed: dados.feed, agora, visivel: true, reduzido: reduzido(), tema: "escuro" });
    desenharTorre(f, agora);
  }

  function tique(ts) {
    raf = 0;
    if (!rodando || !ativo()) {
      rodando = false;
      return;
    }
    // o motor caiu ou voltou com a aba aberta: o estado da tela acompanha
    const motor = motorOk();
    if (estado === "ok" && !motor) {
      estado = "fora";
      sigGeral = "";
    } else if (estado !== "ok" && motor) {
      if (!dados.ligado) void recuperar();
      else if (dados.feed.retratoEm) {
        estado = "ok";
        sigGeral = "";
      }
    }
    const intervalo = nivel === NIVEL_GERAL || reduzido() ? INTERVALO_GERAL_MS : INTERVALO_TORRE_MS;
    if (ts - ultimoQuadro >= intervalo) {
      ultimoQuadro = ts;
      const agora = relogio();
      if (!zoomando) {
        if (nivel === NIVEL_GERAL) {
          lerModelo(agora);
          observar();
          pintarGeral(agora);
        } else quadroDaTorre(agora);
      }
    }
    raf = win.requestAnimationFrame(tique);
  }

  function ligarLoop() {
    if (rodando || !ativo()) return;
    rodando = true;
    ultimoQuadro = 0;
    raf = win.requestAnimationFrame(tique);
  }

  function pararLoop() {
    rodando = false;
    if (raf) win.cancelAnimationFrame?.(raf);
    raf = 0;
  }

  /** A aba apareceu (ou a janela voltou): recomeça do retrato de agora. */
  async function acordar() {
    if (!ativo() || dados.ligado) return;
    const minha = ++geracao;
    estado = motorOk() ? "carregando" : "fora";
    if (nivel === null || nivel === NIVEL_GERAL) {
      sigGeral = "";
      pintarGeral(relogio());
    }
    const ok = motorOk() ? await dados.retomar([], "") : false;
    if (minha !== geracao || !ativo()) return;
    estado = ok ? "ok" : "fora";
    lerModelo(relogio());
    const atual = chaveDoProjeto(getProjetoAtual());
    const alvo = nivelInicial(modelo.torres, atual || null, lembrado || "");
    if (nivel === null || nivel !== alvo) iniciarNivel(alvo);
    else {
      sigGeral = "";
      if (nivel !== NIVEL_GERAL) {
        palco = palcoNovo(nivel);
        recomecarPalco(palco);
        observar();
      }
    }
    ligarLoop();
  }

  let recuperando = false;
  /** O motor voltou com a aba aberta e escura: religa os dados e a tela volta ao normal. */
  async function recuperar() {
    if (recuperando) return;
    recuperando = true;
    try {
      const ok = await dados.retomar([], "");
      if (ativo() && ok) {
        estado = "ok";
        sigGeral = "";
        recomecarPalco(palco ?? palcoNovo(""));
      }
    } finally {
      recuperando = false;
    }
  }

  function dormir() {
    pararLoop();
    geracao++;
    dados.pausar();
    esconderBalao();
  }

  function sincronizarAtividade() {
    if (ativo()) void acordar();
    else dormir();
  }

  /* ------------------------------------------------------------------ */
  /*  ligações                                                           */
  /* ------------------------------------------------------------------ */

  function ligar() {
    el("btn-tr-voltar").addEventListener("click", () => void sair());
    el("btn-tr-centro").addEventListener("click", centralizar);
    doc.addEventListener("visibilitychange", sincronizarAtividade);
    el("pane-torre").addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nivel !== NIVEL_GERAL && nivel !== null) {
        e.preventDefault();
        void sair();
      }
    });
    corpo().addEventListener(
      "wheel",
      (e) => {
        if (nivel === NIVEL_GERAL || nivel === null || e.deltaY >= 0 || corpo().scrollTop > 0) return;
        const agora = relogio();
        if (agora - ultimaRoda < 700) return;
        ultimaRoda = agora;
        void sair();
      },
      { passive: true },
    );
    doc.addEventListener("click", (e) => {
      if (balao && balao.getAttribute("role") === "dialog" && !balao.contains(e.target) && !e.target.closest?.(".tr-exp,.tr-mais,.vg-mais")) esconderBalao();
    });
    // trocou o tamanho: escala inteira nova (a visão geral e a torre recalculam)
    if (win.ResizeObserver) {
      let ultima = 0;
      new win.ResizeObserver(() => {
        const l = corpo()?.clientWidth || 0;
        if (!l || l === ultima || !ativo()) return;
        ultima = l;
        if (nivel === NIVEL_GERAL) sigGeral = "";
        else if (nivel !== null && torreEl && escalaDaTorre() !== Number(cv.dataset.escala)) iniciarNivel(nivel);
      }).observe(corpo());
    }
    dados.ouvir("quadro", (ev, path, agora) => {
      if (palco && nivel === chaveDoProjeto(path)) mudancaNoQuadro(palco, dados.feed, ev, agora);
    });
    dados.ouvir("quadroCarregado", (path, quadro, tarefas) => {
      if (palco && nivel === chaveDoProjeto(path)) carregarQuadroNoPalco(palco, quadro, tarefas);
    });
  }

  return {
    ligar,
    /** O painel Torre ficou visível (ou deixou de ficar). */
    visivel(v) {
      const novo = Boolean(v);
      if (novo === visivel) return;
      visivel = novo;
      sincronizarAtividade();
    },
    /** Abre direto numa torre (ilha, paleta): `chave` do projeto ou a visão geral. */
    async abrirEm(chave) {
      lembrado = chave || NIVEL_GERAL;
      if (!ativo()) return;
      if (!dados.ligado) {
        nivel = null;
        await acordar();
      } else if (lembrado !== nivel) await entrar(lembrado);
    },
    /** Evento do SSE global de agentes (o renderer já tem esse stream). */
    aoEventoAgente(ev) {
      dados.aoEventoAgente(ev);
    },
    get nivel() {
      return nivel;
    },
    get rodando() {
      return rodando;
    },
  };
}
