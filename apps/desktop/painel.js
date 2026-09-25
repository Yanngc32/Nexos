import { createApiClient } from "./api.js";
import { fmtDuracao } from "./agent-trace.js";
import { celulasDeConta, linhasDeAtividade, mudancasDeLimite, naoVistas, transicoes, VISTA_VALE_MS } from "./painel-view.js";

/**
 * Painel de borda: a pílula que mora numa borda da tela (desenho do codenotch).
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
/** Depois que o cursor sai: espera um tico antes de recolher (atravessar o vão até o card). */
const RECOLHER_MS = 450;
/** Profundidade da faixa que só desperta a pílula recolhida (o clique ali ainda atravessa). */
const DESPERTAR = 24;
const MAX_TERMINADAS = 8;

const el = (id) => document.getElementById(id);
const body = document.body;
const api = createApiClient({ daemonInfo: () => window.nexo.daemonInfo() });

let prefs = { mostrar: "dinamico", aneis: "dois", opacidade: 1, espiar: 5, somAoTerminar: true, somAoPedir: true, avisarLimite: true, avisarRenovou: true, atencao: 0.5, critico: 0.8 };
let borda = "direita";
let centro = 300;
let hover = false;
let fixo = false;
let espiarAte = 0;
/** O que o card mostra: "atividade", "conta:<id>", "menu" ou null. */
let alvo = null;
let ligado = false;
let dados = { contas: [], agentes: [] };
let agentesAntes = null;
let limitesAntes = null;
/** threadId → { projectPath, projeto, nome }: terminou e ninguém abriu ainda. */
const terminadas = new Map();
/** threadId → quando a janela principal disse que a pessoa viu (ver `naoVistas`). */
const vistas = new Map();
const atualizando = new Set();
let timer = 0;
let recolher = 0;
let arrastou = false;

const vertical = () => borda === "direita" || borda === "esquerda";
const aberto = () => prefs.mostrar === "fixo" || hover || fixo || Date.now() < espiarAte;

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

/* ---------------- pintura ---------------- */

/**
 * Anel da conta. "dois": o de fora é a semana (7 dias), o de dentro a sessão (5 h). "um": só o de
 * fora, com a janela mais apertada.
 */
function svgAnel(dois) {
  const c = (cls, r) => `<circle class="${cls}" cx="18" cy="18" r="${r}" pathLength="100" />`;
  const fora = c("trilho fora", 16) + c("uso fora", 16);
  const dentro = dois ? c("trilho dentro", 12.5) + c("uso dentro", 12.5) : "";
  return `<svg viewBox="0 0 36 36" aria-hidden="true">${fora}${dentro}</svg>`;
}

const COR = { ok: "var(--ok)", medio: "var(--medio)", alto: "var(--alto)", cheio: "var(--cheio)" };

function pintarContas(celulas) {
  const box = el("contas");
  const porId = new Map([...box.children].map((n) => [n.dataset.conta, n]));
  const ordem = [];
  celulas.forEach((c, i) => {
    const dois = prefs.aneis !== "um";
    let b = porId.get(c.id);
    // trocou "um"/"dois" nas Configurações: o anel é refeito
    if (b && b.dataset.aneis !== (dois ? "dois" : "um")) b = null;
    if (!b) {
      b = document.createElement("button");
      b.type = "button";
      b.className = "celula conta";
      b.dataset.conta = c.id;
      b.dataset.alvo = `conta:${c.id}`;
      b.dataset.aneis = dois ? "dois" : "um";
      b.innerHTML = `<span class="anel">${svgAnel(dois)}<span class="letra"></span></span><span class="nome"></span>`;
    }
    b.style.setProperty("--i", String(i + 1));
    const cinco = c.janelas.find((j) => j.chave === "fiveHour");
    const semana = c.janelas.find((j) => j.chave === "sevenDay");
    const fora = dois ? semana : { pct: c.pct, nivel: c.nivel };
    const dentro = dois ? cinco : null;
    b.dataset.semFora = fora ? "0" : "1";
    b.dataset.semDentro = dentro ? "0" : "1";
    if (fora) {
      b.style.setProperty("--pct-fora", String(fora.pct));
      b.style.setProperty("--cor-fora", COR[c.bloqueada ? "cheio" : fora.nivel]);
    }
    if (dentro) {
      b.style.setProperty("--pct-dentro", String(dentro.pct));
      b.style.setProperty("--cor-dentro", COR[c.bloqueada ? "cheio" : dentro.nivel]);
    }
    b.dataset.nivel = c.nivel;
    b.dataset.velha = c.velha ? "1" : "0";
    b.dataset.atualizando = atualizando.has(c.id) ? "1" : "0";
    b.querySelector(".letra").textContent = c.bloqueada ? "!" : `${c.velha ? "~" : ""}${c.pct}`;
    b.querySelector(".nome").textContent = c.nome;
    b.title = `${c.nome} — ${c.bloqueada ? "bloqueada" : `${c.pct}% usado`} · clique pra atualizar`;
    ordem.push(b);
  });
  box.replaceChildren(...ordem);
}

