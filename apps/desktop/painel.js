import { createApiClient } from "./api.js";
import { MAGO_ILHA, passoDoClipe } from "./sprites.js";
import { Ilha, caixaDaIlha, faixaDeDespertar, tamanhoDaIlha, ILHA } from "./painel-ilha.js";
import {
  celulasDeConta,
  linhasDeAtividade,
  mudancasDeLimite,
  naoVistas,
  resumoDoFim,
  tempoCurto,
  transicoes,
  VISTA_VALE_MS,
} from "./painel-view.js";
import { TORRES_NA_FAIXA, conversaEsperando, torresDaIlha } from "./painel-torres.js";
import { PALETA } from "./torre/arte.js";
import { pintorDeCanvas } from "./torre/pintor-canvas.js";
import { pintarTorreMini } from "./torre/render.js";
import { mascaraDoIcone } from "./torre/arte.js";
import { miniDaTorre } from "./torre/visao.js";

/**
 * Painel de borda no estilo ilha: recolhida é um traço na borda da tela, compacta mostra o mago e
 * o passo atual, aberta traz os cards — e a pergunta do agente se responde daqui mesmo.
 *
 * Quem sabe se o cursor está em cima é o processo principal (main.cjs, `vigiarPainel`), que manda
 * `painel:hover`; aqui só se decide o que abre, o que aparece e onde. Em troca a página informa
 * os retângulos que são dela (`painelAreas`) — fora deles o clique atravessa pra janela de trás.
 *
 * Poll de 2s contra o daemon (mesmo motivo do painel antigo: três streams vivos custariam mais
 * que um GET local). Motor desligado espaça pra 8s.
 */

const PERIODO_MS = 2000;
const PERIODO_OFF_MS = 8000;
const MAX_TERMINADAS = 8;
/** Conversas que cabem na lista da visão geral; o resto vira "+N". */
const MAX_LINHAS = 4;
/** Anéis que cabem na ilha compacta. */
const MAX_ANEIS_COMPACTO = 3;

const el = (id) => document.getElementById(id);
const body = document.body;
const api = createApiClient({ daemonInfo: () => window.nexo.daemonInfo() });
const semMovimento = matchMedia("(prefers-reduced-motion: reduce)");

let prefs = { mostrar: "dinamico", aneis: "dois", opacidade: 1, espiar: 5, somAoTerminar: true, somAoPedir: true, avisarLimite: true, avisarRenovou: true, atencao: 0.5, critico: 0.8 };
let borda = "topo";
let centro = 360;
/** O que a ilha aberta mostra: "geral", "conta", "pergunta" ou "fim" (+ `alvo`: conta ou conversa). */
let visao = "geral";
let alvo = "";
/** Conversa em destaque no card da esquerda da visão geral ("" = a primeira da lista). */
let foco = "";
let ligado = false;
let dados = { contas: [], agentes: [] };
/** As torres ativas (painel-torres.js), recalculadas a cada pintura a partir do retrato. */
let torresIlha = { torres: [], ativas: 0, esperando: false, primeiraEsperando: "", aria: "Torres: nenhum projeto ativo" };
let agentesAntes = null;
let limitesAntes = null;
/** threadId → { projectPath, projeto, nome, resumo }: terminou e ninguém abriu ainda. */
const terminadas = new Map();
/** threadId → quando a janela principal disse que a pessoa viu (ver `naoVistas`). */
const vistas = new Map();
/** Perguntas que a pessoa recolheu sem responder: não reabrem a ilha sozinhas. */
const dispensadas = new Set();
const atualizando = new Set();
/** Pergunta sendo respondida agora (threadId) e o erro da última tentativa. */
let enviando = "";
let erroDaResposta = "";
let timer = 0;

const ilha = new Ilha();
ilha.aoMudar = () => pintar();

/* ---------------- tema ---------------- */

const HEX = /^#[0-9a-fA-F]{6}$/;
function aplicarAparencia(cfg) {
  if (HEX.test(cfg?.accent ?? "")) document.documentElement.style.setProperty("--accent", cfg.accent);
  if (["grafite", "preto"].includes(cfg?.tema)) document.documentElement.dataset.tema = cfg.tema;
}

/* ---------------- som ---------------- */

let audio = null;
/** Sons curtos sintetizados (sem arquivo): terminou sobe, pedindo resposta desce, limite é grave. */
function tocar(tipo) {
  try {
    audio ??= new AudioContext();
    const notas = { fim: [659.25, 880], pedir: [880, 587.33], limite: [392, 392] }[tipo];
    if (!notas) return;
    const t0 = audio.currentTime;
    notas.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = t0 + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.34);
    });
  } catch {
    // sem áudio (máquina sem saída de som): o painel segue mudo
  }
}

/* ---------------- mago ---------------- */

/**
 * Os mesmos quadros do maguinho da janela principal (pets/nexo/mago), em clipes curtos: aqui ele
 * é só indicador de estado. Só anima com a ilha à vista — recolhida, não roda timer nenhum.
 */
