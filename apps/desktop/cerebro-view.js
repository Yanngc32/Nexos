/**
 * Aba "Cérebro": o que o agente sabe usar neste projeto (ferramentas, skills, agentes, times,
 * memória, docs, MCP externos), quanto usa de fato, e os gatilhos que lembram ele disso.
 *
 * Dois modos na mesma aba: Painel (`cerebro-painel.js`: KPIs, testar gatilhos, tabela com edição na
 * linha, sugestões, linha do tempo) e Mapa (este arquivo: grafo radial em SVG — layout puro em
 * `cerebro-mapa.js` —, zoom/arrasto, tooltip, legenda por tipo, painel lateral de edição e pulsos ao
 * vivo). Com `prefers-reduced-motion` nada pulsa: só o número muda. Escopo: um projeto ou "Global"
 * (chat geral), no seletor do cabeçalho.
 *
 * Desempenho: a aba oculta não tem stream nem timer (`dados.pausar`); zoom e arrasto mexem só no
 * `transform` do grupo, sem refazer o layout.
 */
import { aplicarEvento } from "./cerebro-dados.js";
import { criarCerebroPainel } from "./cerebro-painel.js";
import { aplicarRoda, arrastar, descricaoDoNo, kpisDoMapa, layoutDoMapa, TIPOS, vistaInicial } from "./cerebro-mapa.js";

const SVG = "http://www.w3.org/2000/svg";
const SEM_MOVIMENTO = "(prefers-reduced-motion: reduce)";
export const PULSO_MS = 300;
export const ARESTA_VIVA_MS = 600;
const RELAYOUT_MS = 1_000;
const DESCRICAO_MAX = 120;
const COMO_USAR_MAX = 240;