function estadoGeral(linhas) {
  if (linhas.some((l) => l.estado === "esperando")) return "esperando";
  if (linhas.some((l) => l.estado === "trabalhando")) return "trabalhando";
  if (linhas.some((l) => l.estado === "terminou")) return "terminou";
  return "";
}

function cardAtividade(linhas) {
  const frag = document.createDocumentFragment();
  const h = document.createElement("h2");
  h.textContent = "Conversas";
  const n = linhas.filter((l) => l.estado !== "terminou").length;
  if (n) {
    const s = document.createElement("small");
    s.textContent = `${n} rodando`;
    h.append(s);
  }
  frag.append(h);
  if (!linhas.length) {
    const p = document.createElement("p");
    p.className = "vazio";
    p.textContent = ligado ? "Nada rodando agora." : "Motor desligado.";
    frag.append(p);
    return frag;
  }
  const rotulo = { esperando: "esperando você", trabalhando: "", terminou: "terminou" };
  for (const l of linhas) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "conversa";
    b.dataset.thread = l.threadId;
    b.dataset.projeto = l.projectPath;
    const ponto = document.createElement("span");
    ponto.className = "ponto";
    ponto.dataset.estado = l.estado;
    const nome = document.createElement("span");
    nome.className = "conversa-nome";
    nome.textContent = l.nome;
    const tempo = document.createElement("span");
    tempo.className = "conversa-tempo";
    tempo.textContent = l.estado === "trabalhando" && l.ms ? fmtDuracao(l.ms) : rotulo[l.estado];
    const proj = document.createElement("span");
    proj.className = "conversa-proj";
    proj.textContent = l.projeto;
    b.append(ponto, nome, tempo, proj);
    b.title = "Abrir no Nexos";
    frag.append(b);
  }
  return frag;
}

function cardConta(c) {
  const frag = document.createDocumentFragment();
  const h = document.createElement("h2");
  h.textContent = c.nome;
  if (c.engine) {
    const s = document.createElement("small");
    s.textContent = c.engine;
    h.append(s);
  }
  frag.append(h);
  if (c.bloqueada) {
    const p = document.createElement("p");
    p.className = "aviso";
    p.textContent = "Conta bloqueada ou sem login.";
    frag.append(p);
  }
  for (const j of c.janelas) {
    const d = document.createElement("div");
    d.className = "janela";
    d.dataset.velha = j.velha ? "1" : "0";
    d.style.setProperty("--cor", COR[j.nivel]);
    d.innerHTML = `<div class="janela-topo"><span class="janela-rotulo"></span><span class="janela-pct"></span></div><span class="janela-reset"></span><div class="barra"><i></i></div>`;
    d.querySelector(".janela-rotulo").textContent = `${j.rotulo} · ${j.duracao}`;
    d.querySelector(".janela-pct").textContent = `${j.velha ? "~" : ""}${j.pct}% usado`;
    d.querySelector(".janela-reset").textContent = j.reset;
    d.querySelector(".barra i").style.width = `${j.pct}%`;
    frag.append(d);
  }
  const dica = document.createElement("p");
  dica.className = "aviso rodape";
  dica.textContent = atualizando.has(c.id) ? "Atualizando…" : "Clique no anel pra atualizar agora.";
  frag.append(dica);
  return frag;
}

function cardMenu() {
  const frag = document.createDocumentFragment();
  const itens = [
    ["atualizar", "Atualizar uso das contas"],
    ["fixar", fixo ? "✓ Manter aberto" : "Manter aberto"],
    ["abrir", "Abrir o Nexos"],
    ["config", "Configurações do painel…"],
    ["esconder", "Esconder o painel"],
  ];
  for (const [acao, texto] of itens) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "item-menu";
    b.dataset.acao = acao;
    b.textContent = texto;
    frag.append(b);
  }
  return frag;
}