const MAGO = MAGO_ILHA;
const mago = { estado: "", quadro: "", i: 0, timer: 0 };

function quadroDoMago(nome) {
  const src = `pets/nexo/mago/${nome}.png`;
  for (const img of document.querySelectorAll("[data-mago]")) if (img.getAttribute("src") !== src) img.src = src;
}

function passoDoMago() {
  const { nome, ms } = passoDoClipe(MAGO[mago.estado] ?? MAGO.parado, mago.i);
  mago.quadro = nome;
  quadroDoMago(nome);
  mago.i += 1;
  // duração 0 = quadro final do clipe (ou estado de um quadro só): para aqui
  if (!ms || semMovimento.matches) return;
  mago.timer = setTimeout(passoDoMago, ms);
}

function animarMago(estado) {
  if (ilha.modo === "recolhido") {
    clearTimeout(mago.timer);
    mago.estado = "";
    return;
  }
  if (estado !== mago.estado) {
    clearTimeout(mago.timer);
    mago.estado = estado;
    mago.i = 0;
    passoDoMago();
  } else if (mago.quadro) {
    // a visão foi repintada: a imagem nova precisa do quadro que já estava na tela
    quadroDoMago(mago.quadro);
  }
}

/* ---------------- torres (arte pixel em canvas) ---------------- */

/** Torre em miniatura (15×26 px de arte × `escala`); `data-sig` entra no `innerHTML` pra a visão repintar quando as janelas mudam. */
function canvasDaTorre(t, escala) {
  const c = document.createElement("canvas");
  c.width = 15 * escala;
  c.height = 26 * escala;
  c.className = "px";
  c.dataset.sig = JSON.stringify([t.cor, t.janelas]);
  c.setAttribute("aria-hidden", "true");
  const ctx = c.getContext("2d");
  if (ctx) pintarTorreMini(pintorDeCanvas(ctx, escala), 0, 0, miniDaTorre(t), 0);
  return c;
}

function canvasDoIcone(nome, escala) {
  const c = document.createElement("canvas");
  const m = mascaraDoIcone(nome);
  c.width = 9 * escala;
  c.height = 11 * escala;
  c.className = "px";
  c.setAttribute("aria-hidden", "true");
  const ctx = c.getContext("2d");
  if (ctx && m) pintorDeCanvas(ctx, escala).masc(`icone:${nome}`, m, PALETA, 0, 0);
  return c;
}

const TORRE_APAGADA = { cor: -1, janelas: {} };
let ultimaTorreCompacta = "";

/** Ícone de torre + nº de torres ativas (+ "?" em warning se alguém espera). Só repinta quando muda. */
function pintarTorresCompacto() {
  const t = torresIlha.torres[0] ?? TORRE_APAGADA;
  const sig = JSON.stringify([ligado, torresIlha.ativas, torresIlha.esperando, t.cor, t.janelas]);
  const caixa = el("c-torres");
  caixa.setAttribute("aria-label", ligado ? torresIlha.aria : "Torres: motor desligado");
  caixa.dataset.apagada = ligado && torresIlha.ativas ? "0" : "1";
  if (sig === ultimaTorreCompacta) return;
  ultimaTorreCompacta = sig;
  const nos = [canvasDaTorre(ligado ? t : TORRE_APAGADA, 1)];
  if (ligado && torresIlha.esperando) {
    const q = canvasDoIcone("pergunta", 1);
    q.classList.add("q");
    nos.push(q);
  }
  if (ligado && torresIlha.ativas) nos.push(h("b", {}, String(torresIlha.ativas)));
  caixa.replaceChildren(...nos);
}

/** Faixa da ilha aberta: as torres com atividade (no máximo 4), cada uma um botão que abre o Nexos nela. */
function faixaDeTorres() {
  const lista = torresIlha.torres.slice(0, TORRES_NA_FAIXA);
  if (!lista.length) return null;
  const faixa = h("div", { class: "cartao faixa", role: "group", "aria-label": torresIlha.aria });
  for (const t of lista) {
    const espera = conversaEsperando(t);
    const q = espera ? h("span", { class: "q", role: "button", "aria-label": `Abrir a conversa que espera você em ${t.nome}`, data: { acao: "torre-pergunta", thread: espera.threadId, projeto: espera.projectPath } }, canvasDoIcone("pergunta", 2)) : null;
    faixa.append(
      h("button", { type: "button", class: "ft", title: t.nome, "aria-label": `Abrir a torre ${t.nome}`, data: { acao: "torre", chave: t.chave } }, q, canvasDaTorre(t, 2), h("span", {}, t.nome)),
    );
  }
  return faixa;
}

/* ---------------- montagem ---------------- */

/** `h("button", { class: "btn", data: { acao: "x" } }, "texto", filho)` */
function h(tag, props = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = dv;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  n.append(...filhos.filter((f) => f !== null && f !== undefined && f !== false));
  return n;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg(viewBox, ...formas) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of formas) {
    const f = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) f.setAttribute(k, String(v));
    s.append(f);
  }
  return s;
}