const ICO_CEREBRO = '<path d="M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8 4 4 0 0 0 .5 6.6A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8 4 4 0 0 1-.5 6.6A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>';
const ICO_X = '<path d="M18 6 6 18M6 6l12 12"/>';
const ICO_CENTRO = '<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>';
const ICO_OK = '<path d="M20 6 9 17l-5-5"/>';
const ICO_ALERTA = '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>';
const svgIco = (paths, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export function createCerebroView({
  el,
  dados,
  getProjetoAtual = () => "",
  getProjetos = () => [],
  aoAbrirConversa = () => {},
  armazenamento = globalThis.localStorage,
  doc = globalThis.document,
  win = globalThis.window ?? globalThis,
  relogio = () => Date.now(),
  agendar = (f, ms) => setTimeout(f, ms),
  cancelar = (t) => clearTimeout(t),
}) {
  const st = {
    path: "",
    itens: [],
    kpis: null,
    carregando: false,
    erro: "",
    ocultos: new Set(),
    expandidos: new Set(),
    vista: vistaInicial(),
    layout: null,
    aberto: null, // id da capacidade no painel lateral
    rascunho: null,
    salvando: false,
    toast: null,
    timerToast: null,
    timerRelayout: null,
    precisaRelayout: false,
    gen: 0,
    modo: lerModo(),
    escolha: null, // projeto escolhido no seletor ("" = Global); null = segue o projeto aberto
    seguindo: "", // projeto aberto quando a escolha foi feita
    carregadoEm: 0,
  };

  function lerModo() {
    try {
      return armazenamento?.getItem?.("nexos.cerebro.modo") === "mapa" ? "mapa" : "painel";
    } catch {
      return "painel";
    }
  }
  let visivel = false;
  const painel = criarCerebroPainel({
    doc,
    dados,
    getPath: () => st.path,
    getItens: () => st.itens,
    getCarregadoEm: () => st.carregadoEm,
    aoVerNoMapa: (id) => verNoMapa(id),
    aoAbrirConversa,
    aoRecarregar: () => void carregar(),
    mostrarToast: (t, o) => mostrarToast(t, o),
    relogio,
    agendar,
    cancelar,
    armazenamento,
  });
  const reduzido = () => Boolean(win.matchMedia?.(SEM_MOVIMENTO)?.matches);

  const mk = (tag, cls, texto) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (texto !== undefined) n.textContent = texto;
    return n;
  };
  const sv = (tag, attrs = {}) => {
    const n = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const corpo = () => el("cb-corpo");
  const nomeDoProjeto = (p) => (p ? p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "Chat geral");

  /* ------------------------------------------------------------------ */
  /*  dados                                                              */
  /* ------------------------------------------------------------------ */

  /** Escopo da aba: o escolhido no seletor, senão o projeto aberto. Trocar de projeto solta a escolha. */
  function escopo() {
    const atual = getProjetoAtual() || "";
    if (st.escolha !== null && st.seguindo !== atual) st.escolha = null;
    return st.escolha ?? atual;
  }

  async function carregar() {
    const path = escopo();
    if (path !== st.path) {
      Object.assign(st, { path, itens: [], kpis: null, erro: "", aberto: null, rascunho: null, vista: vistaInicial(), layout: null });
      st.ocultos.clear();
      st.expandidos.clear();
      painel.reset();
    }
    const minha = ++st.gen;
    st.carregando = !st.itens.length;
    st.erro = "";
    desenhar();
    try {
      const r = await dados.catalogo(path);
      if (minha !== st.gen) return;
      st.itens = r.itens;
      st.kpis = r.kpis ?? kpisDoMapa(r.itens);
      st.carregadoEm = relogio();
    } catch (e) {
      if (minha !== st.gen) return;
      st.erro = e?.message || "erro desconhecido";
    }
    st.carregando = false;
    st.layout = null;
    desenhar();
  }

  function aoEvento(ev) {
    if (!visivel) return;
    const c = aplicarEvento(st.itens, ev);
    if (!c) {
      // capacidade fora do catálogo (ToolSearch etc.): o painel ainda mostra o disparo
      if (st.modo === "painel" && ev?.tipo === "disparo") painel.aoEvento(ev, null);
      return;
    }
    st.kpis = kpisDoMapa(st.itens);
    if (st.modo === "painel") {
      painel.aoEvento(ev, c);
      return;
    }
    pintarKpis();
    const no = corpo()?.querySelector(`[data-no="${CSS.escape(c.id)}"]`);
    if (no) {
      no.setAttribute("aria-label", descricaoDoNo(noDe(c.id)));
      if (!reduzido()) {
        if (ev.tipo === "disparo") pulsar(no, "cb-pulsa", PULSO_MS);
        if (ev.tipo === "uso") {
          const aresta = corpo()?.querySelector(`[data-aresta="${CSS.escape(c.id)}"]`);
          if (aresta) pulsar(aresta, "cb-viva", ARESTA_VIVA_MS);
        }
      }
    }
    // raio muda com o uso: refaz o layout com calma (muitos usos seguidos = um redesenho)
    st.precisaRelayout = true;
    if (!st.timerRelayout) {
      st.timerRelayout = agendar(() => {
        st.timerRelayout = null;
        if (st.precisaRelayout && visivel) {
          st.precisaRelayout = false;
          st.layout = null;
          desenharMapa();
        }
      }, RELAYOUT_MS);
    }
  }

  function pulsar(no, cls, ms) {
    no.classList.remove(cls);
    // força reinício da animação quando o mesmo nó pulsa duas vezes seguidas
    void no.getBoundingClientRect?.();
    no.classList.add(cls);
    agendar(() => no.classList.remove(cls), ms);
  }

  const noDe = (id) => st.layout?.nos.find((n) => n.id === id) ?? { item: st.itens.find((c) => c.id === id) ?? {}, nunca: false, off: false, gatilho: false };

  /* ------------------------------------------------------------------ */
  /*  desenho                                                            */
  /* ------------------------------------------------------------------ */

  function pintarCabecalho() {
    const sel = el("cb-escopo");
    if (sel) {
      const atual = getProjetoAtual() || "";
      const projetos = [...new Set([...(getProjetos() ?? []).filter(Boolean), ...(atual ? [atual] : []), ...(st.path ? [st.path] : [])])];
      sel.replaceChildren();
      for (const p of projetos) {
        const o = doc.createElement("option");
        o.value = p;
        o.textContent = `${nomeDoProjeto(p)}${p === atual ? " (aberto)" : ""}`;
        sel.append(o);
      }
      const g = doc.createElement("option");
      g.value = "";
      g.textContent = "Global (chat geral)";
      sel.append(g);
      sel.value = st.path;
      sel.title = st.path || "Global: capacidades do chat sem projeto";
    }
    for (const [id, modo] of [["cb-modo-painel", "painel"], ["cb-modo-mapa", "mapa"]]) {
      const b = el(id);
      if (!b) continue;
      b.dataset.on = st.modo === modo ? "1" : "0";
      b.setAttribute("aria-selected", st.modo === modo ? "true" : "false");
    }
  }

  function trocarModo(modo, depois) {
    if (st.modo === modo && !depois) return;
    st.modo = modo;
    try {
      armazenamento?.setItem?.("nexos.cerebro.modo", modo);
    } catch {
      /* sem armazenamento: só nesta sessão */
    }
    st.aberto = null;
    st.rascunho = null;
    st.layout = null;
    esconderTip();
    desenhar();
    depois?.();
  }

  /** "ver no mapa" do painel: abre o mapa com o tipo visível e o nó em foco. */
  function verNoMapa(id) {
    const c = st.itens.find((x) => x.id === id);
    if (!c) return;
    st.ocultos.delete(c.tipo);
    st.expandidos.add(c.tipo);
    trocarModo("mapa", () => {
      const no = corpo()?.querySelector(`[data-no="${CSS.escape(id)}"]`);
      if (!no) return;
      no.classList.add("cb-destaque");
      no.focus?.();
      agendar(() => no.classList.remove("cb-destaque"), 2400);
    });
  }

  function desenhar() {
    const raiz = corpo();
    if (!raiz) return;
    pintarCabecalho();
    raiz.replaceChildren();
    raiz.classList.remove("cb-painel-modo");
    if (st.erro && !st.itens.length) {
      raiz.append(blocoErro());
      return;
    }
    if (st.carregando) {
      raiz.append(esqueleto());
      return;
    }
    if (!st.itens.length) {
      raiz.append(vazio());
      return;
    }
    if (st.erro) raiz.append(blocoErro(true));
    if (st.modo === "painel") {
      painel.desenhar(raiz);
      raiz.append(toastEl());
      return;
    }
    raiz.append(kpis(), area(), rodape(), toastEl());
    pintarKpis();
    desenharMapa();
    if (st.aberto) abrirPainel(st.aberto, true);
  }

  function blocoErro(aviso = false) {
    const box = mk("div", `cb-alerta ${aviso ? "warn" : "danger"}`);
    box.setAttribute("role", "alert");
    box.innerHTML = svgIco(ICO_ALERTA);
    box.append(mk("span", "cb-alerta-txt", aviso ? `Não deu pra atualizar o catálogo: ${st.erro}. Mostrando o último conhecido.` : `Não consegui ler o Cérebro: ${st.erro}`));
    const b = mk("button", "ghost", "Tentar de novo");
    b.type = "button";
    b.addEventListener("click", () => void carregar());
    box.append(b);
    return box;
  }

  function esqueleto() {
    const s = mk("div", "cb-esqueleto");
    s.setAttribute("aria-busy", "true");
    s.setAttribute("aria-label", "carregando o catálogo");
    for (const w of ["30%", "60%", "45%", "80%"]) {
      const i = mk("i");
      i.style.width = w;
      s.append(i);
    }
    return s;
  }

  function vazio() {
    const v = mk("div", "cb-vazio");
    v.append(mk("h3", "", "Nada pra mapear ainda"), mk("p", "", st.path ? "Abra uma conversa neste projeto pra o Cérebro montar o catálogo." : "Abra um projeto: o mapa é por projeto."));
    return v;
  }

  function kpis() {
    const g = mk("section", "cb-kpis");
    g.setAttribute("aria-label", "Indicadores");
    for (const id of ["total", "usadas", "gatilhos", "nunca"]) {
      const t = mk("div", `cb-kp${id === "nunca" ? " alerta" : ""}`);
      t.dataset.kp = id;
      t.append(mk("span", "cb-kp-rot"), mk("span", "cb-kp-num"), mk("span", "cb-kp-rod"));
      g.append(t);
    }
    return g;
  }

  function pintarKpis() {
    const k = st.kpis ?? kpisDoMapa(st.itens);
    const pct = k.disparos30d ? Math.round((k.usosAposDisparo30d / k.disparos30d) * 100) : 0;
    const dados_ = {
      total: ["Capacidades", String(k.total), `${k.auto} auto · ${k.pessoa} suas`],
      usadas: ["Usadas em 7 dias", `${k.usadas7d}`, `de ${k.total}`],
      gatilhos: ["Gatilhos · 30 d", `${k.disparos30d}`, k.disparos30d ? `→ ${k.usosAposDisparo30d} usos (${pct}%)` : "nenhum disparo ainda"],
      nunca: ["Nunca usadas", `${k.nuncaUsadas}`, "tracejadas no mapa"],
    };
    for (const [id, [rot, num, rod]] of Object.entries(dados_)) {
      const t = corpo()?.querySelector(`[data-kp="${id}"]`);
      if (!t) continue;
      t.querySelector(".cb-kp-rot").innerHTML = (id === "nunca" ? svgIco(ICO_ALERTA) : "") + rot;
      t.querySelector(".cb-kp-num").textContent = num;
      t.querySelector(".cb-kp-rod").textContent = rod;
    }
  }

  function area() {
    const a = mk("div", "cb-area");
    a.append(legenda(), palco());
    return a;
  }

  function legenda() {
    const l = mk("aside", "cb-legenda");
    l.setAttribute("aria-label", "Legenda por tipo");
    l.append(mk("p", "cb-rot", "Tipos"));
    for (const t of TIPOS) {
      const n = st.itens.filter((c) => c.tipo === t.tipo).length;
      const b = mk("button", "cb-leg-item");
      b.type = "button";
      b.dataset.tipo = t.tipo;
      b.setAttribute("aria-pressed", st.ocultos.has(t.tipo) ? "false" : "true");
      b.innerHTML = `<i class="cb-cor" data-tipo="${t.tipo}"></i><span>${t.rotulo}</span><span class="cb-n">${n}</span>`;
      b.addEventListener("click", () => {
        if (st.ocultos.has(t.tipo)) st.ocultos.delete(t.tipo);
        else st.ocultos.add(t.tipo);
        b.setAttribute("aria-pressed", st.ocultos.has(t.tipo) ? "false" : "true");
        st.layout = null;
        desenharMapa();
      });
      l.append(b);
    }
    l.append(mk("p", "cb-ajuda", "Clique num tipo pra esconder/mostrar. Clique num nó pra editar. Scroll = zoom, arrastar = mover."));
    return l;
  }

  function palco() {
    const p = mk("div", "cb-palco");
    p.id = "cb-palco";
    const zoom = mk("span", "cb-zoom");
    zoom.id = "cb-zoom";
    const centro = mk("button", "ghost cb-centrar");
    centro.type = "button";
    centro.id = "btn-cb-centrar";
    centro.innerHTML = `${svgIco(ICO_CENTRO)}centralizar`;
    centro.addEventListener("click", () => {
      st.vista = vistaInicial();
      aplicarVista();
    });
    const svg = sv("svg", { class: "cb-mapa", role: "group", "aria-label": "Mapa de capacidades" });
    svg.id = "cb-svg";
    const tip = mk("div", "cb-tip hidden");
    tip.id = "cb-tip";
    tip.setAttribute("role", "tooltip");
    p.append(zoom, centro, svg, tip);
    // zoom e arrasto
    p.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = p.getBoundingClientRect();
      st.vista = aplicarRoda(st.vista, e.deltaY, e.clientX - r.left, e.clientY - r.top);
      aplicarVista();
    }, { passive: false });
    let arrasto = null;
    p.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("[data-no],[data-hub],button")) return;
      arrasto = { x: e.clientX, y: e.clientY };
      p.classList.add("arrastando");
    });
    p.addEventListener("pointermove", (e) => {
      if (!arrasto) return;
      st.vista = arrastar(st.vista, e.clientX - arrasto.x, e.clientY - arrasto.y);
      arrasto = { x: e.clientX, y: e.clientY };
      aplicarVista();
    });
    const soltar = () => {
      arrasto = null;
      p.classList.remove("arrastando");
    };
    p.addEventListener("pointerup", soltar);
    p.addEventListener("pointerleave", soltar);
    return p;
  }

  function aplicarVista() {
    const g = el("cb-svg")?.querySelector("g.cb-vista");
    if (g) g.setAttribute("transform", `translate(${st.vista.dx} ${st.vista.dy}) scale(${st.vista.escala})`);
    const z = el("cb-zoom");
    if (z) z.textContent = `zoom ${st.vista.escala.toFixed(1).replace(".", ",")}×`;
  }

  function tamanhoDoPalco() {
    const p = el("cb-palco");
    const w = p?.clientWidth || 1000;
    const h = p?.clientHeight || 520;
    return { largura: Math.max(600, w), altura: Math.max(380, h) };
  }

  function desenharMapa() {
    const svg = el("cb-svg");
    if (!svg) return;
    const tam = tamanhoDoPalco();
    if (!st.layout) st.layout = layoutDoMapa(st.itens, { ...tam, ocultos: st.ocultos, expandidos: st.expandidos });
    const L = st.layout;
    svg.setAttribute("viewBox", `0 0 ${tam.largura} ${tam.altura}`);
    svg.replaceChildren();
    const g = sv("g", { class: "cb-vista" });
    svg.append(g);

    const gArestas = sv("g", { class: "cb-arestas" });
    for (const a of L.arestas) {
      const l = sv("line", { x1: a.de.x, y1: a.de.y, x2: a.para.x, y2: a.para.y, class: `cb-ar ${a.tipo === "cita" ? "cita" : ""}` });
      if (a.tipo === "hub") l.dataset.aresta = a.id;
      gArestas.append(l);
    }
    g.append(gArestas);

    // centro
    const centro = sv("g", { class: "cb-centro", transform: `translate(${L.centro.x} ${L.centro.y})` });
    centro.append(sv("circle", { r: L.centro.r, class: "cb-centro-c" }));
    const ico = sv("g", { transform: "translate(-12 -14)", class: "cb-ico" });
    ico.innerHTML = ICO_CEREBRO;
    centro.append(ico);
    const nomeC = sv("text", { y: L.centro.r + 16, "text-anchor": "middle", class: "cb-txt xxs" });
    nomeC.textContent = nomeDoProjeto(st.path);
    centro.append(nomeC);
    g.append(centro);

    // hubs
    for (const h of L.hubs) {
      const gh = sv("g", { class: `cb-hub${h.oculto ? " oculto" : ""}`, transform: `translate(${h.x} ${h.y})`, role: "button", tabindex: 0, "aria-label": `${h.rotulo}: ${h.n}${h.oculto ? " (oculto)" : ""}` });
      gh.dataset.hub = h.tipo;
      if (h.tipo === "mcp-externo" && !h.n) {
        gh.append(sv("circle", { r: h.r, class: "cb-hub-c mais" }));
        const plus = sv("path", { d: "M0 -6v12M-6 0h12", class: "cb-ico-traco" });
        gh.append(plus);
        const t = sv("text", { y: h.r + 14, "text-anchor": "middle", class: "cb-txt xxs" });
        t.textContent = "MCP externos · + adicionar";
        gh.append(t);
      } else {
        gh.append(sv("circle", { r: h.r, class: "cb-hub-c" }));
        const n = sv("text", { y: 4, "text-anchor": "middle", class: "cb-txt xs" });
        n.textContent = String(h.n);
        gh.append(n);
        const t = sv("text", { y: h.r + 14, "text-anchor": "middle", class: "cb-txt xxs" });
        t.textContent = h.rotulo;
        gh.append(t);
      }
      gh.addEventListener("click", () => {
        if (st.ocultos.has(h.tipo)) st.ocultos.delete(h.tipo);
        else if (h.n) st.ocultos.add(h.tipo);
        st.layout = null;
        const b = corpo()?.querySelector(`.cb-leg-item[data-tipo="${h.tipo}"]`);
        b?.setAttribute("aria-pressed", st.ocultos.has(h.tipo) ? "false" : "true");
        desenharMapa();
      });
      gh.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          gh.click();
        }
      });
      g.append(gh);
    }

    // capacidades
    for (const no of L.nos) {
      const gn = sv("g", { class: `cb-no${no.off ? " off" : ""}`, transform: `translate(${no.x} ${no.y})`, role: "button", tabindex: 0, "aria-label": descricaoDoNo(no) });
      gn.dataset.no = no.id;
      gn.dataset.tipo = no.tipo;
      if (no.gatilho) gn.append(sv("circle", { r: no.r + 4, class: "cb-anel" }));
      gn.append(sv("circle", { r: no.r, class: `cb-cap${no.nunca ? " nunca" : ""}` }));
      if (no.r >= 14 || no.tipo === "agente") {
        const t = sv("text", { y: no.r + 12, "text-anchor": "middle", class: "cb-txt xxs" });
        t.textContent = no.nome.length > 22 ? `${no.nome.slice(0, 21)}…` : no.nome;
        gn.append(t);
      }
      gn.addEventListener("click", () => abrirPainel(no.id));
      gn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          abrirPainel(no.id);
        }
      });
      gn.addEventListener("pointerenter", (e) => mostrarTip(no, e));
      gn.addEventListener("pointermove", (e) => mostrarTip(no, e));
      gn.addEventListener("pointerleave", esconderTip);
      gn.addEventListener("focus", (e) => mostrarTip(no, e));
      gn.addEventListener("blur", esconderTip);
      g.append(gn);
    }

    // colapsados "+N"
    for (const c of L.colapsados) {
      const gc = sv("g", { class: "cb-colap", transform: `translate(${c.x} ${c.y})`, role: "button", tabindex: 0, "aria-label": `+${c.n} ${TIPOS.find((t) => t.tipo === c.tipo)?.rotulo ?? c.tipo} nunca usadas — clique pra expandir` });
      gc.append(sv("circle", { r: c.r, class: "cb-cap nunca colap" }));
      const t = sv("text", { y: 4, "text-anchor": "middle", class: "cb-txt xxs" });
      t.textContent = `+${c.n}`;
      gc.append(t);
      const t2 = sv("text", { y: c.r + 12, "text-anchor": "middle", class: "cb-txt xxs" });
      t2.textContent = "nunca usadas";
      gc.append(t2);
      const expandir = () => {
        st.expandidos.add(c.tipo);
        st.layout = null;
        desenharMapa();
      };
      gc.addEventListener("click", expandir);
      gc.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          expandir();
        }
      });
      g.append(gc);
    }
    aplicarVista();
  }

  function mostrarTip(no, e) {
    const tip = el("cb-tip");
    const p = el("cb-palco");
    if (!tip || !p) return;
    const c = no.item;
    tip.replaceChildren();
    tip.append(mk("b", "", c.nome));
    tip.append(mk("span", "cb-tip-m", `${c.tipo} · ${no.nunca ? "nunca usada" : `${c.usos7d ?? 0} usos em 7 d · ${c.usos30d ?? 0} em 30 d`}${no.off ? " · desligada" : ""}`));
    if (c.disparos30d) tip.append(mk("span", "cb-tip-m", `disparou ${c.disparos30d} → usou ${c.usosAposDisparo30d ?? 0}`));
    if (c.gatilhos?.length) {
      const g = mk("div", "cb-tip-g");
      for (const x of c.gatilhos.slice(0, 6)) g.append(mk("span", "", x));
      tip.append(g);
    }
    tip.append(mk("span", "cb-tip-m", "clique pra editar"));
    tip.classList.remove("hidden");
    const r = p.getBoundingClientRect();
    const x = (e?.clientX ?? r.left + no.x) - r.left + 14;
    const y = (e?.clientY ?? r.top + no.y) - r.top + 14;
    tip.style.left = `${Math.min(x, Math.max(0, r.width - 260))}px`;
    tip.style.top = `${Math.min(y, Math.max(0, r.height - 120))}px`;
  }

  function esconderTip() {
    el("cb-tip")?.classList.add("hidden");
  }

  function rodape() {
    const r = mk("div", "cb-rodape");
    r.setAttribute("aria-label", "Legenda do mapa");
    r.innerHTML =
      `<span><i class="cb-lg cheio"></i>maior = mais usado nos últimos 30 dias</span>` +
      `<span><i class="cb-lg tracejado"></i>tracejado = nunca usada</span>` +
      `<span><i class="cb-lg anel"></i>anel = tem gatilho</span>` +
      `<span><i class="cb-lg apagado"></i>apagado = desligada</span>` +
      `<span><i class="cb-lg viva"></i>aresta acesa = uso agora mesmo</span>`;
    return r;
  }

  /* ------------------------------------------------------------------ */
  /*  painel lateral de edição                                           */
  /* ------------------------------------------------------------------ */

  function abrirPainel(id, redesenho = false) {
    const c = st.itens.find((x) => x.id === id);
    if (!c) return;
    if (!redesenho || !st.rascunho || st.rascunho.id !== id) {
      st.rascunho = { id, descricao: c.descricao ?? "", gatilhos: [...(c.gatilhos ?? [])], comoUsar: c.comoUsar ?? "", ligada: c.ligada !== false };
    }
    st.aberto = id;
    corpo()?.querySelector(".cb-painel")?.remove();
    const p = mk("aside", "cb-painel");
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-modal", "false");
    p.setAttribute("aria-labelledby", "cb-painel-tit");
    const cab = mk("div", "cb-painel-cab");
    const eb = mk("span", "cb-rot", `${c.tipo} · ${c.origem === "pessoa" ? "origem: sua edição" : "origem: auto"}`);
    const tit = mk("h2", `cb-painel-tit${c.tipo === "ferramenta" || c.tipo === "skill" ? " mono" : ""}`, c.nome);
    tit.id = "cb-painel-tit";
    const fechar = mk("button", "ghost cb-painel-x");
    fechar.type = "button";
    fechar.setAttribute("aria-label", "Fechar (Esc)");
    fechar.innerHTML = svgIco(ICO_X);
    fechar.addEventListener("click", fecharPainel);
    const esq = mk("div");
    esq.append(eb, tit);
    cab.append(esq, fechar);
    const corpoP = mk("div", "cb-painel-corpo");
    if (c.origem !== "pessoa") {
      const info = mk("p", "cb-info", "descrição gerada do código; sua edição fica por cima e não é sobrescrita");
      corpoP.append(info);
    }
    const r = st.rascunho;
    corpoP.append(campo("Descrição", "textarea", r.descricao, DESCRICAO_MAX, (v) => (r.descricao = v), 2));
    corpoP.append(campoGatilhos(r));
    corpoP.append(campo("Como usar", "textarea", r.comoUsar, COMO_USAR_MAX, (v) => (r.comoUsar = v), 2));
    const lig = mk("label", "ag-check cb-ligada");
    const chk = mk("input");
    chk.type = "checkbox";
    chk.checked = r.ligada;
    chk.addEventListener("change", () => (r.ligada = chk.checked));
    lig.append(chk, mk("span", "", st.path ? "Ligada neste projeto" : "Ligada"));
    corpoP.append(lig);
    corpoP.append(resumoDeUso(c));
    const rod = mk("div", "cb-painel-rod");
    const salvar = mk("button", "primary", "Salvar");
    salvar.type = "button";
    salvar.id = "btn-cb-salvar";
    salvar.addEventListener("click", () => void salvarRascunho());
    const cancelar_ = mk("button", "ghost", "Cancelar");
    cancelar_.type = "button";
    cancelar_.addEventListener("click", fecharPainel);
    rod.append(salvar, cancelar_);
    p.append(cab, corpoP, rod);
    p.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        fecharPainel();
      }
      // foco preso: Tab circula dentro do painel
      if (e.key === "Tab") {
        const focaveis = [...p.querySelectorAll("button,input,textarea,[tabindex='0']")].filter((n) => !n.disabled);
        if (!focaveis.length) return;
        const i = focaveis.indexOf(doc.activeElement);
        if (e.shiftKey && (i <= 0)) {
          e.preventDefault();
          focaveis[focaveis.length - 1].focus();
        } else if (!e.shiftKey && i === focaveis.length - 1) {
          e.preventDefault();
          focaveis[0].focus();
        }
      }
    });
    corpo()?.append(p);
    if (!redesenho) p.querySelector("textarea")?.focus();
  }

  function campo(rotulo, tag, valor, max, onInput, linhas = 1) {
    const w = mk("div", "cb-campo");
    const lab = mk("label");
    const cont = mk("span", "", `${valor.length}/${max}`);
    lab.append(mk("span", "", rotulo), cont);
    const inp = mk(tag);
    inp.value = valor;
    inp.maxLength = max;
    if (tag === "textarea") inp.rows = linhas;
    inp.addEventListener("input", () => {
      onInput(inp.value);
      cont.textContent = `${inp.value.length}/${max}`;
    });
    w.append(lab, inp);
    return w;
  }

  function campoGatilhos(r) {
    const w = mk("div", "cb-campo");
    const lab = mk("label");
    lab.append(mk("span", "", "Gatilhos"), mk("span", "", `${r.gatilhos.length}`));
    const chips = mk("div", "cb-chips");
    const pintar = () => {
      chips.replaceChildren();
      for (const g of r.gatilhos) {
        const s = mk("span", "cb-chip");
        s.append(mk("span", "", g));
        const x = mk("button", "cb-chip-x");
        x.type = "button";
        x.setAttribute("aria-label", `tirar gatilho ${g}`);
        x.innerHTML = svgIco(ICO_X);
        x.addEventListener("click", () => {
          r.gatilhos = r.gatilhos.filter((y) => y !== g);
          lab.lastChild.textContent = `${r.gatilhos.length}`;
          pintar();
        });
        s.append(x);
        chips.append(s);
      }
      chips.append(inp);
    };
    const inp = mk("input", "cb-chip-inp");
    inp.type = "text";
    inp.placeholder = "novo gatilho… (Enter adiciona)";
    inp.maxLength = 60;
    inp.setAttribute("aria-label", "novo gatilho");
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = inp.value.trim().toLowerCase();
      if (!v || r.gatilhos.includes(v) || r.gatilhos.length >= 12) return;
      r.gatilhos.push(v);
      inp.value = "";
      lab.lastChild.textContent = `${r.gatilhos.length}`;
      pintar();
      inp.focus();
    });
    pintar();
    w.append(lab, chips);
    return w;
  }

  function resumoDeUso(c) {
    const d = mk("div", "cb-uso");
    const nunca = !c.ultimoUso && !(c.usos30d > 0);
    d.append(mk("p", "cb-rot", "Uso"));
    d.append(mk("span", "", nunca ? "nunca usada" : `${c.usos7d ?? 0} em 7 d · ${c.usos30d ?? 0} em 30 d · último ${tempoRelativo(c.ultimoUso)}`));
    if (c.disparos30d) d.append(mk("span", "", `gatilho disparou ${c.disparos30d}× → usou ${c.usosAposDisparo30d ?? 0}×`));
    return d;
  }

  function tempoRelativo(iso) {
    if (!iso) return "nunca";
    const d = relogio() - Date.parse(iso);
    if (!Number.isFinite(d) || d < 0) return "agora";
    const m = Math.round(d / 60_000);
    if (m < 1) return "agora";
    if (m < 60) return `há ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `há ${h} h`;
    return `há ${Math.round(h / 24)} d`;
  }

  async function salvarRascunho() {
    const r = st.rascunho;
    if (!r || st.salvando) return;
    st.salvando = true;
    const b = el("btn-cb-salvar");
    if (b) b.disabled = true;
    try {
      const novo = await dados.salvar(r.id, { descricao: r.descricao, gatilhos: r.gatilhos, comoUsar: r.comoUsar, ligada: r.ligada }, st.path);
      const i = st.itens.findIndex((x) => x.id === r.id);
      if (i >= 0 && novo?.id) st.itens[i] = { ...st.itens[i], ...novo };
      st.kpis = kpisDoMapa(st.itens);
      st.layout = null;
      st.aberto = null;
      st.rascunho = null;
      desenhar();
      mostrarToast("salvo");
    } catch (e) {
      mostrarToast(`não salvou: ${e?.message ?? e}`, true);
    } finally {
      st.salvando = false;
      const b2 = el("btn-cb-salvar");
      if (b2) b2.disabled = false;
    }
  }

  function fecharPainel() {
    const id = st.aberto;
    st.aberto = null;
    st.rascunho = null;
    corpo()?.querySelector(".cb-painel")?.remove();
    corpo()?.querySelector(`[data-no="${id ? CSS.escape(id) : ""}"]`)?.focus?.();
  }

  /* ------------------------------------------------------------------ */
  /*  toast                                                              */
  /* ------------------------------------------------------------------ */

  /** Um toast só, reaproveitado: recarregar o catálogo redesenha a aba e não pode apagar o aviso. */
  let toastNo = null;
  function toastEl() {
    if (toastNo?.ownerDocument === doc) return toastNo;
    toastNo = mk("div", "cb-toast hidden");
    toastNo.id = "cb-toast";
    toastNo.setAttribute("role", "status");
    return toastNo;
  }

  function mostrarToast(texto, opcoes = false) {
    const { erro = false, desfazer = null } = typeof opcoes === "object" && opcoes ? opcoes : { erro: Boolean(opcoes) };
    const t = el("cb-toast");
    if (!t) return;
    cancelar(st.timerToast);
    t.replaceChildren();
    t.classList.toggle("erro", erro);
    t.innerHTML = erro ? svgIco(ICO_ALERTA) : svgIco(ICO_OK);
    t.append(mk("span", "", texto));
    if (desfazer) {
      const b = mk("button", "cb-lk cb-toast-lk", "Desfazer");
      b.type = "button";
      b.addEventListener("click", () => {
        t.classList.add("hidden");
        desfazer();
      });
      t.append(b);
    }
    t.classList.remove("hidden");
    st.timerToast = agendar(() => t.classList.add("hidden"), desfazer || erro ? 6000 : 3000);
  }

  /* ------------------------------------------------------------------ */
  /*  ciclo de vida                                                      */
  /* ------------------------------------------------------------------ */

  function sincronizar() {
    if (visivel && !doc.hidden) {
      void carregar();
      dados.acompanhar(escopo());
    } else {
      dados.pausar();
      esconderTip();
    }
  }

  return {
    ligar() {
      dados.ouvir("evento", aoEvento);
      doc.addEventListener?.("visibilitychange", () => visivel && sincronizar());
      el("cb-modo-painel")?.addEventListener("click", () => trocarModo("painel"));
      el("cb-modo-mapa")?.addEventListener("click", () => trocarModo("mapa"));
      el("btn-cb-adicionar")?.addEventListener("click", () => {
        if (st.modo !== "painel") trocarModo("painel");
        painel.abrirAdicionar();
      });
      el("cb-escopo")?.addEventListener("change", (e) => {
        st.escolha = e.target.value;
        st.seguindo = getProjetoAtual() || "";
        sincronizar();
      });
      el("pane-cerebro")?.addEventListener("keydown", (e) => {
        if (!visivel) return;
        const digitando = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "");
        if (e.key === "m" && !digitando && !e.ctrlKey && !e.metaKey && !e.altKey && !corpo()?.querySelector(".cb-folha")) {
          e.preventDefault();
          trocarModo(st.modo === "mapa" ? "painel" : "mapa");
          return;
        }
        if (st.modo === "painel" && painel.teclado(e)) e.stopPropagation();
      });
    },
    /** A aba é a que se vê? Oculta = sem stream, sem timer. */
    visivel(v) {
      const mudou = visivel !== v;
      visivel = v;
      if (mudou) sincronizar();
    },
    /** Projeto mudou com a aba aberta, ou a pessoa pediu pra recarregar. */
    recarregar() {
      if (!visivel) return;
      sincronizar();
    },
    abrir(id) {
      abrirPainel(id);
    },
    get estado() {
      return st;
    },
    get painel() {
      return painel;
    },
    get aberto() {
      return st.aberto;
    },
  };
}