function pintar() {
  const agora = Date.now();
  // fundo translúcido: a cor é a do tema (styles de :root), a opacidade vem das Configurações
  const opac = Number(prefs.opacidade);
  document.documentElement.style.setProperty("--opac", `${Math.round((opac >= 0.3 && opac <= 1 ? opac : 1) * 100)}%`);
  const celulas = celulasDeConta(dados.contas, agora, prefs);
  const linhas = linhasDeAtividade(dados.agentes, terminadas, agora);
  body.dataset.borda = borda;
  body.dataset.aberto = aberto() ? "1" : "0";
  body.dataset.atividade = estadoGeral(linhas);
  body.dataset.ligado = ligado ? "1" : "0";
  el("off").classList.toggle("hidden", ligado);
  pintarContas(ligado ? celulas : []);

  const rodando = linhas.filter((l) => l.estado !== "terminou").length;
  const badge = el("badge-atividade");
  badge.classList.toggle("hidden", rodando < 2);
  badge.textContent = String(rodando);
  el("cel-atividade").title = rodando ? `${rodando} ${rodando === 1 ? "conversa rodando" : "conversas rodando"} · clique pra abrir o Nexos` : "Abrir o Nexos";

  // comprimento da pílula aberta = o que as células ocupam
  const cel = el("celulas");
  const comp = (vertical() ? cel.offsetHeight : cel.offsetWidth) || 120;
  body.style.setProperty("--comprimento", `${comp}px`);
  posicionarPilula(comp);

  for (const b of document.querySelectorAll(".celula")) b.dataset.ativa = b.dataset.alvo === alvo ? "1" : "0";
  pintarCard(celulas, linhas);
  reportarAreas();
}

/** A pílula fica no ponto da borda que a pessoa escolheu, sem sair da janela. */
function posicionarPilula(comp) {
  const tam = vertical() ? window.innerHeight : window.innerWidth;
  const meio = aberto() ? comp / 2 : 28;
  const c = Math.min(Math.max(centro, meio + 6), tam - meio - 6);
  body.style.setProperty("--centro", `${c}px`);
}

function pintarCard(celulas, linhas) {
  const card = el("card");
  const visivel = aberto() && alvo !== null;
  card.classList.toggle("hidden", !visivel);
  if (!visivel) return;
  const corpo = el("card-corpo");
  if (alvo === "atividade") corpo.replaceChildren(cardAtividade(linhas));
  else if (alvo === "menu") corpo.replaceChildren(cardMenu());
  else {
    const c = celulas.find((x) => `conta:${x.id}` === alvo);
    if (!c) {
      alvo = null;
      card.classList.add("hidden");
      return;
    }
    corpo.replaceChildren(cardConta(c));
  }
  posicionarCard();
}

/** Card do lado de dentro da pílula, alinhado com a célula (ou o meio da pílula, no menu). */
function posicionarCard() {
  const card = el("card");
  const pil = el("pilula").getBoundingClientRect();
  const ref = document.querySelector(`.celula[data-alvo="${CSS.escape(alvo ?? "")}"]`)?.getBoundingClientRect() ?? pil;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const GAP = 10;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), Math.max(a, b));
  let x;
  let y;
  if (vertical()) {
    // a pílula anima de largura: usa a largura final, não a do quadro atual
    const prof = el("celulas").offsetWidth + 12;
    x = borda === "direita" ? W - prof - GAP - cw : prof + GAP;
    y = clamp(ref.top + ref.height / 2 - ch / 2, 6, H - ch - 6);
    el("rabo").style.top = `${clamp(ref.top + ref.height / 2 - y - 5, 10, ch - 20)}px`;
    el("rabo").style.left = "";
  } else {
    const prof = el("celulas").offsetHeight + 12;
    y = borda === "topo" ? prof + GAP : H - prof - GAP - ch;
    x = clamp(ref.left + ref.width / 2 - cw / 2, 6, W - cw - 6);
    el("rabo").style.left = `${clamp(ref.left + ref.width / 2 - x - 5, 10, cw - 20)}px`;
    el("rabo").style.top = "";
  }
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
}