const COR = { ok: "var(--ok)", medio: "var(--medio)", alto: "var(--alto)", cheio: "var(--cheio)" };

/**
 * Anel da conta. "dois": o de fora é a semana (7 dias), o de dentro a sessão (5 h). "um": só o de
 * fora, com a janela mais apertada. `pequeno` = o da ilha compacta, sem número.
 */
function anelDaConta(c, pequeno) {
  const dois = prefs.aneis !== "um";
  const circ = (cls, r) => ["circle", { class: cls, cx: 18, cy: 18, r, pathLength: 100 }];
  const formas = [circ("trilho fora", 16), circ("uso fora", 16)];
  if (dois) formas.push(circ("trilho dentro", 11), circ("uso dentro", 11));
  const cinco = c.janelas.find((j) => j.chave === "fiveHour");
  const semana = c.janelas.find((j) => j.chave === "sevenDay");
  const fora = dois ? semana : { pct: c.pct, nivel: c.nivel };
  const dentro = dois ? cinco : null;
  const a = h(
    "span",
    {
      class: pequeno ? "anel p" : "anel",
      data: {
        semFora: fora ? "0" : "1",
        semDentro: dentro ? "0" : "1",
        velha: c.velha ? "1" : "0",
        atualizando: atualizando.has(c.id) ? "1" : "0",
      },
    },
    svg("0 0 36 36", ...formas),
    pequeno ? null : c.bloqueada ? "!" : `${c.velha ? "~" : ""}${c.pct}`,
  );
  if (fora) {
    a.style.setProperty("--pct-fora", String(fora.pct));
    a.style.setProperty("--cor-fora", COR[c.bloqueada ? "cheio" : fora.nivel]);
  }
  if (dentro) {
    a.style.setProperty("--pct-dentro", String(dentro.pct));
    a.style.setProperty("--cor-dentro", COR[c.bloqueada ? "cheio" : dentro.nivel]);
  }
  a.title = `${c.nome} — ${c.bloqueada ? "bloqueada" : `${c.pct}% usado`}`;
  return a;
}

const SELO = {
  esperando: ["esperando você", [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7v6M12 16.5v.5" }]]],
  terminou: ["terminou", [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]]],
  parou: ["parado por você", [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 1.5 }]]],
};
/** Estado com ícone E texto: a cor sozinha não pode ser o único sinal. */
function selo(estado) {
  const [texto, formas] = SELO[estado];
  return h("span", { class: "selo", data: { estado } }, svg("0 0 24 24", ...formas), texto);
}

const magoImg = (pequeno) => h("img", { class: pequeno ? "mago p" : "mago", "data-mago": true, alt: "" });
const botao = (texto, acao, extra = {}, cls = "btn") => h("button", { type: "button", class: cls, data: { acao, ...extra } }, texto);

/** Estados de linha que já não estão rodando (contam como "acabou", não como conversa em voo). */
const ACABOU = new Set(["terminou", "parou"]);

function estadoGeral(linhas) {
  if (linhas.some((l) => l.estado === "esperando")) return "esperando";
  if (linhas.some((l) => l.estado === "trabalhando")) return "trabalhando";
  if (linhas.some((l) => l.estado === "terminou")) return "terminou";
  return "";
}

/* ---------------- compacta ---------------- */

function pintarCompacto(linhas, celulas) {
  const txt = el("c-txt");
  const l = linhas[0];
  const dois = (a, b) => txt.replaceChildren(a, b ? h("i", {}, ` · ${b}`) : "");
  if (!ligado) dois("Motor desligado");
  else if (!l) dois("Nada rodando");
  else if (l.estado === "esperando") dois("Esperando você", l.nome);
  else if (l.estado === "terminou") dois("Terminou", l.nome);
  else if (l.estado === "parou") dois("Parado por você", l.nome);
  else if (l.passos[0]) dois(l.passos[0].verbo, l.passos[0].curto);
  else dois("Pensando", l.nome);
  const rodando = linhas.filter((x) => !ACABOU.has(x.estado)).length;
  el("c-mais").classList.toggle("hidden", rodando < 2);
  el("c-mais").textContent = `+${rodando - 1}`;
  el("c-mais").title = `${rodando} conversas rodando`;
  el("c-aneis").replaceChildren(...celulas.slice(0, MAX_ANEIS_COMPACTO).map((c) => anelDaConta(c, true)));
}

/* ---------------- visões da ilha aberta ---------------- */

