/**
 * Tela de Planejamento: roteiro à esquerda, canvas (uma coluna por etapa, cards, linhas e setas)
 * e editor de card à direita; o chat do Agent Manager fica no chat lateral do Nexos.
 * Fala com `/v1/planejamento*` (`apps/daemon/src/planejamento.ts`); ao vivo pelo SSE
 * `/v1/planejamento/events`. Plano: docs/superpowers/plans/2026-09-24-planejamento.md.
 *
 * O plano aberto é o da CONVERSA ativa (`thread_meta.planejamento.slug`): a conversa do Manager
 * é a tela. Toda escrita leva o `rev` lido; 409 devolve a versão atual e a tela refaz em cima
 * (status de etapa reaplica uma vez; card junta campo a campo o que a pessoa mudou).
 *
 * Mesmo idioma de `tarefas-board.js`/`canvas-ds.js`: dependências por parâmetro, DOM por
 * `createElement`/`textContent` (texto de modelo nunca em `innerHTML`; o corpo passa por
 * `renderMd`, que escapa antes de formatar).
 */

import { criarAnimador } from "./canvas-anim.js";
import { ajustarATela, zoomEm } from "./canvas-ds.js";
import { renderMd } from "./markdown.js";
import {
  CARD_H,
  CARD_W,
  HEADER_H,
  SEM_ETAPA,
  calcularLayout,
  caminhoDaAresta,
  diffPlano,
  normalizarTitulo,
  proximoStatus,
} from "./planejamento-layout.js";