/* ---------------- áreas pro processo principal ---------------- */

let ultimasAreas = "";
function reportarAreas() {
  const ret = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const W = window.innerWidth;
  const H = window.innerHeight;
  const c = parseFloat(body.style.getPropertyValue("--centro")) || centro;
  const quentes = [];
  let despertar = null;
  if (aberto()) {
    // tamanho FINAL da pílula (a transição ainda pode estar no meio)
    const cel = el("celulas");
    const prof = (vertical() ? cel.offsetWidth : cel.offsetHeight) + 12;
    const comp = vertical() ? cel.offsetHeight + 12 : cel.offsetWidth + 12;
    const r =
      borda === "direita"
        ? { x: W - prof, y: c - comp / 2, w: prof, h: comp }
        : borda === "esquerda"
          ? { x: 0, y: c - comp / 2, w: prof, h: comp }
          : borda === "topo"
            ? { x: c - comp / 2, y: 0, w: comp, h: prof }
            : { x: c - comp / 2, y: H - prof, w: comp, h: prof };
    quentes.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])));
    if (!el("card").classList.contains("hidden")) quentes.push(ret(el("card").getBoundingClientRect()));
  } else {
    // tamanho FINAL do traço (a pílula ainda pode estar encolhendo): medir o DOM aqui pegava o
    // tamanho aberto, o cursor ainda perto caía "dentro" e o painel reabria sem fechar direito
    const css = getComputedStyle(document.documentElement);
    const esp = parseFloat(css.getPropertyValue("--traco-esp")) || 5;
    const tc = parseFloat(css.getPropertyValue("--traco-comp")) || 56;
    const r =
      borda === "direita"
        ? { x: W - esp, y: c - tc / 2, w: esp, h: tc }
        : borda === "esquerda"
          ? { x: 0, y: c - tc / 2, w: esp, h: tc }
          : borda === "topo"
            ? { x: c - tc / 2, y: 0, w: tc, h: esp }
            : { x: c - tc / 2, y: H - esp, w: tc, h: esp };
    quentes.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)])));
    const L = 100;
    despertar =
      borda === "direita"
        ? { x: W - DESPERTAR, y: c - L / 2, w: DESPERTAR, h: L }
        : borda === "esquerda"
          ? { x: 0, y: c - L / 2, w: DESPERTAR, h: L }
          : borda === "topo"
            ? { x: c - L / 2, y: 0, w: L, h: DESPERTAR }
            : { x: c - L / 2, y: H - DESPERTAR, w: L, h: DESPERTAR };
    despertar = Object.fromEntries(Object.entries(despertar).map(([k, v]) => [k, Math.round(v)]));
  }
  const json = JSON.stringify({ quentes, despertar });
  if (json === ultimasAreas) return;
  ultimasAreas = json;
  void window.nexo.painelAreas({ quentes, despertar });
}

/* ---------------- dados ---------------- */