function cartaoDoFoco(l) {
  if (!l) {
    return h(
      "div",
      { class: "cartao foco" },
      magoImg(),
      h("div", { class: "inf" }, h("div", { class: "tit" }, ligado ? "Nada rodando agora" : "Motor desligado"), h("div", { class: "acoes" }, botao("Abrir o Nexos", "nexos", {}, "btn lnk"))),
    );
  }
  const inf = h("div", { class: "inf" });
  const meta = l.estado === "trabalhando" ? `${l.projeto} · ${tempoCurto(l.ms)}` : l.projeto;
  inf.append(h("div", { class: "tit" }, h("span", { class: "n" }, l.nome), h("small", {}, meta), l.estado === "trabalhando" ? null : selo(l.estado)));
  const abrir = { thread: l.threadId, projeto: l.projectPath };
  if (l.estado === "trabalhando") {
    if (!l.passos.length) inf.append(h("div", { class: "passo" }, h("span", { class: "ponto", data: { estado: "trabalhando" } }), "Pensando…"));
    l.passos.forEach((p, i) =>
      inf.append(
        h("div", { class: i ? "passo antigo" : "passo" }, h("span", { class: "ponto", data: { estado: i ? "" : "trabalhando" } }), p.verbo, p.alvo ? h("code", {}, p.alvo) : null),
      ),
    );
    inf.append(h("div", { class: "acoes" }, botao("Abrir no Nexos", "abrir", abrir, "btn lnk")));
  } else if (l.estado === "esperando") {
    inf.append(h("p", { class: "texto sec" }, l.pergunta?.texto ?? "Pediu sua resposta pra continuar."));
    inf.append(h("div", { class: "acoes" }, botao("Responder", "ver-pergunta", { thread: l.threadId }, "btn pri"), botao("Abrir no Nexos", "abrir", abrir, "btn lnk")));
  } else {
    if (l.resumo) inf.append(h("p", { class: "texto sec" }, l.resumo));
    inf.append(h("div", { class: "acoes" }, botao("Abrir conversa", "abrir", abrir, "btn pri"), botao("Dispensar", "dispensar", { thread: l.threadId })));
  }
  return h("div", { class: "cartao foco" }, magoImg(), inf);
}

function visaoGeral(linhas, celulas) {
  const emFoco = linhas.find((l) => l.threadId === foco) ?? linhas[0];
  const rodando = linhas.filter((l) => !ACABOU.has(l.estado)).length;
  const lista = h("div", { class: "cartao col" }, h("span", { class: "rot" }, rodando ? `Conversas · ${rodando} rodando` : "Conversas"));
  const rotulo = { esperando: "esperando você", terminou: "terminou", parou: "parado por você" };
  for (const l of linhas.slice(0, MAX_LINHAS)) {
    lista.append(
      h(
        "button",
        { type: "button", class: "lin", title: l.projeto, data: { acao: "foco", thread: l.threadId, sel: l === emFoco ? "1" : "0" } },
        h("span", { class: "ponto", data: { estado: l.estado } }),
        h("span", { class: "n" }, l.nome),
        h("span", { class: "t" }, rotulo[l.estado] ?? tempoCurto(l.ms)),
      ),
    );
  }
  if (linhas.length > MAX_LINHAS) lista.append(h("p", { class: "vazio" }, `+${linhas.length - MAX_LINHAS} no Nexos`));
  if (!linhas.length) lista.append(h("p", { class: "vazio" }, ligado ? "Nenhuma conversa ativa." : "Ligue o motor pra ver as conversas."));
  if (celulas.length) {
    lista.append(
      h(
        "div",
        { class: "contas" },
        ...celulas.map((c) =>
          h("button", { type: "button", class: "conta", title: `${c.nome} — ver o uso`, data: { acao: "conta", conta: c.id } }, anelDaConta(c, false), h("span", { class: "n" }, c.nome)),
        ),
      ),
    );
  }
  return [faixaDeTorres(), cartaoDoFoco(emFoco), lista].filter(Boolean);
}

function visaoDaConta(c) {
  const janelas = h("div", { class: "janelas" });
  for (const j of c.janelas) {
    const barra = h("i");
    barra.style.width = `${j.pct}%`;
    const d = h(
      "div",
      { class: "janela", data: { velha: j.velha ? "1" : "0" } },
      h("div", { class: "janela-topo" }, h("span", { class: "janela-rotulo" }, `${j.rotulo} · ${j.duracao}`), h("span", { class: "janela-pct" }, `${j.velha ? "~" : ""}${j.pct}% usado`)),
      h("span", { class: "janela-reset" }, j.reset),
      h("div", { class: "barra" }, barra),
    );
    d.style.setProperty("--cor", COR[j.nivel]);
    janelas.append(d);
  }
  const ocupada = atualizando.has(c.id);
  return [
    h(
      "div",
      { class: "cartao col" },
      h("div", { class: "tit" }, h("span", { class: "n" }, c.nome), c.engine ? h("small", {}, c.engine) : null),
      c.bloqueada ? h("p", { class: "erro" }, "Conta bloqueada ou sem login.") : null,
      janelas,
      h("div", { class: "acoes" }, botao(ocupada ? "Atualizando…" : "Atualizar agora", "atualizar-conta", { conta: c.id }, "btn"), botao("Voltar", "geral", {}, "btn lnk")),
    ),
  ];
}