export const TIPOS = [
  { id: "requisito", rotulo: "Requisito", ico: "☰" },
  { id: "decisao", rotulo: "Decisão", ico: "✓" },
  { id: "sugestao", rotulo: "Sugestão", ico: "✧" },
  { id: "ambiguidade", rotulo: "Ambiguidade", ico: "?" },
  { id: "nota", rotulo: "Nota", ico: "✎" },
  { id: "etapa", rotulo: "Etapa", ico: "⚑" },
];
const ROTULO_TIPO = Object.fromEntries(TIPOS.map((t) => [t.id, t]));
export const ROTULO_STATUS = { pendente: "Pendente", em_andamento: "Em andamento", concluida: "Concluída" };
const LS_ROTEIRO_W = "nexo.pl.roteiroW";
const LS_ANIM = "nexo.pl.animacao";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Texto corrido do corpo pra prévia do card: sem marcação, `[[x]]` vira `x`. */
export function previaDoCorpo(corpo, max = 160) {
  const t = String(corpo || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Host da fonte pra mostrar no card (`hono.dev`), ou o próprio caminho do arquivo. */
export function rotuloDaFonte(fonte) {
  if (!fonte) return "";
  try {
    if (/^https?:\/\//i.test(fonte)) return new URL(fonte).hostname.replace(/^www\./, "");
  } catch {
    /* cai no texto */
  }
  return fonte.length > 28 ? `…${fonte.slice(-27)}` : fonte;
}

/** Campos que a pessoa mudou no editor, comparados com o card de quando ela abriu. */
export function camposMudados(original, rascunho) {
  const out = {};
  for (const k of ["titulo", "tipo", "etapa", "fonte", "status", "corpo"]) {
    const a = original?.[k] ?? "";
    const b = rascunho?.[k] ?? "";
    if (a !== b) out[k] = b;
  }
  return out;
}

/** Sugestões do autocomplete `[[`: cards cujo título contém o que foi digitado (sem acento/caixa). */
export function sugestoesDeRef(cards, termo, excluir, max = 8) {
  const t = normalizarTitulo(termo);
  return cards
    .filter((c) => c.id !== excluir && (!t || normalizarTitulo(c.titulo).includes(t)))
    .slice(0, max);
}

/** Resumo do progresso: concluídas / total. */
export function progresso(etapas) {
  const total = etapas.length;
  const feitas = etapas.filter((e) => e.status === "concluida").length;
  return { total, feitas, pct: total ? Math.round((feitas / total) * 100) : 0 };
}

export function createPlanejamentoBoard({
  req,
  api,
  headers,
  el,
  getProjectPath,
  getSlug,
  isOk = () => true,
  lerEventos,
  confirmar = async () => true,
  avisar = () => {},
  aoNovoPlano = () => {},
  aoAbrirPlano = () => {},
  aoAbrirExterno = () => {},
  getProfileId = () => "",
  /** Manda o pedido fixo na conversa do Manager (a conversa ativa, que é a desta tela). */
  aoPedirAoManager = () => {},
  aoAbrirConversa = () => {},
  fetchImpl = (...a) => globalThis.fetch(...a),
  win = globalThis.window ?? globalThis,
  doc = globalThis.document,
}) {
  /** @type {any} */
  let plano = null;
  let slug = "";
  let projeto = "";
  let vista = { x: 32, y: 24, escala: 1 };
  let vistaDoUsuario = false;
  let layout = null;
  let selecionado = null; // { tipo: "card"|"aresta", id }
  let editando = null; // { original, id }
  let arrasto = null;
  let ligando = null;
  let pan = null;
  let sse = null;
  let recarregarTimer = null;
  let layoutTimer = null;
  let carregando = false;
  let animador = null;
  /** Diálogo de envio: passo atual e, esperando o Manager, os handoffs que já existiam. */
  let envio = null;
  /** O que esta janela acabou de gravar (`card:<id>:<rev>`, `roteiro:<rev>`): o eco não anima. */
  const proprios = new Set();

  const qs = () => `projectPath=${encodeURIComponent(projeto)}`;
  const rota = (sub = "") => `/v1/planejamento/${encodeURIComponent(slug)}${sub}?${qs()}`;
  const mk = (tag, cls, texto) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (texto !== undefined) n.textContent = texto;
    return n;
  };

  /* ---------- carregar ---------- */

  async function abrir() {
    const novoSlug = getSlug() || "";
    const novoProjeto = getProjectPath() || "";
    const trocou = novoSlug !== slug || novoProjeto !== projeto;
    slug = novoSlug;
    projeto = novoProjeto;
    if (trocou) {
      plano = null;
      vistaDoUsuario = false;
      fecharEditor({ salvar: false });
    }
    void pintarListaDePlanos();
    if (!slug || !projeto) {
      pintarSemPlano();
      pararSse();
      return;
    }
    await recarregar();
    ouvir();
  }

  async function recarregar({ animar = false } = {}) {
    if (!slug || carregando) return;
    carregando = true;
    const anterior = plano?.slug === slug ? plano : null;
    try {
      plano = await req(rota());
      el("pl-erro").classList.add("hidden");
    } catch (e) {
      plano = null;
      el("pl-erro").textContent = `Não abriu o plano: ${e.message}`;
      el("pl-erro").classList.remove("hidden");
    } finally {
      carregando = false;
    }
    pintar();
    if (animar && anterior && plano) animarDiferenca(diffPlano(anterior, plano, proprios));
    proprios.clear();
  }

  async function pintarListaDePlanos() {
    const sel = el("pl-planos");
    if (!sel) return;
    sel.replaceChildren();
    if (!projeto || !isOk()) return;
    let planos = [];
    try {
      planos = await req(`/v1/planejamento?${qs()}`);
    } catch {
      return;
    }
    for (const p of planos) {
      const o = mk("option", "", `${p.titulo} (${p.concluidas}/${p.etapas})`);
      o.value = p.slug;
      o.selected = p.slug === slug;
      sel.append(o);
    }
    const novo = mk("option", "", "+ Novo planejamento");
    novo.value = "__novo";
    sel.append(novo);
    if (!slug) sel.value = "";
  }

  /* ---------- SSE ---------- */

  function pararSse() {
    sse?.abort();
    sse = null;
  }

  function ouvir() {
    if (sse && sse.projeto === projeto) return;
    pararSse();
    if (!projeto || !isOk() || !lerEventos) return;
    const ac = new AbortController();
    ac.projeto = projeto;
    sse = ac;
    const meu = projeto;
    fetchImpl(api(`/v1/planejamento/events?projectPath=${encodeURIComponent(meu)}`), { headers: headers(), signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) return;
        await lerEventos(res, aoEvento);
        religar();
      })
      .catch(() => religar());
    function religar() {
      if (sse !== ac || projeto !== meu) return;
      sse = null;
      setTimeout(() => {
        if (!sse && projeto === meu && slug) ouvir();
      }, 1500);
    }
  }

  /** Um evento do SSE do projeto (`/v1/planejamento/events`). */
  function aoEvento(ev) {
    if (ev?.type !== "mudou") return;
    if (ev.alvo === "plano") void pintarListaDePlanos();
    if (ev.alvo === "handoff" && ev.slug === slug) void handoffChegou();
    if (ev.slug !== slug || ev.alvo === "layout" || ev.alvo === "handoff") return;
    clearTimeout(recarregarTimer);
    recarregarTimer = setTimeout(() => void recarregar({ animar: true }), 120);
  }

  /* ---------- pintar ---------- */

  function pintarSemPlano() {
    el("btn-pl-enviar").disabled = true;
    el("pl-vazio-conversa").classList.remove("hidden");
    el("pl-corpo").classList.add("hidden");
    el("pl-titulo").value = "";
    el("pl-selo").textContent = "";
  }

  function pintar() {
    el("pl-vazio-conversa").classList.add("hidden");
    el("pl-corpo").classList.remove("hidden");
    if (!plano) return;
    const r = plano.roteiro;
    if (doc.activeElement !== el("pl-titulo")) el("pl-titulo").value = r.titulo;
    const pg = progresso(r.etapas);
    el("pl-selo").textContent = pg.total ? `${pg.feitas} de ${pg.total} etapas` : "";
    el("pl-faixa-vazia").classList.toggle("hidden", r.etapas.length > 0 || plano.cards.length > 0);
    const inval = plano.invalidos ?? [];
    el("pl-invalidos").classList.toggle("hidden", !inval.length);
    el("pl-invalidos").textContent = inval.length
      ? `${inval.length} arquivo(s) de card ilegível(is) ignorado(s): ${inval.map((i) => i.arquivo).join(", ")}`
      : "";
    el("btn-pl-enviar").disabled = false;
    pintarRoteiro();
    pintarCanvas();
    if (editando) {
      const atual = plano.cards.find((c) => c.id === editando.id);
      if (!atual) fecharEditor({ salvar: false });
      else pintarEtapasDoEditor();
    }
  }

  function pintarRoteiro() {
    const etapas = plano.roteiro.etapas;
    const pg = progresso(etapas);
    el("pl-roteiro-cont").textContent = `${pg.feitas}/${pg.total}`;
    el("pl-progresso-barra").style.width = `${pg.pct}%`;
    const lista = el("pl-etapas");
    lista.replaceChildren();
    if (!etapas.length) {
      lista.append(mk("li", "pl-etapas-vazio", "Nenhuma etapa ainda. Converse com o Manager pra separar o trabalho em etapas — cada uma vira uma coluna no canvas."));
      return;
    }
    etapas.forEach((e, i) => {
      const li = mk("li", "pl-etapa");
      li.dataset.status = e.status;
      const marca = mk("button", "pl-etapa-marca");
      marca.type = "button";
      marca.title = `${ROTULO_STATUS[e.status]} — clique pra mudar`;
      marca.setAttribute("aria-label", `${e.titulo}: ${ROTULO_STATUS[e.status]}. Mudar status`);
      marca.addEventListener("click", () => void mudarStatus(e.id));
      const num = mk("span", "pl-etapa-num", String(i + 1));
      const nome = mk("button", "pl-etapa-nome", e.titulo);
      nome.type = "button";
      nome.title = "Centralizar a coluna no canvas";
      nome.addEventListener("click", () => centralizarColuna(e.id));
      li.append(num, marca, nome);
      lista.append(li);
    });
  }

  function retanguloDoNo(id) {
    const col = layout.colunas.find((c) => c.id === id);
    if (col) return { x: col.x, y: 0, w: CARD_W, h: HEADER_H };
    const p = layout.posicoes[id];
    return p ? { x: p.x, y: p.y, w: CARD_W, h: layout.alturas?.[id] || CARD_H } : null;
  }

  function pintarCanvas() {
    // duas passadas: pinta os cards pra medir a altura real de cada um, e só então empilha e
    // traça as setas (senão sobra buraco entre cards curtos e a seta não entra no meio do card)
    layout = calcularLayout(plano);
    const nos = el("pl-nos");
    nos.replaceChildren();
    for (const col of layout.colunas) nos.append(noDaColuna(col));
    const nosDeCard = plano.cards.map((card) => noDoCard(card));
    nos.append(...nosDeCard);
    const alturas = {};
    for (const n of nosDeCard) alturas[n.dataset.id] = n.offsetHeight;
    layout = calcularLayout(plano, alturas);
    for (const n of nosDeCard) {
      const p = layout.posicoes[n.dataset.id];
      n.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    pintarArestas();
    const board = el("pl-board");
    board.style.width = `${layout.largura + 64}px`;
    board.style.height = `${layout.altura + 64}px`;
    if (!vistaDoUsuario) {
      if (plano.layout?.vista) {
        vista = { ...plano.layout.vista };
        vistaDoUsuario = true;
      } else enquadrar();
    }
    aplicarVista();
  }

  function noDaColuna(col) {
    const n = mk("div", "pl-coluna");
    n.dataset.id = col.id;
    if (col.status) n.dataset.status = col.status;
    n.style.transform = `translate(${col.x}px, 0px)`;
    const cab = mk("div", "pl-coluna-cab");
    if (col.id !== SEM_ETAPA) cab.append(mk("span", "pl-coluna-num", String(col.indice + 1).padStart(2, "0")));
    const txt = mk("div", "pl-coluna-txt");
    txt.append(mk("strong", "pl-coluna-titulo", col.titulo));
    const sub = mk("span", "pl-coluna-sub");
    if (col.status) sub.append(mk("span", "pl-coluna-status", ROTULO_STATUS[col.status]));
    sub.append(mk("span", "pl-coluna-qtd", `${col.cardIds.length} ${col.cardIds.length === 1 ? "card" : "cards"}`));
    txt.append(sub);
    cab.append(txt);
    n.append(cab);
    n.title = "Duplo clique cria um card nesta etapa";
    n.addEventListener("dblclick", () => void criarCard(col.id === SEM_ETAPA ? undefined : col.id));
    return n;
  }

  function noDoCard(card) {
    const p = layout.posicoes[card.id];
    const n = mk("div", "pl-card");
    n.dataset.id = card.id;
    n.dataset.tipo = card.tipo;
    n.tabIndex = 0;
    n.style.transform = `translate(${p.x}px, ${p.y}px)`;
    if (selecionado?.tipo === "card" && selecionado.id === card.id) n.classList.add("selecionado");
    const topo = mk("div", "pl-card-topo");
    const t = ROTULO_TIPO[card.tipo] ?? ROTULO_TIPO.nota;
    topo.append(mk("span", "pl-card-ico", t.ico), mk("span", "pl-card-tipo", t.rotulo));
    if (card.tipo === "ambiguidade") {
      const selo = mk("span", "pl-card-selo", card.status === "resolvida" ? "resolvida" : "aberta");
      selo.dataset.status = card.status || "aberta";
      topo.append(selo);
    } else if (card.fonte) {
      const f = mk("button", "pl-card-fonte", `${rotuloDaFonte(card.fonte)} ↗`);
      f.type = "button";
      f.title = card.fonte;
      f.addEventListener("click", (e) => {
        e.stopPropagation();
        aoAbrirExterno(card.fonte);
      });
      topo.append(f);
    }
    n.append(topo, mk("div", "pl-card-titulo", card.titulo));
    const prev = previaDoCorpo(card.corpo);
    if (prev) n.append(mk("div", "pl-card-prev", prev));
    const alca = mk("span", "pl-alca");
    alca.title = "Arraste até outro card pra ligar";
    alca.addEventListener("mousedown", (e) => comecarLigacao(e, card.id));
    n.append(alca);
    n.addEventListener("mousedown", (e) => comecarArrastoDoCard(e, card.id));
    n.addEventListener("click", () => selecionar({ tipo: "card", id: card.id }));
    n.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      abrirEditor(card.id);
    });
    n.addEventListener("mouseenter", () => focarArestas(card.id));
    n.addEventListener("mouseleave", () => focarArestas(null));
    return n;
  }

  function pintarArestas() {
    const svg = el("pl-arestas");
    svg.setAttribute("width", String(layout.largura + 64));
    svg.setAttribute("height", String(layout.altura + 64));
    for (const n of [...svg.querySelectorAll(".pl-aresta, .pl-aresta-alvo")]) n.remove();
    for (const a of layout.arestas) {
      const ra = retanguloDoNo(a.de);
      const rb = retanguloDoNo(a.para);
      if (!ra || !rb) continue;
      const d = caminhoDaAresta(ra, rb);
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", `pl-aresta pl-aresta-${a.tipo}`);
      path.setAttribute("marker-end", `url(#pl-seta-${a.tipo})`);
      path.dataset.id = a.id;
      path.dataset.de = a.de;
      path.dataset.para = a.para;
      if (selecionado?.tipo === "aresta" && selecionado.id === a.id) path.classList.add("selecionada");
      // alvo invisível mais largo: clicar numa linha de 1.4px é impossível
      const alvo = doc.createElementNS(SVG_NS, "path");
      alvo.setAttribute("d", d);
      alvo.setAttribute("class", "pl-aresta-alvo");
      alvo.dataset.id = a.id;
      if (a.tipo !== "sequencia") {
        const titulo = doc.createElementNS(SVG_NS, "title");
        titulo.textContent =
          a.tipo === "referencia" ? "Referência [[…]] no texto do card — some editando o texto" : "Ligação — clique e Delete pra apagar";
        alvo.append(titulo);
        alvo.addEventListener("click", (e) => {
          e.stopPropagation();
          selecionar({ tipo: "aresta", id: a.id });
        });
      }
      svg.append(path, alvo);
    }
  }

  /** Hover no card: destaca as linhas dele e esmaece as outras. */
  function focarArestas(id) {
    const svg = el("pl-arestas");
    svg.classList.toggle("foco", !!id);
    for (const p of svg.querySelectorAll(".pl-aresta")) {
      p.classList.toggle("ativa", !!id && (p.dataset.de === id || p.dataset.para === id));
    }
  }

  function selecionar(sel) {
    selecionado = sel;
    for (const n of el("pl-nos").querySelectorAll(".pl-card")) n.classList.toggle("selecionado", sel?.tipo === "card" && n.dataset.id === sel.id);
    for (const p of el("pl-arestas").querySelectorAll(".pl-aresta")) p.classList.toggle("selecionada", sel?.tipo === "aresta" && p.dataset.id === sel.id);
  }

  /* ---------- animação (F5b): o que veio de fora se desenha ---------- */

  function animacaoLigada() {
    try {
      return win.localStorage?.getItem(LS_ANIM) !== "0";
    } catch {
      return true;
    }
  }

  function pintarBotaoAnimacao() {
    el("btn-pl-anim")?.setAttribute("aria-pressed", animacaoLigada() ? "true" : "false");
  }

  /** Ordem: etapa nova (coluna + seta de sequência), card novo, ligação nova, card alterado, status. */
  function animarDiferenca(d) {
    if (!animador || !layout) return;
    const nos = el("pl-nos");
    const arestas = el("pl-arestas");
    const noDe = (sel) => nos.querySelector(sel);
    const itens = [];
    for (const id of d.etapasNovas) itens.push({ tipo: "entrar", alvo: noDe(`.pl-coluna[data-id="${id}"]`), rect: retanguloDoNo(id) });
    for (const id of d.cardsNovos) itens.push({ tipo: "entrar", alvo: noDe(`.pl-card[data-id="${id}"]`), rect: retanguloDoNo(id) });
    for (const aid of d.arestasNovas) {
      const a = layout.arestas.find((x) => x.id === aid);
      const r = a && retanguloDoNo(a.para);
      if (!r) continue;
      itens.push({ tipo: "linha", alvo: arestas.querySelector(`.pl-aresta[data-id="${aid}"]`), ponta: { x: r.x, y: r.y + r.h / 2 } });
    }
    for (const id of d.cardsAlterados) itens.push({ tipo: "pulso", alvo: noDe(`.pl-card[data-id="${id}"]`), rect: retanguloDoNo(id) });
    for (const id of d.statusMudou) {
      itens.push({ tipo: "pulso", alvo: noDe(`.pl-coluna[data-id="${id}"]`), rect: retanguloDoNo(id) });
      const i = plano.roteiro.etapas.findIndex((e) => e.id === id);
      const li = el("pl-etapas").children[i];
      if (li) {
        li.classList.remove("pulso");
        void li.offsetWidth;
        li.classList.add("pulso");
      }
    }
    animador.enfileirar(itens);
  }

  /* ---------- vista (pan/zoom) ---------- */

  function aplicarVista() {
    el("pl-board").style.transform = `translate(${vista.x}px, ${vista.y}px) scale(${vista.escala})`;
    el("pl-zoom-val").textContent = `${Math.round(vista.escala * 100)}%`;
    el("pl-arestas").style.setProperty("--pl-escala", String(vista.escala));
  }

  /** Cabe tudo; se o texto ficaria pequeno demais, foca a etapa em andamento. */
  function enquadrar() {
    const vp = el("pl-viewport");
    if (!layout || !vp.clientWidth) return;
    vista = ajustarATela(layout.largura, layout.altura, vp.clientWidth, vp.clientHeight);
    if (vista.escala < 0.7) {
      // não cabe legível: 85% a partir do começo, a menos que a etapa em andamento fique fora da
      // tela — aí ela vira a segunda coluna visível (a anterior dá o contexto)
      const escala = 0.85;
      const alvo = plano?.roteiro.etapas.find((e) => e.status === "em_andamento");
      const col = alvo && layout.colunas.find((c) => c.id === alvo.id);
      const cabe = !col || 32 + (col.x + CARD_W) * escala <= vp.clientWidth;
      const inicio = cabe ? 0 : Math.max(0, col.x - (CARD_W + 72));
      vista = { escala, x: 32 - inicio * escala, y: 24 };
    }
    aplicarVista();
  }

  function centralizarColuna(id) {
    const col = layout?.colunas.find((c) => c.id === id);
    if (!col) return;
    const vp = el("pl-viewport");
    vista = { ...vista, x: vp.clientWidth / 2 - (col.x + CARD_W / 2) * vista.escala, y: 24 };
    vistaDoUsuario = true;
    aplicarVista();
    salvarLayoutDepois();
  }

  function zoomBotao(fator) {
    const vp = el("pl-viewport");
    vista = zoomEm(vista, vp.clientWidth / 2, vp.clientHeight / 2, fator, 0.3, 2);
    vistaDoUsuario = true;
    aplicarVista();
    salvarLayoutDepois();
  }

  function paraOBoard(clientX, clientY) {
    const r = el("pl-viewport").getBoundingClientRect();
    return { x: (clientX - r.left - vista.x) / vista.escala, y: (clientY - r.top - vista.y) / vista.escala };
  }

  function aoRodar(e) {
    e.preventDefault();
    const r = el("pl-viewport").getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) vista = zoomEm(vista, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015), 0.3, 2);
    else vista = { ...vista, x: vista.x - e.deltaX, y: vista.y - e.deltaY };
    vistaDoUsuario = true;
    aplicarVista();
    salvarLayoutDepois();
  }

  /** Pan/zoom e posições: só visual, última escrita vence, com debounce. */
  function salvarLayoutDepois() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      if (!plano || !slug) return;
      const posicoes = { ...(plano.layout?.posicoes ?? {}) };
      plano.layout = { posicoes, vista: { ...vista } };
      void req(rota("/layout"), { method: "PUT", body: JSON.stringify(plano.layout) }).catch(() => {});
    }, 400);
  }

  /* ---------- arrastar card ---------- */

  function comecarArrastoDoCard(e, id) {
    if (e.button !== 0 || e.target.closest(".pl-alca, .pl-card-fonte")) return;
    e.stopPropagation();
    const p = layout.posicoes[id];
    arrasto = { id, x0: e.clientX, y0: e.clientY, px: p.x, py: p.y, moveu: false };
  }

  function moverCard(e) {
    const dx = (e.clientX - arrasto.x0) / vista.escala;
    const dy = (e.clientY - arrasto.y0) / vista.escala;
    if (!arrasto.moveu && Math.hypot(dx, dy) < 3) return;
    arrasto.moveu = true;
    const pos = { x: Math.round(arrasto.px + dx), y: Math.round(arrasto.py + dy) };
    layout.posicoes[arrasto.id] = pos;
    const n = el("pl-nos").querySelector(`.pl-card[data-id="${arrasto.id}"]`);
    if (n) n.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    pintarArestas();
  }

  function soltarCard() {
    const { id, moveu } = arrasto;
    arrasto = null;
    if (!moveu || !plano) return;
    plano.layout = { ...(plano.layout ?? {}), posicoes: { ...(plano.layout?.posicoes ?? {}), [id]: layout.posicoes[id] } };
    salvarLayoutDepois();
  }

  /* ---------- ligar cards ---------- */

  function comecarLigacao(e, id) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const fantasma = doc.createElementNS(SVG_NS, "path");
    fantasma.setAttribute("class", "pl-aresta pl-aresta-fantasma");
    el("pl-arestas").append(fantasma);
    ligando = { de: id, fantasma };
  }

  function moverLigacao(e) {
    const r = retanguloDoNo(ligando.de);
    const p = paraOBoard(e.clientX, e.clientY);
    ligando.fantasma.setAttribute("d", caminhoDaAresta(r, { x: p.x, y: p.y, w: 1, h: 1 }));
  }

  async function soltarLigacao(e) {
    const { de, fantasma } = ligando;
    ligando = null;
    fantasma.remove();
    const alvo = doc.elementFromPoint?.(e.clientX, e.clientY)?.closest?.(".pl-card");
    const para = alvo?.dataset.id;
    if (!para || para === de) return;
    const origem = plano.cards.find((c) => c.id === de);
    if (!origem || origem.links.includes(para)) return;
    await salvarCampos(de, { links: [...origem.links, para] });
  }

  /* ---------- escrita ---------- */

  async function mudarStatus(etapaId, tentativa = 0) {
    const etapa = plano?.roteiro.etapas.find((e) => e.id === etapaId);
    if (!etapa) return;
    try {
      plano.roteiro = await req(rota(`/etapas/${encodeURIComponent(etapaId)}`), {
        method: "PUT",
        body: JSON.stringify({ status: proximoStatus(etapa.status), expectedRev: plano.roteiro.rev }),
      });
      proprios.add(`roteiro:${plano.roteiro.rev}`);
      pintar();
    } catch (e) {
      if (e.status === 409 && e.data?.atual && tentativa === 0) {
        plano.roteiro = e.data.atual;
        return mudarStatus(etapaId, 1);
      }
      avisar(`Não mudou a etapa: ${e.message}`);
      void recarregar();
    }
  }

  async function renomear() {
    const titulo = el("pl-titulo").value.trim();
    if (!plano || !titulo || titulo === plano.roteiro.titulo) return;
    try {
      plano.roteiro = await req(rota("/roteiro"), { method: "PUT", body: JSON.stringify({ titulo, expectedRev: plano.roteiro.rev }) });
      proprios.add(`roteiro:${plano.roteiro.rev}`);
      void pintarListaDePlanos();
    } catch (e) {
      if (e.status === 409 && e.data?.atual) {
        plano.roteiro = e.data.atual;
        return renomear();
      }
      avisar(`Não renomeou: ${e.message}`);
      el("pl-titulo").value = plano.roteiro.titulo;
    }
  }

  async function criarCard(etapa) {
    if (!plano) return;
    try {
      const card = await req(rota("/cards"), {
        method: "POST",
        body: JSON.stringify({ tipo: "nota", titulo: "Novo card", ...(etapa ? { etapa } : {}) }),
      });
      proprios.add(`card:${card.id}:${card.rev}`);
      plano.cards.push(card);
      pintar();
      abrirEditor(card.id);
      el("pl-ed-titulo").select();
    } catch (e) {
      avisar(`Não criou o card: ${e.message}`);
    }
  }

  /** Grava campos de um card; em conflito, reaplica os mesmos campos sobre a versão atual (1×). */
  async function salvarCampos(id, campos, tentativa = 0) {
    const atual = plano?.cards.find((c) => c.id === id);
    if (!atual) return null;
    try {
      const salvo = await req(rota(`/cards/${encodeURIComponent(id)}`), {
        method: "PUT",
        body: JSON.stringify({ ...campos, expectedRev: atual.rev }),
      });
      proprios.add(`card:${salvo.id}:${salvo.rev}`);
      plano.cards = plano.cards.map((c) => (c.id === id ? salvo : c));
      pintar();
      return salvo;
    } catch (e) {
      if (e.status === 409 && e.data?.atual && tentativa === 0) {
        plano.cards = plano.cards.map((c) => (c.id === id ? e.data.atual : c));
        avisar("O card mudou enquanto você editava — juntei suas mudanças na versão atual.");
        return salvarCampos(id, campos, 1);
      }
      avisar(`Não salvou o card: ${e.message}`);
      void recarregar();
      return null;
    }
  }

  async function apagarSelecionado() {
    if (!selecionado || !plano) return;
    if (selecionado.tipo === "card") {
      const card = plano.cards.find((c) => c.id === selecionado.id);
      if (!card || !(await confirmar(`Apagar o card "${card.titulo}"?`))) return;
      // quem apontava pro card apagado ganha rev novo no daemon (link limpo): isso não é "de fora"
      for (const c of plano.cards) if (c.links.includes(card.id)) proprios.add(`card:${c.id}:${c.rev + 1}`);
      try {
        await req(`${rota(`/cards/${encodeURIComponent(card.id)}`)}&rev=${card.rev}`, { method: "DELETE" });
        if (editando?.id === card.id) fecharEditor({ salvar: false });
        selecionado = null;
        await recarregar();
      } catch (e) {
        avisar(`Não apagou: ${e.message}`);
        void recarregar();
      }
      return;
    }
    const aresta = layout?.arestas.find((a) => a.id === selecionado.id);
    if (!aresta) return;
    if (aresta.tipo === "referencia") {
      avisar("Essa seta vem de uma referência [[…]] no texto do card — edite o texto pra tirar.");
      return;
    }
    if (aresta.tipo !== "ligacao") return;
    const origem = plano.cards.find((c) => c.id === aresta.de);
    if (!origem) return;
    selecionado = null;
    await salvarCampos(origem.id, { links: origem.links.filter((l) => l !== aresta.para) });
  }

  /* ---------- editor de card ---------- */

  const chaveRascunho = (id) => `nexo.pl.rascunho:${projeto}:${slug}:${id}`;

  function lerForm() {
    const tipo = el("pl-ed-tipos").dataset.tipo;
    return {
      titulo: el("pl-ed-titulo").value,
      tipo,
      etapa: el("pl-ed-etapa").value,
      fonte: el("pl-ed-fonte").value.trim(),
      status: tipo === "ambiguidade" ? el("pl-ed-situacao").dataset.status || "aberta" : undefined,
      corpo: el("pl-ed-corpo").value,
    };
  }

  function pintarTipoNoForm(tipo) {
    el("pl-ed-tipos").dataset.tipo = tipo;
    for (const b of el("pl-ed-tipos").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.tipo === tipo ? "true" : "false");
    el("pl-ed-fonte-campo").classList.toggle("hidden", tipo !== "sugestao");
    el("pl-ed-situacao-campo").classList.toggle("hidden", tipo !== "ambiguidade");
    el("pl-editor").dataset.tipo = tipo;
  }

  function pintarSituacao(status) {
    el("pl-ed-situacao").dataset.status = status;
    for (const b of el("pl-ed-situacao").querySelectorAll("button")) b.setAttribute("aria-pressed", b.dataset.status === status ? "true" : "false");
  }

  function pintarEtapasDoEditor() {
    const sel = el("pl-ed-etapa");
    const valor = sel.value;
    sel.replaceChildren();
    const sem = mk("option", "", "Sem etapa");
    sem.value = "";
    sel.append(sem);
    for (const e of plano?.roteiro.etapas ?? []) {
      const o = mk("option", "", e.titulo);
      o.value = e.id;
      sel.append(o);
    }
    sel.value = valor;
  }

  function abrirEditor(id) {
    const card = plano?.cards.find((c) => c.id === id);
    if (!card) return;
    // grava o card anterior: a parte síncrona de salvarEditor lê o formulário antes de trocá-lo
    if (editando && editando.id !== id) void salvarEditor();
    editando = { id, original: { ...card } };
    selecionar({ tipo: "card", id });
    el("pl-editor").classList.remove("hidden");
    el("pl-ed-id").textContent = card.id;
    pintarEtapasDoEditor();
    let base = card;
    try {
      const r = JSON.parse(win.localStorage?.getItem(chaveRascunho(id)) || "null");
      if (r && r.rev === card.rev) base = { ...card, ...r.campos };
    } catch {
      /* sem rascunho */
    }
    el("pl-ed-titulo").value = base.titulo;
    el("pl-ed-etapa").value = base.etapa && plano.roteiro.etapas.some((e) => e.id === base.etapa) ? base.etapa : "";
    el("pl-ed-fonte").value = base.fonte || "";
    el("pl-ed-corpo").value = base.corpo || "";
    pintarTipoNoForm(base.tipo);
    pintarSituacao(base.status || "aberta");
    mostrarAbaDoCorpo("escrever");
  }

  function guardarRascunho() {
    if (!editando) return;
    const card = plano?.cards.find((c) => c.id === editando.id);
    if (!card) return;
    try {
      win.localStorage?.setItem(chaveRascunho(editando.id), JSON.stringify({ rev: card.rev, campos: camposMudados(editando.original, lerForm()) }));
    } catch {
      /* armazenamento indisponível: só não guarda */
    }
  }

  async function salvarEditor() {
    if (!editando) return;
    const { id, original } = editando;
    const campos = camposMudados(original, lerForm());
    if (!Object.keys(campos).length) return;
    if (campos.titulo !== undefined && !campos.titulo.trim()) return avisar("O card precisa de título.");
    const salvo = await salvarCampos(id, campos);
    if (salvo) {
      if (editando?.id === id) editando.original = { ...salvo };
      try {
        win.localStorage?.removeItem(chaveRascunho(id));
      } catch {
        /* ok */
      }
    }
  }

  async function fecharEditor({ salvar = true } = {}) {
    if (salvar) await salvarEditor();
    editando = null;
    el("pl-editor")?.classList.add("hidden");
    el("pl-ed-sugestoes")?.classList.add("hidden");
  }

  function mostrarAbaDoCorpo(qual) {
    const escrever = qual === "escrever";
    el("pl-ed-aba-escrever").setAttribute("aria-pressed", escrever ? "true" : "false");
    el("pl-ed-aba-previa").setAttribute("aria-pressed", escrever ? "false" : "true");
    el("pl-ed-corpo").classList.toggle("hidden", !escrever);
    el("pl-ed-previa").classList.toggle("hidden", escrever);
    if (!escrever) renderMd(el("pl-ed-previa"), el("pl-ed-corpo").value || "_Sem conteúdo._");
  }

  /** Autocomplete `[[`: sugere cards pelo título enquanto a pessoa digita a referência. */
  function atualizarSugestoes() {
    const ta = el("pl-ed-corpo");
    const lista = el("pl-ed-sugestoes");
    const antes = ta.value.slice(0, ta.selectionStart);
    const m = /\[\[([^\]\n]*)$/.exec(antes);
    if (!m || !plano) {
      lista.classList.add("hidden");
      return;
    }
    const opcoes = sugestoesDeRef(plano.cards, m[1], editando?.id);
    lista.replaceChildren();
    if (!opcoes.length) {
      lista.classList.add("hidden");
      return;
    }
    for (const c of opcoes) {
      const b = mk("button", "pl-ed-sugestao");
      b.type = "button";
      b.dataset.tipo = c.tipo;
      b.append(mk("span", "pl-card-ico", (ROTULO_TIPO[c.tipo] ?? ROTULO_TIPO.nota).ico), mk("span", "", c.titulo));
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const inicio = antes.length - m[0].length;
        const depois = ta.value.slice(ta.selectionStart).replace(/^[^\]\n]*\]\]/, "");
        ta.value = `${ta.value.slice(0, inicio)}[[${c.titulo}]]${depois}`;
        const pos = inicio + c.titulo.length + 4;
        ta.setSelectionRange(pos, pos);
        lista.classList.add("hidden");
        guardarRascunho();
      });
      lista.append(b);
    }
    lista.classList.remove("hidden");
  }

  /* ---------- enviar para implementação (F6) ---------- */

  function mostrarPasso(passo) {
    envio.passo = passo;
    for (const li of el("pl-envio-passos").children) {
      const ordem = ["conferir", "gerar", "revisar"];
      li.dataset.estado = li.dataset.passo === passo ? "atual" : ordem.indexOf(li.dataset.passo) < ordem.indexOf(passo) ? "feito" : "";
    }
    el("pl-envio-conferir").classList.toggle("hidden", passo !== "conferir");
    el("pl-envio-gerando").classList.toggle("hidden", passo !== "gerar");
    el("pl-envio-revisar").classList.toggle("hidden", passo !== "revisar");
    el("btn-pl-envio-rascunho").classList.toggle("hidden", passo !== "conferir");
    el("btn-pl-envio-manager").classList.toggle("hidden", passo !== "conferir");
    el("btn-pl-envio-enviar").classList.toggle("hidden", passo !== "revisar");
    el("btn-pl-envio-voltar").classList.toggle("hidden", passo === "conferir");
    atualizarBotoesDoEnvio();
  }

  function atualizarBotoesDoEnvio() {
    if (!envio) return;
    const travado = envio.bloqueios > 0 && !el("pl-envio-mesmo-assim").checked;
    el("btn-pl-envio-rascunho").disabled = travado;
    el("btn-pl-envio-manager").disabled = travado;
  }

  function pintarLista(id, itens) {
    const ul = el(id);
    ul.replaceChildren(...itens.map((i) => mk("li", "", i.texto)));
  }

  async function abrirEnvio() {
    if (!plano) return;
    let r;
    try {
      r = await req(rota("/handoff/rascunho"));
    } catch (e) {
      avisar(`Não deu pra conferir o plano: ${e.message}`);
      return;
    }
    envio = { passo: "conferir", rascunho: r.texto, pedido: r.pedido, bloqueios: r.prontidao.bloqueios.length, antes: null };
    el("pl-envio-plano").textContent = `Planejamento · ${plano.roteiro.titulo}`;
    pintarLista("pl-envio-bloqueios-lista", r.prontidao.bloqueios);
    pintarLista("pl-envio-avisos-lista", r.prontidao.avisos);
    el("pl-envio-bloqueios").classList.toggle("hidden", !r.prontidao.bloqueios.length);
    el("pl-envio-avisos").classList.toggle("hidden", !r.prontidao.avisos.length);
    el("pl-envio-tudo-certo").classList.toggle("hidden", !!(r.prontidao.bloqueios.length || r.prontidao.avisos.length));
    el("pl-envio-mesmo-assim").checked = false;
    el("pl-envio-prompt").value = "";
    el("pl-envio").classList.remove("hidden");
    mostrarPasso("conferir");
  }

  function fecharEnvio() {
    envio = null;
    el("pl-envio").classList.add("hidden");
  }

  function irParaRevisao(texto) {
    const ta = el("pl-envio-prompt");
    ta.value = texto;
    mostrarPasso("revisar");
    // lê de cima: o começo (objetivo, etapas) é o que a pessoa confere primeiro
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }

  async function pedirAoManager() {
    if (!envio) return;
    try {
      envio.antes = new Set((await req(rota("/handoff"))).map((h) => h.nome));
    } catch {
      envio.antes = new Set();
    }
    mostrarPasso("gerar");
    aoPedirAoManager(envio.pedido);
  }

  /** Arquivo novo em handoff/ enquanto esperava o Manager: é o prompt dele. */
  async function handoffChegou() {
    if (envio?.passo !== "gerar" || !envio.antes) return;
    let lista = [];
    try {
      lista = await req(rota("/handoff"));
    } catch {
      return;
    }
    const novo = lista.filter((h) => !envio.antes.has(h.nome)).at(-1);
    if (novo) irParaRevisao(novo.texto.trimEnd());
  }

  async function enviarParaImplementacao() {
    const texto = el("pl-envio-prompt").value.trim();
    if (!texto) return avisar("O prompt está vazio.");
    const profileId = getProfileId();
    if (!profileId) return avisar("Nenhuma conta pronta pra abrir a conversa de implementação.");
    el("btn-pl-envio-enviar").disabled = true;
    try {
      const r = await req(rota("/handoff/enviar"), { method: "POST", body: JSON.stringify({ texto, profileId }) });
      fecharEnvio();
      aoAbrirConversa(r.threadId);
    } catch (e) {
      avisar(`Não enviou: ${e.message}`);
    } finally {
      el("btn-pl-envio-enviar").disabled = false;
    }
  }

  /* ---------- eventos ---------- */

  function ligar() {
    animador = criarAnimador({ doc, camada: el("pl-traco"), cursor: el("pl-cursor"), escala: () => vista.escala, ligada: animacaoLigada });
    pintarBotaoAnimacao();
    el("btn-pl-anim")?.addEventListener("click", () => {
      try {
        win.localStorage?.setItem(LS_ANIM, animacaoLigada() ? "0" : "1");
      } catch {
        /* sem storage: fica como está */
      }
      pintarBotaoAnimacao();
    });
    el("pl-titulo").addEventListener("change", () => void renomear());
    el("pl-titulo").addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.target.blur();
    });
    el("pl-planos").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "__novo") {
        e.target.value = slug;
        aoNovoPlano(projeto);
      } else if (v && v !== slug) aoAbrirPlano(projeto, v);
    });
    el("btn-pl-novo-vazio")?.addEventListener("click", () => aoNovoPlano(projeto));
    el("btn-pl-card").addEventListener("click", () => void criarCard());
    el("btn-pl-enviar").addEventListener("click", () => void abrirEnvio());
    el("btn-pl-envio-cancelar").addEventListener("click", fecharEnvio);
    el("btn-pl-envio-voltar").addEventListener("click", () => mostrarPasso("conferir"));
    el("btn-pl-envio-rascunho").addEventListener("click", () => envio && irParaRevisao(envio.rascunho.trimEnd()));
    el("btn-pl-envio-manager").addEventListener("click", () => void pedirAoManager());
    el("btn-pl-envio-enviar").addEventListener("click", () => void enviarParaImplementacao());
    el("pl-envio-mesmo-assim").addEventListener("change", atualizarBotoesDoEnvio);
    el("btn-pl-card-vazio")?.addEventListener("click", () => void criarCard());
    el("pl-zoom-mais").addEventListener("click", () => zoomBotao(1.2));
    el("pl-zoom-menos").addEventListener("click", () => zoomBotao(1 / 1.2));
    el("pl-zoom-ajustar").addEventListener("click", () => {
      vistaDoUsuario = true;
      enquadrar();
      salvarLayoutDepois();
    });
    el("btn-pl-roteiro-recolher").addEventListener("click", () => {
      const r = el("pl-roteiro");
      r.classList.toggle("recolhido");
      el("btn-pl-roteiro-recolher").setAttribute("aria-expanded", r.classList.contains("recolhido") ? "false" : "true");
    });
    try {
      const w = Number(win.localStorage?.getItem(LS_ROTEIRO_W));
      if (w >= 180) el("pl-roteiro").style.setProperty("--pl-roteiro-w", `${w}px`);
    } catch {
      /* sem preferência salva */
    }
    el("pl-roteiro-alca").addEventListener("mousedown", (e) => {
      e.preventDefault();
      const r = el("pl-roteiro");
      const x0 = e.clientX;
      const w0 = r.getBoundingClientRect().width;
      const max = Math.max(220, (r.parentElement?.getBoundingClientRect().width || 1000) * 0.4);
      const mover = (ev) => r.style.setProperty("--pl-roteiro-w", `${Math.min(max, Math.max(180, w0 + ev.clientX - x0))}px`);
      const parar = () => {
        doc.removeEventListener("mousemove", mover);
        doc.removeEventListener("mouseup", parar);
        try {
          win.localStorage?.setItem(LS_ROTEIRO_W, String(Math.round(r.getBoundingClientRect().width)));
        } catch {
          /* ok */
        }
      };
      doc.addEventListener("mousemove", mover);
      doc.addEventListener("mouseup", parar);
    });

    const vp = el("pl-viewport");
    vp.addEventListener("wheel", aoRodar, { passive: false });
    vp.addEventListener("mousedown", (e) => {
      if (e.target.closest(".pl-card, .pl-coluna, .pl-aresta-alvo")) return;
      if (e.button !== 0 && e.button !== 1) return;
      selecionar(null);
      pan = { x0: e.clientX, y0: e.clientY, vx: vista.x, vy: vista.y };
      vp.classList.add("arrastando");
    });
    doc.addEventListener("mousemove", (e) => {
      if (arrasto) moverCard(e);
      else if (ligando) moverLigacao(e);
      else if (pan) {
        vista = { ...vista, x: pan.vx + e.clientX - pan.x0, y: pan.vy + e.clientY - pan.y0 };
        aplicarVista();
      }
    });
    doc.addEventListener("mouseup", (e) => {
      if (arrasto) soltarCard();
      else if (ligando) void soltarLigacao(e);
      else if (pan) {
        pan = null;
        vp.classList.remove("arrastando");
        vistaDoUsuario = true;
        salvarLayoutDepois();
      }
    });
    el("pane-planejamento").addEventListener("keydown", (e) => {
      const alvo = e.target;
      if (alvo.closest?.("input, textarea, select, [contenteditable]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selecionado) {
        e.preventDefault();
        void apagarSelecionado();
      }
      if (e.key === "Enter" && selecionado?.tipo === "card") abrirEditor(selecionado.id);
      if (e.key === "Escape") {
        if (envio) fecharEnvio();
        else if (editando) void fecharEditor();
        else selecionar(null);
      }
    });

    // editor
    for (const t of TIPOS) {
      const b = mk("button", "pl-ed-tipo");
      b.type = "button";
      b.dataset.tipo = t.id;
      b.append(mk("span", "pl-card-ico", t.ico), mk("span", "", t.rotulo));
      b.addEventListener("click", () => {
        pintarTipoNoForm(t.id);
        guardarRascunho();
      });
      el("pl-ed-tipos").append(b);
    }
    for (const b of el("pl-ed-situacao").querySelectorAll("button")) {
      b.addEventListener("click", () => {
        pintarSituacao(b.dataset.status);
        guardarRascunho();
      });
    }
    for (const id of ["pl-ed-titulo", "pl-ed-fonte", "pl-ed-corpo"]) el(id).addEventListener("input", guardarRascunho);
    el("pl-ed-etapa").addEventListener("change", () => {
      guardarRascunho();
      void salvarEditor();
    });
    // grava sozinho ao sair do campo (sem botão salvar), igual ao original
    el("pl-editor").addEventListener("focusout", (e) => {
      if (e.relatedTarget && el("pl-editor").contains(e.relatedTarget)) return;
      void salvarEditor();
    });
    el("pl-ed-corpo").addEventListener("input", atualizarSugestoes);
    el("pl-ed-corpo").addEventListener("blur", () => el("pl-ed-sugestoes").classList.add("hidden"));
    el("pl-ed-aba-escrever").addEventListener("click", () => mostrarAbaDoCorpo("escrever"));
    el("pl-ed-aba-previa").addEventListener("click", () => mostrarAbaDoCorpo("previa"));
    el("btn-pl-ed-fechar").addEventListener("click", () => void fecharEditor());
    el("btn-pl-ed-x").addEventListener("click", () => void fecharEditor());
    el("btn-pl-ed-apagar").addEventListener("click", () => {
      if (!editando) return;
      selecionado = { tipo: "card", id: editando.id };
      void apagarSelecionado();
    });
  }

  return {
    ligar,
    abrir,
    recarregar,
    fechar: () => {
      pararSse();
      void fecharEditor();
    },
    /** Só pra teste. */
    _aoEvento: aoEvento,
    _estado: () => ({ plano, vista, layout, selecionado, editando }),
  };
}