function notar(transicao) {
  const { esperando } = transicao;
  const terminou = naoVistas(transicao.terminou, vistas);
  for (const a of terminou) {
    terminadas.set(a.threadId, {
      projectPath: a.projectPath ?? "",
      projeto: a.projectPath ? a.projectPath.replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "") : "sem projeto",
      nome: a.agentName || a.preview || a.profileId || "conversa",
    });
  }
  while (terminadas.size > MAX_TERMINADAS) terminadas.delete(terminadas.keys().next().value);
  if (!terminou.length && !esperando.length) return;
  if (esperando.length ? prefs.somAoPedir : prefs.somAoTerminar) tocar(esperando.length ? "pedir" : "fim");
  if (prefs.espiar > 0 && prefs.mostrar !== "desligado") {
    espiarAte = Date.now() + prefs.espiar * 1000;
    alvo = "atividade";
    setTimeout(pintar, prefs.espiar * 1000 + 50);
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
    dados = { contas: Array.isArray(contas) ? contas : [], agentes: Array.isArray(agentes) ? agentes : [] };
    if (agentesAntes) notar(transicoes(agentesAntes, dados.agentes));
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

/* ---------------- interação ---------------- */

window.nexo.onPainel("painel:hover", (dentro) => {
  hover = Boolean(dentro);
  clearTimeout(recolher);
  if (hover) return pintar();
  recolher = setTimeout(() => {
    if (!hover && !fixo) alvo = null;
    pintar();
  }, RECOLHER_MS);
});
window.nexo.onPainel("painel:lugar", (l) => {
  if (l?.borda) borda = l.borda;
  if (Number.isFinite(l?.centro)) centro = l.centro;
  pintar();
});
window.nexo.onPainel("painel:prefs", (p) => {
  if (p && typeof p === "object") prefs = { ...prefs, ...p };
  pintar();
});
window.nexo.onPainel("painel:vista", (threadId) => {
  const agora = Date.now();
  vistas.set(threadId, agora);
  for (const [id, em] of vistas) if (agora - em > VISTA_VALE_MS) vistas.delete(id);
  if (terminadas.delete(threadId)) pintar();
});

el("palco").addEventListener("mouseover", (e) => {
  const c = e.target.closest(".celula");
  if (c && alvo !== c.dataset.alvo && alvo !== "menu") {
    alvo = c.dataset.alvo;
    pintar();
  }
});

el("pilula").addEventListener("click", (e) => {
  if (arrastou) return;
  const conta = e.target.closest(".celula.conta");
  if (conta) return void atualizarConta(conta.dataset.conta);
  if (e.target.closest("#cel-atividade")) return void window.nexo.painelAbrir({});
  // clique no fundo da pílula não faz nada: antes ele fixava o painel aberto sem aviso nenhum, e
  // parecia que "não fechava". "Manter aberto" fica no menu (botão direito), com o ✓.
});

el("pilula").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  alvo = alvo === "menu" ? null : "menu";
  pintar();
});

el("card").addEventListener("click", (e) => {
  const conversa = e.target.closest(".conversa");
  if (conversa) {
    const threadId = conversa.dataset.thread;
    terminadas.delete(threadId);
    void window.nexo.painelAbrir({ threadId, projectPath: conversa.dataset.projeto });
    pintar();
    return;
  }
  const item = e.target.closest(".item-menu");
  if (!item) return;
  const acao = item.dataset.acao;
  alvo = null;
  if (acao === "atualizar") void atualizarTodas();
  else if (acao === "fixar") fixo = !fixo;
  else if (acao === "abrir") void window.nexo.painelAbrir({});
  else if (acao === "config") void window.nexo.painelConfig();
  else if (acao === "esconder") void window.nexo.setPainelPrefs({ mostrar: "desligado" });
  pintar();
});

/* arrastar: segura a pílula e solta perto de qualquer borda (de qualquer monitor) */
el("pilula").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const x0 = e.screenX;
  const y0 = e.screenY;
  let arrastando = false;
  arrastou = false;
  const pilula = el("pilula");
  pilula.setPointerCapture(e.pointerId);
  const mover = (ev) => {
    if (arrastando || Math.hypot(ev.screenX - x0, ev.screenY - y0) < 6) return;
    arrastando = true;
    arrastou = true;
    body.dataset.arrastando = "1";
    alvo = null;
    void window.nexo.painelArrastar(true);
  };
  const soltar = () => {
    pilula.removeEventListener("pointermove", mover);
    pilula.removeEventListener("pointerup", soltar);
    pilula.removeEventListener("pointercancel", soltar);
    if (!arrastando) return;
    delete body.dataset.arrastando;
    void window.nexo.painelArrastar(false);
    // o click que vem logo depois do pointerup não é um clique
    setTimeout(() => (arrastou = false), 0);
  };
  pilula.addEventListener("pointermove", mover);
  pilula.addEventListener("pointerup", soltar);
  pilula.addEventListener("pointercancel", soltar);
});

// a pílula anima; as áreas acompanham o fim da animação
el("pilula").addEventListener("transitionend", reportarAreas);
// relógio das conversas em voo e fim do "espiar"
setInterval(() => {
  if (aberto() && alvo === "atividade") pintar();
  else if (espiarAte && Date.now() >= espiarAte) {
    espiarAte = 0;
    // o espiar escolheu o card de atividade; acabou, e o mouse não está em cima: solta
    if (!hover && !fixo) alvo = null;
    pintar();
  }
}, 1000);

async function iniciar() {
  try {
    const p = await window.nexo.painelPrefs();
    if (p) prefs = { ...prefs, ...p };
  } catch {
    // sem preferências: fica no padrão
  }
  pintar();
  await atualizar();
}

void iniciar();