function visaoDaPergunta(l) {
  const p = l.pergunta;
  const abrir = { thread: l.threadId, projeto: l.projectPath };
  const inf = h("div", { class: "inf" });
  const lote = p?.total > 1 ? `Pergunta ${p.numero}/${p.total}` : "";
  inf.append(h("div", { class: "tit" }, h("span", { class: "n" }, l.nome), h("small", {}, [l.projeto, lote].filter(Boolean).join(" · ")), selo("esperando")));
  inf.append(h("p", { class: "texto" }, p?.texto ?? "Pediu sua resposta pra continuar."));
  const acoes = h("div", { class: "acoes" });
  // resposta por botão só quando é escolher UMA opção; texto livre e múltipla escolha ficam no chat
  const porBotao = p?.opcoes?.length && !p.multiSelect;
  if (porBotao) {
    p.opcoes.forEach((o, i) => {
      const b = botao(o, "responder", { thread: l.threadId, i: String(i) });
      b.title = o;
      if (enviando === l.threadId) b.setAttribute("disabled", "");
      acoes.append(b);
    });
    acoes.append(botao("Responder no Nexos", "abrir", abrir, "btn lnk"));
  } else {
    acoes.append(botao("Responder no Nexos", "abrir", abrir, "btn pri"));
  }
  inf.append(acoes);
  if (erroDaResposta) inf.append(h("p", { class: "erro" }, erroDaResposta));
  return [h("div", { class: "cartao" }, magoImg(), inf)];
}

function visaoDoFim(l) {
  const abrir = { thread: l.threadId, projeto: l.projectPath };
  return [
    h(
      "div",
      { class: "cartao" },
      magoImg(),
      h(
        "div",
        { class: "inf" },
        h("div", { class: "tit" }, h("span", { class: "n" }, l.nome), h("small", {}, l.projeto), selo(l.estado === "parou" ? "parou" : "terminou")),
        l.resumo ? h("p", { class: "texto sec" }, l.resumo) : null,
        h("div", { class: "acoes" }, botao("Abrir conversa", "abrir", abrir, "btn pri"), botao("Dispensar", "dispensar", { thread: l.threadId })),
      ),
    ),
  ];
}

/** A visão pedida ainda existe? Pergunta respondida em outro lugar, conversa vista: volta pro geral. */
function conferirVisao(linhas, celulas) {
  const some = () => {
    visao = "geral";
    alvo = "";
  };
  if (visao === "pergunta") {
    if (!linhas.some((l) => l.threadId === alvo && l.estado === "esperando")) {
      // outra pergunta na fila toma o lugar; sem nenhuma, a ilha solta o pino e recolhe
      const proxima = linhas.find((l) => l.estado === "esperando" && !dispensadas.has(l.threadId));
      if (proxima && ilha.pinado) alvo = proxima.threadId;
      else {
        const estavaPinada = ilha.pinado;
        some();
        if (estavaPinada) ilha.recolher();
      }
    }
  } else if (visao === "fim") {
    if (!linhas.some((l) => l.threadId === alvo && ACABOU.has(l.estado))) some();
  } else if (visao === "conta") {
    if (!celulas.some((c) => c.id === alvo)) some();
  }
}

let ultimaVisao = "";
function pintarVisao(linhas, celulas) {
  let nos;
  if (visao === "pergunta") nos = visaoDaPergunta(linhas.find((l) => l.threadId === alvo));
  else if (visao === "fim") nos = visaoDoFim(linhas.find((l) => l.threadId === alvo));
  else if (visao === "conta") nos = visaoDaConta(celulas.find((c) => c.id === alvo));
  else nos = visaoGeral(linhas, celulas);
  // só troca o DOM quando algo mudou: o poll roda a cada 2 s e não pode piscar nem perder o hover
  const caixa = h("div", {}, ...nos);
  const chave = `${visao}:${alvo}:${caixa.innerHTML}`;
  if (chave !== ultimaVisao) {
    ultimaVisao = chave;
    el("visao").replaceChildren(...caixa.childNodes);
  }
  el("b-geral").dataset.ativa = visao === "geral" ? "1" : "0";
  el("b-fixar").setAttribute("aria-pressed", ilha.fixado ? "true" : "false");
  el("off").classList.toggle("hidden", ligado);
}

/** Barrinha que encolhe enquanto a ilha aberta espera pra recolher sozinha. */
let contagemDe = 0;
function pintarContagem() {
  const c = el("contagem");
  if (ilha.modo !== "aberto" || !ilha.recolheEm) {
    contagemDe = 0;
    c.style.transition = "none";
    c.style.width = "0px";
    return;
  }
  if (contagemDe === ilha.recolheEm) return;
  contagemDe = ilha.recolheEm;
  c.style.transition = "none";
  c.style.width = "160px";
  void c.offsetWidth;
  c.style.transition = `width ${Math.max(0, ilha.recolheEm - Date.now())}ms linear`;
  c.style.width = "0px";
}

/* ---------------- pintura ---------------- */

function pintar() {
  const agora = Date.now();
  // fundo translúcido: a cor é a do tema (styles de :root), a opacidade vem das Configurações
  const opac = Number(prefs.opacidade);
  document.documentElement.style.setProperty("--opac", `${Math.round((opac >= 0.3 && opac <= 1 ? opac : 1) * 100)}%`);
  const celulas = ligado ? celulasDeConta(dados.contas, agora, prefs) : [];
  const linhas = ligado ? linhasDeAtividade(dados.agentes, terminadas, agora) : [];
  torresIlha = ligado ? torresDaIlha(dados.agentes, agora) : { torres: [], ativas: 0, esperando: false, primeiraEsperando: "", aria: "Torres: motor desligado" };
  conferirVisao(linhas, celulas);

  body.dataset.borda = borda;
  body.dataset.modo = ilha.modo;
  body.dataset.visao = visao;
  body.dataset.atividade = estadoGeral(linhas);
  body.dataset.ligado = ligado ? "1" : "0";

  pintarTorresCompacto();
  pintarCompacto(linhas, celulas);
  if (ilha.modo === "aberto") pintarVisao(linhas, celulas);
  pintarContagem();

  const estadoDoMago = !ligado ? "off" : ilha.modo === "aberto" && visao === "pergunta" ? "esperando" : ilha.modo === "aberto" && visao === "fim" ? "terminou" : estadoGeral(linhas) || "parado";
  animarMago(estadoDoMago);
  posicionar();
}

/** Tamanho e lugar da ilha dentro da janela, e os retângulos que o processo principal vigia. */
let ultimasAreas = "";
function posicionar() {
  const janela = { w: window.innerWidth, h: window.innerHeight };
  const teto = janela.h - ILHA.margem * 2;
  const alt = Math.min(el("aberto").offsetHeight, teto);
  const tam = tamanhoDaIlha(ilha.modo, borda, alt);
  const caixa = caixaDaIlha(borda, centro, janela, tam);
  const ilhaEl = el("ilha");
  ilhaEl.style.setProperty("--w", `${tam.w}px`);
  ilhaEl.style.setProperty("--h", `${tam.h}px`);
  ilhaEl.style.setProperty("--centro", `${caixa.centro}px`);

  // a ilha anima; as áreas já valem pelo tamanho FINAL (medir o DOM no meio da transição pegava
  // o tamanho antigo e o cursor ainda perto caía "dentro", reabrindo o painel)
  const quentes = [{ x: caixa.x, y: caixa.y, w: caixa.w, h: caixa.h }];
  const despertar = ilha.modo === "recolhido" ? faixaDeDespertar(borda, centro, janela) : null;
  const json = JSON.stringify({ quentes, despertar });
  if (json === ultimasAreas) return;
  ultimasAreas = json;
  void window.nexo.painelAreas({ quentes, despertar });
}

/* ---------------- dados ---------------- */

function abrirPergunta(threadId, pinado = true) {
  visao = "pergunta";
  alvo = threadId;
  erroDaResposta = "";
  ilha.abrir({ pinado });
}

async function notar(transicao) {
  const terminou = naoVistas(transicao.terminou, vistas);
  // parada pela pessoa: entra na lista com o selo "parado por você", sem som de "terminei"
  const parou = naoVistas(transicao.parou ?? [], vistas);
  const esperando = transicao.esperando.filter((a) => !dispensadas.has(a.threadId));
  for (const a of [...terminou, ...parou]) {
    const antes = agentesAntes?.find((x) => x.threadId === a.threadId);
    terminadas.set(a.threadId, {
      projectPath: a.projectPath ?? "",
      projeto: a.projectPath ? a.projectPath.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "") : "sem projeto",
      nome: a.agentName || a.preview || a.profileId || "conversa",
      resumo: resumoDoFim(antes?.tail),
      ...(a.parado ? { parou: true } : {}),
    });
  }
  while (terminadas.size > MAX_TERMINADAS) terminadas.delete(terminadas.keys().next().value);

  if (terminou.length || parou.length || esperando.length) {
    if (esperando.length ? prefs.somAoPedir : prefs.somAoTerminar && terminou.length) tocar(esperando.length ? "pedir" : "fim");
    if (prefs.espiar > 0 && prefs.mostrar !== "desligado") {
      // pergunta pede ação: abre e fica. "Terminou"/"parou" só espia — e nunca por cima de uma pergunta aberta
      if (esperando.length) abrirPergunta(esperando[0].threadId);
      else if (!ilha.pinado) {
        visao = "fim";
        alvo = (terminou[0] ?? parou[0]).threadId;
        ilha.abrir({ ms: prefs.espiar * 1000 });
      }
    }
    return;
  }
  // conversa começou a trabalhar: só mostra o compacto, e só se a pessoa não está olhando o Nexos
  if (transicao.comecou.length && prefs.espiar > 0 && ilha.modo === "recolhido") {
    const emFoco = await window.nexo.painelEmFoco?.().catch(() => false);
    if (!emFoco) ilha.espiar(prefs.espiar * 1000);
  }
}

function avisarLimites(celulas) {
  const r = mudancasDeLimite(limitesAntes, celulas, prefs);
  limitesAntes = r.atual;
  let som = false;
  for (const a of r.avisos) {
    const c = celulas.find((x) => x.id === a.conta);
    const nome = c?.nome ?? a.conta;
    if (a.tipo === "limiar" && prefs.avisarLimite) {
      som = true;
      void window.nexo.painelNotificar({
        titulo: a.limiar >= 1 ? `${nome}: limite atingido` : `${nome}: ${a.pct}% usado`,
        corpo: `${a.janela} — ${a.limiar >= 1 ? "a conta vai recusar até renovar" : "chegando perto do limite"}.`,
      });
    }
    if (a.tipo === "renovou" && prefs.avisarRenovou) {
      void window.nexo.painelNotificar({ titulo: `${nome}: limite renovou`, corpo: `${a.janela} começou de novo.` });
    }
  }
  if (som) tocar("limite");
}

async function atualizar() {
  let ok = false;
  try {
    ok = Boolean((await window.nexo.daemonInfo())?.ok);
  } catch {
    ok = false;
  }
  ligado = ok;
  if (!ok) {
    pintar();
    return agendar(PERIODO_OFF_MS);
  }
  try {
    await api.renovarCredenciais();
    const [contas, agentes, cfg] = await Promise.all([
      api.req("/v1/accounts/limits"),
      api.req("/v1/agents"),
      api.req("/v1/config").catch(() => null),
    ]);
    aplicarAparencia(cfg);
    const antes = agentesAntes;
    dados = { contas: Array.isArray(contas) ? contas : [], agentes: Array.isArray(agentes) ? agentes : [] };
    // pergunta que saiu de cena deixa de estar dispensada: a próxima da mesma conversa volta a abrir
    const esperando = new Set(dados.agentes.filter((a) => a.aguardando).map((a) => a.threadId));
    for (const id of dispensadas) if (!esperando.has(id)) dispensadas.delete(id);
    if (antes) await notar(transicoes(antes, dados.agentes));
    agentesAntes = dados.agentes;
    avisarLimites(celulasDeConta(dados.contas, Date.now(), prefs));
  } catch {
    // um poll que falha não apaga a tela: o retrato anterior vale até a próxima resposta
  }
  pintar();
  agendar(PERIODO_MS);
}

function agendar(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => void atualizar(), ms);
}

async function atualizarConta(id) {
  if (atualizando.has(id)) return;
  atualizando.add(id);
  pintar();
  try {
    await api.req(`/v1/accounts/${encodeURIComponent(id)}/limits/atualizar`, { method: "POST" });
  } catch {
    // conta sem suporte/sem login: o anel fica como estava
  }
  atualizando.delete(id);
  void atualizar();
}

async function atualizarTodas() {
  const ids = celulasDeConta(dados.contas, Date.now(), prefs).map((c) => c.id);
  await Promise.all(ids.map(atualizarConta));
}

/** Manda a resposta da pergunta pro daemon; quem tira a pergunta da tela é o poll seguinte. */
async function responder(threadId, indice) {
  if (enviando) return;
  const a = dados.agentes.find((x) => x.threadId === threadId);
  const resposta = a?.pergunta?.opcoes?.[indice];
  if (typeof resposta !== "string") return;
  enviando = threadId;
  erroDaResposta = "";
  pintar();
  try {
    await api.req(`/v1/perguntas/${encodeURIComponent(threadId)}/responder`, { method: "POST", body: JSON.stringify({ resposta }) });
  } catch (e) {
    // 404 = já responderam em outro lugar (o poll tira a pergunta daqui); o resto a pessoa precisa saber
    if (e?.status !== 404) erroDaResposta = "Não deu pra responder daqui. Responda no Nexos.";
  }
  enviando = "";
  await atualizar();
}

/* ---------------- interação ---------------- */

window.nexo.onPainel("painel:hover", (dentro) => {
  if (dentro) ilha.entrou();
  else ilha.saiu();
  pintar();
});
window.nexo.onPainel("painel:lugar", (l) => {
  if (l?.borda) borda = l.borda;
  if (Number.isFinite(l?.centro)) centro = l.centro;
  pintar();
});
window.nexo.onPainel("painel:prefs", (p) => {
  if (p && typeof p === "object") prefs = { ...prefs, ...p };
  ilha.definirPiso(prefs.mostrar === "fixo" ? "compacto" : "recolhido");
  pintar();
});
window.nexo.onPainel("painel:vista", (threadId) => {
  const agora = Date.now();
  vistas.set(threadId, agora);
  for (const [id, em] of vistas) if (agora - em > VISTA_VALE_MS) vistas.delete(id);
  if (terminadas.delete(threadId)) pintar();
});

const ACOES = {
  geral: () => {
    visao = "geral";
    alvo = "";
  },
  atualizar: () => void atualizarTodas(),
  fixar: () => ilha.fixar(!ilha.fixado),
  nexos: () => void window.nexo.painelAbrir({}),
  config: () => void window.nexo.painelConfig(),
  esconder: () => void window.nexo.setPainelPrefs({ mostrar: "desligado" }),
  recolher: () => {
    // recolher com a pergunta na tela = "agora não": ela não reabre a ilha sozinha
    if (visao === "pergunta" && alvo) dispensadas.add(alvo);
    ACOES.geral();
    ilha.recolher();
  },
  foco: (d) => {
    const l = linhasDeAtividade(dados.agentes, terminadas).find((x) => x.threadId === d.thread);
    foco = d.thread;
    if (l?.estado === "esperando") abrirPergunta(d.thread, false);
  },
  "ver-pergunta": (d) => abrirPergunta(d.thread, false),
  torres: () => void window.nexo.painelAbrir({ torre: "geral" }),
  torre: (d) => void window.nexo.painelAbrir({ torre: d.chave || "geral" }),
  "torre-pergunta": (d) => void window.nexo.painelAbrir({ threadId: d.thread, projectPath: d.projeto ?? "" }),
  conta: (d) => {
    visao = "conta";
    alvo = d.conta;
  },
  "atualizar-conta": (d) => void atualizarConta(d.conta),
  abrir: (d) => {
    terminadas.delete(d.thread);
    void window.nexo.painelAbrir({ threadId: d.thread, projectPath: d.projeto ?? "" });
  },
  dispensar: (d) => {
    terminadas.delete(d.thread);
    if (visao === "fim") ilha.recolher();
  },
  responder: (d) => void responder(d.thread, Number(d.i)),
};

const CABECALHO = { "b-geral": "geral", "b-atualizar": "atualizar", "b-fixar": "fixar", "b-nexos": "nexos", "b-config": "config", "b-esconder": "esconder", "b-recolher": "recolher" };
for (const [id, acao] of Object.entries(CABECALHO)) el(id).dataset.acao = acao;

/** O botão de ação debaixo do ponteiro. Pelo ponto, e não pelo `target`: a visão pode ter sido repintada entre apertar e soltar. */
const acaoEm = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-acao]") ?? null;
const chaveDe = (b) => (b ? JSON.stringify(b.dataset) : "");

/*
 * Um gesto só decide tudo: apertou e soltou no mesmo botão = ação; no compacto = abre; arrastou
 * mais de 6px = muda a ilha de borda (de qualquer monitor) — quem move a janela é o processo principal.
 */
let soltarGesto = null;
el("ilha").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // o botão pode ter sido solto fora da janela (o clique atravessa): o gesto antigo não pode sobrar
  soltarGesto?.();
  const ilhaEl = el("ilha");
  const x0 = e.screenX;
  const y0 = e.screenY;
  const apertou = chaveDe(acaoEm(e));
  let arrastando = false;
  const mover = (ev) => {
    if (arrastando || apertou || Math.hypot(ev.screenX - x0, ev.screenY - y0) < 6) return;
    arrastando = true;
    body.dataset.arrastando = "1";
    ilhaEl.setPointerCapture(e.pointerId);
    void window.nexo.painelArrastar(true);
  };
  const soltar = (ev) => {
    window.removeEventListener("pointermove", mover);
    window.removeEventListener("pointerup", soltar);
    window.removeEventListener("pointercancel", soltar);
    soltarGesto = null;
    if (arrastando) {
      delete body.dataset.arrastando;
      void window.nexo.painelArrastar(false);
      return;
    }
    if (ev?.type !== "pointerup") return;
    const b = acaoEm(ev);
    if (b && chaveDe(b) === apertou && !b.hasAttribute("disabled")) ACOES[b.dataset.acao]?.(b.dataset);
    else if (!b && !apertou) ilha.clicar();
    pintar();
  };
  soltarGesto = soltar;
  window.addEventListener("pointermove", mover);
  window.addEventListener("pointerup", soltar);
  window.addEventListener("pointercancel", soltar);
});

// o tempo das conversas em voo anda sozinho (em minutos: basta conferir de vez em quando)
setInterval(() => {
  if (ilha.modo === "aberto") pintar();
}, 20_000);
// a altura da ilha aberta depende do conteúdo: fonte carregou, zoom mudou
window.addEventListener("resize", pintar);

async function iniciar() {
  try {
    const p = await window.nexo.painelPrefs();
    if (p) prefs = { ...prefs, ...p };
  } catch {
    // sem preferências: fica no padrão
  }
  ilha.definirPiso(prefs.mostrar === "fixo" ? "compacto" : "recolhido");
  pintar();
  await atualizar();
}

void iniciar();
