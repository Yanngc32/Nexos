/**
 * Aba "Cérebro", modo Painel: a tela de controle do catálogo.
 *
 * KPIs clicáveis (filtram) com tendência de 14 dias, "Testar gatilhos" ao vivo (o que uma mensagem
 * acordaria, com os termos marcados e a linha exata que iria pro modelo), filtros, tabela densa
 * ordenável com edição na própria linha, "O Cérebro sugere" (tirado das medições), linha do tempo
 * dos disparos em faixa e atalhos de teclado. Tudo pelo motor (`cerebro-dados.js`); a lógica pura
 * mora em `cerebro-painel-modelo.js`.
 *
 * Re-pinta por partes (KPIs, tabela, sugestões, linha do tempo) pra não roubar o foco de quem está
 * digitando; evento ao vivo troca só a linha da capacidade.
 */
import {
  alturas,
  contagemPorTipo,
  disparosNaJanela,
  ESTADOS,
  faixaDeDisparos,
  filtrar,
  idDeNova,
  ignorados,
  JANELAS,
  nuncaUsada,
  ordenar,
  pctUsou,
  previaNoPack,
  proximoIndice,
  resultadoDoDisparo,
  seriesDosKpis,
  tempoRelativo,
  TIPOS_DO_PAINEL,
  trechosMarcados,
} from "./cerebro-painel-modelo.js";

const DESCRICAO_MAX = 120;
const COMO_USAR_MAX = 240;
const GATILHOS_MAX = 12;
const TESTE_ESPERA_MS = 250;
const NOVIDADE_MS = 8_000;
const DISPAROS_RECARGA_MS = 1_500;

/* Lucide (traço 24×24, currentColor) */
const P = {
  ferramenta: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  skill: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  agente: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
  time: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  memoria: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  "mcp-externo": '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z"/>',
  busca: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  alerta: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  baixo: '<path d="m6 9 6 6 6-6"/>',
  cima: '<path d="m18 15-6-6-6 6"/>',
  editar: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/>',
  arquivo: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  mapa: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/>',
  ok: '<path d="M20 6 9 17l-5-5"/>',
  menos: '<path d="M5 12h14"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lampada: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4"/>',
  frasco: '<path d="M14.5 2v4.5M9.5 2v4.5M3 10h18M5 6h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
};
const ico = (nome, cls = "") => `<svg class="cb-i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[nome] ?? ""}</svg>`;
const COM_CONTEUDO = new Set(["doc", "memoria", "skill", "agente", "time"]);
const MONO = new Set(["ferramenta", "skill", "mcp-externo"]);
const ROTULO_CONVERSA = { chat: "chat", run: "passo de time / run", time: "supervisor de time", oculta: "interna do Nexos" };

export function criarCerebroPainel({
  doc = globalThis.document,
  dados,
  getPath = () => "",
  getItens = () => [],
  getCarregadoEm = () => 0,
  aoVerNoMapa = () => {},
  aoAbrirConversa = () => {},
  aoRecarregar = () => {},
  mostrarToast = () => {},
  relogio = () => Date.now(),
  agendar = (f, ms) => setTimeout(f, ms),
  cancelar = (t) => clearTimeout(t),
  armazenamento = globalThis.localStorage,
}) {
  const st = {
    raiz: null,
    busca: "",
    tipos: new Set(),
    estados: new Set(),
    usadas7d: false,
    ids: null, // { rotulo, set } — "revisar lista", "ver quais"
    kpi: "", // KPI ativo
    ordem: { coluna: "usos", dir: "desc" },
    aberto: null,
    rascunho: null,
    detalhes: new Map(),
    sugestoes: [],
    dispensadas: new Set(),
    disparos: [],
    janela: "24h",
    ltAberta: true,
    ltChave: null,
    teste: { texto: "", r: null, seq: 0, timer: null },
    novidades: new Map(), // id → { texto, ate }
    foco: -1,
    folha: null, // { modo: "nova"|"conteudo", ... }
    timerDisparos: null,
    linhas: [], // ids na ordem da tabela
  };

  const mk = (tag, cls, texto) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (texto !== undefined) n.textContent = texto;
    return n;
  };
  const btn = (cls, conteudoHtml, aoClicar, rotulo) => {
    const b = mk("button", cls);
    b.type = "button";
    b.innerHTML = conteudoHtml;
    if (rotulo) b.setAttribute("aria-label", rotulo);
    if (aoClicar) b.addEventListener("click", aoClicar);
    return b;
  };
  const $ = (sel) => st.raiz?.querySelector(sel) ?? null;
  const itens = () => getItens();
  const item = (id) => itens().find((c) => c.id === id);
  const chaveDispensadas = () => `nexos.cerebro.dispensadas:${getPath() || "global"}`;
  try {
    for (const x of JSON.parse(armazenamento?.getItem?.(chaveDispensadas()) ?? "[]")) st.dispensadas.add(x);
  } catch {
    /* nada guardado */
  }

  /* ================================================================== */
  /*  montagem                                                          */
  /* ================================================================== */

  function desenhar(raiz) {
    st.raiz = raiz;
    raiz.classList.add("cb-painel-modo");
    raiz.append(secaoKpis(), secaoTeste(), secaoFiltros());
    const duas = mk("div", "cb-duas");
    const caixa = mk("div", "cb-caixa");
    caixa.append(tabela());
    duas.append(caixa, secaoSugestoes());
    raiz.append(duas, secaoDisparos(), rodape());
    pintarKpis();
    pintarFiltros();
    pintarTabela();
    pintarSugestoes();
    pintarDisparos();
    pintarTeste();
    void carregarExtras();
  }

  async function carregarExtras() {
    const path = getPath();
    const [sug, disp] = await Promise.all([dados.sugestoes(path).catch(() => []), dados.disparos(path, 200).catch(() => [])]);
    if (path !== getPath()) return;
    st.sugestoes = sug;
    st.disparos = disp;
    pintarSugestoes();
    pintarDisparos();
    pintarTabela();
  }

  /* ================================================================== */
  /*  KPIs                                                              */
  /* ================================================================== */

  function secaoKpis() {
    const g = mk("section", "cb-kpis cb-kpis-p");
    g.setAttribute("aria-label", "Indicadores (clique filtra)");
    for (const id of ["total", "usadas", "gatilhos", "nunca"]) {
      const t = mk("button", `cb-kp${id === "nunca" ? " alerta" : ""}`);
      t.type = "button";
      t.dataset.kp = id;
      t.innerHTML = `<span class="cb-kp-rot"></span><span class="cb-kp-num"></span><span class="cb-sp" aria-hidden="true"></span><span class="cb-kp-rod"></span><span class="cb-kp-x hidden">filtrando ${ico("x")}</span>`;
      t.addEventListener("click", () => alternarKpi(id));
      g.append(t);
    }
    return g;
  }

  function alternarKpi(id) {
    const desligar = st.kpi === id;
    st.kpi = desligar ? "" : id;
    st.usadas7d = false;
    st.estados.delete("nunca");
    st.estados.delete("gatilho");
    st.ids = null;
    if (!desligar) {
      if (id === "total") {
        st.tipos.clear();
        st.estados.clear();
        st.busca = "";
        const b = $(".cb-busca input");
        if (b) b.value = "";
        st.kpi = "";
      }
      if (id === "usadas") st.usadas7d = true;
      if (id === "nunca") st.estados.add("nunca");
      if (id === "gatilhos") {
        st.estados.add("gatilho");
        st.ordem = { coluna: "disparos", dir: "desc" };
      }
    }
    pintarKpis();
    pintarFiltros();
    pintarTabela();
  }

  function pintarSpark(alvo, serie) {
    alvo.replaceChildren();
    if (!serie) return;
    alturas(serie).forEach((h, i) => {
      const b = mk("i", i === serie.length - 1 ? "hoje" : "");
      b.style.height = `${Math.max(h, 4)}%`;
      if (!h) b.classList.add("zero");
      alvo.append(b);
    });
  }

  function pintarKpis() {
    const lista = itens();
    const s = seriesDosKpis(lista);
    const total = lista.length;
    const pessoa = lista.filter((c) => c.origem === "pessoa").length;
    const usadas = lista.filter((c) => (c.usos7d ?? 0) > 0).length;
    const semanaAntes = lista.filter((c) => (c.porDia ?? []).slice(0, 7).some((n) => n > 0)).length;
    const semanaAgora = lista.filter((c) => (c.porDia ?? []).slice(7).some((n) => n > 0)).length;
    const delta = semanaAgora - semanaAntes;
    const disp = lista.reduce((n, c) => n + (c.disparos30d ?? 0), 0);
    const usou = lista.reduce((n, c) => n + (c.usosAposDisparo30d ?? 0), 0);
    const muitoIgnorados = lista.filter((c) => ignorados(c) >= 5).length;
    const nunca = lista.filter(nuncaUsada);
    const nuncaSemGatilho = nunca.filter((c) => !(c.gatilhos?.length > 0)).length;
    const conteudo = {
      total: ["Capacidades", `${total}`, null, `${total - pessoa} auto · ${pessoa} suas`],
      usadas: ["Usadas em 7 dias", `${usadas}<small>de ${total}</small>`, s.usadas, `${total ? Math.round((usadas / total) * 100) : 0}% do catálogo${delta ? ` · <b class="${delta > 0 ? "sobe" : "desce"}">${delta > 0 ? "+" : ""}${delta} vs. semana anterior</b>` : ""}`],
      gatilhos: ["Gatilhos · 30 d", `${disp}<small>→ ${usou} usos</small>`, s.disparos, disp ? `${Math.round((usou / disp) * 100)}% viram uso${muitoIgnorados ? ` · <b class="desce">${muitoIgnorados} ignorado(s) 5+ vezes</b>` : ""}` : "nenhum disparo ainda"],
      nunca: [`${ico("alerta")}Nunca usadas`, `${nunca.length}`, null, `${nuncaSemGatilho} sem gatilho · ${nunca.length - nuncaSemGatilho} com gatilho`],
    };
    for (const [id, [rot, num, serie, rod]] of Object.entries(conteudo)) {
      const t = $(`[data-kp="${id}"]`);
      if (!t) continue;
      t.querySelector(".cb-kp-rot").innerHTML = rot;
      t.querySelector(".cb-kp-num").innerHTML = num;
      t.querySelector(".cb-kp-rod").innerHTML = rod;
      pintarSpark(t.querySelector(".cb-sp"), serie);
      t.querySelector(".cb-sp").classList.toggle("hidden", !serie);
      const ativo = st.kpi === id;
      t.classList.toggle("ativo", ativo);
      t.setAttribute("aria-pressed", ativo ? "true" : "false");
      t.querySelector(".cb-kp-x").classList.toggle("hidden", !ativo);
    }
  }

  /* ================================================================== */
  /*  Testar gatilhos                                                   */
  /* ================================================================== */

  function secaoTeste() {
    const s = mk("section", "cb-teste");
    s.setAttribute("aria-label", "Testar gatilhos");
    const esq = mk("div", "cb-teste-esq");
    const rot = mk("label", "cb-rot cb-teste-rot");
    rot.htmlFor = "cb-teste-inp";
    rot.innerHTML = `${ico("frasco")}Testar gatilhos · escreva como se fosse uma mensagem pro agente`;
    const campo = mk("div", "cb-teste-campo");
    const eco = mk("div", "cb-teste-eco");
    eco.setAttribute("aria-hidden", "true");
    const inp = mk("input", "cb-teste-inp");
    inp.id = "cb-teste-inp";
    inp.type = "text";
    inp.placeholder = "ex.: faz um mock da tela de login e me diz onde fica o form";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.value = st.teste.texto;
    inp.addEventListener("input", () => {
      st.teste.texto = inp.value;
      pintarEco();
      cancelar(st.teste.timer);
      st.teste.timer = agendar(() => void testar(), TESTE_ESPERA_MS);
    });
    inp.addEventListener("scroll", () => (eco.scrollLeft = inp.scrollLeft));
    campo.append(eco, inp);
    const previa = mk("div", "cb-previa hidden");
    esq.append(rot, campo, previa);
    const res = mk("div", "cb-teste-res");
    res.setAttribute("aria-live", "polite");
    s.append(esq, res);
    return s;
  }

  async function testar() {
    const texto = st.teste.texto.trim();
    const seq = ++st.teste.seq;
    if (!texto) {
      st.teste.r = null;
      pintarTeste();
      return;
    }
    try {
      const r = await dados.testar(texto, getPath());
      if (seq !== st.teste.seq) return;
      st.teste.r = r;
    } catch (e) {
      if (seq !== st.teste.seq) return;
      st.teste.r = { erro: e?.message ?? String(e) };
    }
    pintarTeste();
  }

  function pintarEco() {
    const eco = $(".cb-teste-eco");
    if (!eco) return;
    eco.replaceChildren();
    const termos = (st.teste.r?.candidatos ?? []).flatMap((c) => c.bateram ?? []);
    for (const t of trechosMarcados(st.teste.texto, termos)) {
      eco.append(t.marca ? mk("mark", "", t.texto) : doc.createTextNode(t.texto));
    }
  }

  function pintarTeste() {
    pintarEco();
    const res = $(".cb-teste-res");
    const previa = $(".cb-previa");
    if (!res || !previa) return;
    res.replaceChildren();
    const r = st.teste.r;
    previa.classList.toggle("hidden", !r?.linha);
    previa.innerHTML = "";
    if (r?.linha) {
      previa.append(mk("b", "", "[Cérebro]"), doc.createTextNode(r.linha.replace(/^\[Cérebro\]/, "")));
      previa.title = r.linha;
    }
    if (!r) {
      res.append(mk("p", "cb-teste-dica", "Mostra quais capacidades lembrariam o agente, com o peso de cada gatilho e a linha exata que iria na frente da mensagem."));
      return;
    }
    if (r.erro) {
      res.append(mk("p", "cb-teste-dica erro", `Não deu pra testar: ${r.erro}`));
      return;
    }
    const cands = r.candidatos ?? [];
    const entram = cands.filter((c) => c.entra).length;
    res.append(mk("p", "cb-teste-dica", cands.length ? `${entram} capacidade(s) lembrariam o agente${cands.length > entram ? ` (teto 3 por mensagem; ${cands.length - entram} fica(m) de fora)` : ""}` : "Nenhum gatilho bate. Essa mensagem não lembraria o agente de nada."));
    const lista = mk("div", "cb-bate");
    for (const c of cands) {
      const linha = mk("button", `cb-bate-l${c.entra ? "" : " fora"}`);
      linha.type = "button";
      linha.title = c.entra ? "abrir na tabela" : "fora pelo teto de 3 por mensagem";
      linha.append(mk("span", "cb-g", c.gatilho), mk("span", "cb-mono", c.id), mk("span", "cb-peso", c.entra ? `peso ${c.peso}` : "fora (teto)"));
      linha.addEventListener("click", () => abrirLinha(c.id, { rolar: true }));
      lista.append(linha);
    }
    res.append(lista);
  }

  /* ================================================================== */
  /*  Filtros                                                           */
  /* ================================================================== */

  function secaoFiltros() {
    const f = mk("div", "cb-filtros");
    f.setAttribute("role", "search");
    const busca = mk("label", "cb-busca");
    busca.innerHTML = ico("busca");
    const inp = mk("input");
    inp.type = "search";
    inp.placeholder = "Buscar capacidade…";
    inp.setAttribute("aria-label", "Buscar capacidade");
    inp.value = st.busca;
    inp.addEventListener("input", () => {
      st.busca = inp.value;
      pintarTabela();
    });
    busca.append(inp, mk("kbd", "", "/"));
    f.append(busca, mk("span", "cb-sep"));
    const tipos = mk("span", "cb-chips-f");
    tipos.dataset.grupo = "tipos";
    const estados = mk("span", "cb-chips-f");
    estados.dataset.grupo = "estados";
    const ids = mk("span", "cb-chips-f");
    ids.dataset.grupo = "ids";
    const ord = mk("span", "cb-ord");
    f.append(tipos, mk("span", "cb-sep"), estados, ids, ord);
    return f;
  }

  function pintarFiltros() {
    const cont = contagemPorTipo(itens());
    const tipos = $('[data-grupo="tipos"]');
    const estados = $('[data-grupo="estados"]');
    const idsEl = $('[data-grupo="ids"]');
    const ord = $(".cb-ord");
    if (!tipos) return;
    tipos.replaceChildren();
    for (const t of TIPOS_DO_PAINEL) {
      const b = mk("button", `cb-chip-f${st.tipos.has(t.tipo) ? " on" : ""}`);
      b.type = "button";
      b.setAttribute("aria-pressed", st.tipos.has(t.tipo) ? "true" : "false");
      b.append(doc.createTextNode(`${t.rotulo} `), mk("span", "cb-n", String(cont[t.tipo] ?? 0)));
      b.addEventListener("click", () => {
        if (st.tipos.has(t.tipo)) st.tipos.delete(t.tipo);
        else st.tipos.add(t.tipo);
        pintarFiltros();
        pintarTabela();
      });
      tipos.append(b);
    }
    estados.replaceChildren();
    for (const e of ESTADOS) {
      const on = st.estados.has(e.estado);
      const b = mk("button", `cb-chip-f${on ? " on" : ""}${on && e.estado === "nunca" ? " alerta" : ""}`);
      b.type = "button";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.textContent = e.rotulo;
      b.addEventListener("click", () => {
        if (on) st.estados.delete(e.estado);
        else st.estados.add(e.estado);
        if (e.estado === "nunca") st.kpi = st.estados.has("nunca") ? "nunca" : "";
        pintarKpis();
        pintarFiltros();
        pintarTabela();
      });
      estados.append(b);
    }
    idsEl.replaceChildren();
    if (st.ids) {
      const b = mk("button", "cb-chip-f on");
      b.type = "button";
      b.innerHTML = `${st.ids.rotulo} ${ico("x")}`;
      b.setAttribute("aria-label", `tirar filtro ${st.ids.rotulo}`);
      b.addEventListener("click", () => {
        st.ids = null;
        pintarFiltros();
        pintarTabela();
      });
      idsEl.append(b);
    }
    ord.replaceChildren();
    const nomes = { usos: "usos 30d", disparos: "disparos", ignorados: "disparos ignorados", ultimo: "último uso", nome: "nome", tipo: "tipo", gatilhos: "gatilhos", tendencia: "tendência", ligada: "ligada" };
    ord.append(doc.createTextNode(`ordenar: ${nomes[st.ordem.coluna] ?? st.ordem.coluna} ${st.ordem.dir === "desc" ? "↓" : "↑"} · `));
    const alt = st.ordem.coluna === "ignorados" ? { coluna: "usos", rot: "usos 30d" } : { coluna: "ignorados", rot: "disparos ignorados" };
    const lk = btn("cb-lk", alt.rot, () => {
      st.ordem = { coluna: alt.coluna, dir: "desc" };
      pintarFiltros();
      pintarTabela();
    });
    ord.append(lk);
  }

  /* ================================================================== */
  /*  Tabela                                                            */
  /* ================================================================== */

  const COLS = [
    { id: "tipo", rot: "Tipo" },
    { id: "nome", rot: "Capacidade" },
    { id: "gatilhos", rot: "Gatilhos" },
    { id: "tendencia", rot: "Tendência", cls: "cb-col-tend" },
    { id: "usos", rot: "Usos 7d / 30d" },
    { id: "disparos", rot: "Disparou → usou", cls: "cb-col-disp", dica: "quantas vezes o gatilho lembrou o agente × quantas ele usou em seguida" },
    { id: "ultimo", rot: "Último uso", cls: "cb-col-ult" },
    { id: "ligada", rot: "Ligada" },
    { id: "", rot: "Ações", cls: "cb-col-acoes", oculto: true },
  ];

  function tabela() {
    const t = mk("table", "cb-tb");
    const thead = mk("thead");
    const tr = mk("tr");
    for (const c of COLS) {
      const th = mk("th", c.cls ?? "");
      th.scope = "col";
      if (c.dica) th.title = c.dica;
      if (c.id) {
        const b = mk("button", "cb-th", c.rot);
        b.type = "button";
        b.dataset.col = c.id;
        b.addEventListener("click", () => {
          st.ordem = st.ordem.coluna === c.id ? { coluna: c.id, dir: st.ordem.dir === "desc" ? "asc" : "desc" } : { coluna: c.id, dir: c.id === "nome" || c.id === "tipo" ? "asc" : "desc" };
          pintarFiltros();
          pintarTabela();
        });
        th.append(b);
      } else {
        th.append(mk("span", "cb-sr", c.rot));
      }
      tr.append(th);
    }
    thead.append(tr);
    const tbody = mk("tbody");
    tbody.addEventListener("keydown", tecladoDaTabela);
    t.append(thead, tbody);
    return t;
  }

  function visiveis() {
    return ordenar(filtrar(itens(), { busca: st.busca, tipos: st.tipos, estados: st.estados, usadas7d: st.usadas7d, ids: st.ids?.set ?? null }), st.ordem);
  }

  function pintarTabela() {
    const tbody = $(".cb-tb tbody");
    if (!tbody) return;
    for (const th of st.raiz.querySelectorAll(".cb-tb th")) {
      const b = th.querySelector(".cb-th");
      const on = b && b.dataset.col === st.ordem.coluna;
      th.classList.toggle("ordenado", Boolean(on));
      if (on) th.setAttribute("aria-sort", st.ordem.dir === "desc" ? "descending" : "ascending");
      else th.removeAttribute("aria-sort");
      if (b) b.innerHTML = `${COLS.find((c) => c.id === b.dataset.col).rot}${on ? ico(st.ordem.dir === "desc" ? "baixo" : "cima", "cb-i-ord") : ""}`;
    }
    const lista = visiveis();
    st.linhas = lista.map((c) => c.id);
    const maior = Math.max(1, ...lista.map((c) => c.usos30d ?? 0));
    tbody.replaceChildren();
    if (!lista.length) {
      const tr = mk("tr", "cb-tb-vazio");
      const td = mk("td");
      td.colSpan = COLS.length;
      td.textContent = "Nenhuma capacidade com esses filtros.";
      tr.append(td);
      tbody.append(tr);
      return;
    }
    for (const c of lista) {
      tbody.append(linha(c, maior));
      if (st.aberto === c.id) tbody.append(linhaAberta(c));
    }
    const cont = $(".cb-caixa");
    if (cont) cont.dataset.total = String(lista.length);
  }

  function sugestaoDeGatilho(id) {
    const s = st.sugestoes.find((x) => x.tipo === "gatilho" && x.id === id && !st.dispensadas.has(`${x.tipo}:${x.id}`));
    return s?.gatilhos?.[0] ?? null;
  }

  function linha(c, maior) {
    const tr = mk("tr", "cb-lin");
    tr.dataset.id = c.id;
    tr.tabIndex = st.linhas.indexOf(c.id) === Math.max(0, st.foco) ? 0 : -1;
    tr.setAttribute("aria-expanded", st.aberto === c.id ? "true" : "false");
    if (st.aberto === c.id) tr.classList.add("aberta");
    const nov = st.novidades.get(c.id);
    if (nov && nov.ate > relogio()) tr.classList.add("nova");
    if (c.ligada === false) tr.classList.add("off");

    const tdTipo = mk("td");
    tdTipo.innerHTML = `<span class="cb-tipo">${ico(c.tipo)}${TIPOS_DO_PAINEL.find((t) => t.tipo === c.tipo)?.rotulo ?? c.tipo}</span>`;

    const tdNome = mk("td");
    const nome = mk("div", "cb-nome");
    const n = mk("span", `${MONO.has(c.tipo) ? "cb-mono" : ""}${c.origem === "pessoa" ? " cb-pessoa" : ""}`, c.nome);
    if (c.origem === "pessoa") n.title = "editada por você";
    nome.append(n, mk("span", "cb-desc", c.descricao ?? ""));
    tdNome.append(nome);

    const tdGat = mk("td");
    const gat = mk("div", "cb-gat");
    const gs = c.gatilhos ?? [];
    for (const g of gs.slice(0, 3)) gat.append(mk("span", "", g));
    if (gs.length > 3) gat.append(mk("span", "cb-mais", `+${gs.length - 3}`));
    if (!gs.length) gat.append(mk("span", "cb-nen", "sem gatilho"));
    const sug = sugestaoDeGatilho(c.id);
    if (sug) {
      const b = btn("cb-sug-chip", `+ "${sug}"`, (e) => {
        e.stopPropagation();
        void adicionarGatilhos(c.id, [sug]);
      });
      b.title = "sugerido pelas medições — clique pra adicionar";
      gat.append(b);
    }
    gat.append(btn("cb-add-chip", "+", (e) => {
      e.stopPropagation();
      abrirLinha(c.id, { focar: "gatilho" });
    }, `adicionar gatilho em ${c.nome}`));
    tdGat.append(gat);

    const tdTend = mk("td", "cb-col-tend");
    const tend = mk("div", `cb-tend${(c.porDia ?? []).some((x) => x > 0) ? "" : " morto"}`);
    tend.setAttribute("aria-label", `usos por dia em 14 dias: ${(c.porDia ?? []).join(", ") || "nenhum"}`);
    const serie = c.porDia?.length ? c.porDia : Array.from({ length: 14 }, () => 0);
    alturas(serie).forEach((h, i) => {
      const b = mk("i", i === serie.length - 1 ? "hoje" : "");
      b.style.height = `${h || 12}%`;
      if (!h) b.classList.add("zero");
      tend.append(b);
    });
    tdTend.append(tend);

    const tdUso = mk("td");
    const uso = mk("div", "cb-uso-c");
    uso.append(mk("span", "cb-num", `${c.usos7d ?? 0} / ${c.usos30d ?? 0}`));
    const barra = mk("span", "cb-barra");
    const fill = mk("i");
    fill.style.width = `${Math.round(((c.usos30d ?? 0) / maior) * 100)}%`;
    barra.append(fill);
    uso.append(barra);
    tdUso.append(uso);

    const tdDisp = mk("td", "cb-col-disp");
    if (c.disparos30d) {
      const p = pctUsou(c);
      tdDisp.innerHTML = `<span class="cb-num">${c.disparos30d} → ${c.usosAposDisparo30d ?? 0}</span> <span class="cb-pct${p !== null && p < 34 ? " ruim" : ""}">${p}%</span>`;
    } else tdDisp.innerHTML = '<span class="cb-faint">—</span>';

    const tdUlt = mk("td", "cb-col-ult");
    tdUlt.append(mk("span", "cb-faint", tempoRelativo(c.ultimoUso, relogio())));
    if (nov && nov.ate > relogio()) tdUlt.append(mk("span", "cb-agora", ` · ${nov.texto}`));

    const tdLig = mk("td");
    const sw = mk("input", "cb-sw");
    sw.type = "checkbox";
    sw.setAttribute("role", "switch");
    sw.checked = c.ligada !== false;
    sw.setAttribute("aria-label", `${c.nome} ${sw.checked ? "ligada" : "desligada"} neste projeto`);
    sw.addEventListener("click", (e) => e.stopPropagation());
    sw.addEventListener("change", () => void alternarLigada(c.id, sw.checked));
    tdLig.append(sw);

    const tdAc = mk("td", "cb-col-acoes");
    const ac = mk("span", "cb-acoes");
    ac.append(btn("cb-ico-b", ico(st.aberto === c.id ? "cima" : "editar"), (e) => {
      e.stopPropagation();
      abrirLinha(c.id);
    }, st.aberto === c.id ? "fechar edição" : `editar ${c.nome}`));
    if (COM_CONTEUDO.has(c.tipo)) {
      ac.append(btn("cb-ico-b", ico("arquivo"), (e) => {
        e.stopPropagation();
        void verConteudo(c.id);
      }, `ver conteúdo de ${c.nome}`));
    }
    ac.append(btn("cb-ico-b", ico("mapa"), (e) => {
      e.stopPropagation();
      aoVerNoMapa(c.id);
    }, `ver ${c.nome} no mapa`));
    tdAc.append(ac);

    tr.append(tdTipo, tdNome, tdGat, tdTend, tdUso, tdDisp, tdUlt, tdLig, tdAc);
    tr.addEventListener("click", () => abrirLinha(c.id));
    tr.addEventListener("focus", () => (st.foco = st.linhas.indexOf(c.id)));
    return tr;
  }

  /** Troca só a linha da capacidade (evento ao vivo), sem mexer na aberta nem no foco. */
  function repintarLinha(id) {
    const velha = st.raiz?.querySelector(`tr.cb-lin[data-id="${cssEsc(id)}"]`);
    const c = item(id);
    if (!velha || !c) return;
    const maior = Math.max(1, ...visiveis().map((x) => x.usos30d ?? 0));
    const nova = linha(c, maior);
    const focada = doc.activeElement === velha;
    velha.replaceWith(nova);
    if (focada) nova.focus();
  }

  function tecladoDaTabela(e) {
    const tr = e.target.closest?.("tr.cb-lin");
    if (!tr || e.target !== tr) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focarLinha(proximoIndice(st.linhas.indexOf(tr.dataset.id), e.key === "ArrowDown" ? 1 : -1, st.linhas.length));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      abrirLinha(tr.dataset.id);
    }
  }

  function focarLinha(i) {
    if (i < 0) return;
    st.foco = i;
    const id = st.linhas[i];
    const tr = st.raiz?.querySelector(`tr.cb-lin[data-id="${cssEsc(id)}"]`);
    if (!tr) return;
    for (const x of st.raiz.querySelectorAll("tr.cb-lin")) x.tabIndex = -1;
    tr.tabIndex = 0;
    tr.focus();
    tr.scrollIntoView?.({ block: "nearest" });
  }

  /* ================================================================== */
  /*  Linha aberta (edição)                                             */
  /* ================================================================== */

  function abrirLinha(id, { focar = "", rolar = false } = {}) {
    const c = item(id);
    if (!c) return;
    if (st.aberto === id && !focar && !rolar) {
      fecharLinha();
      return;
    }
    // filtro escondendo a linha pedida (veio do teste ou da sugestão): limpa
    if (!st.linhas.includes(id)) {
      st.tipos.clear();
      st.estados.clear();
      st.usadas7d = false;
      st.ids = null;
      st.kpi = "";
      st.busca = "";
      const b = $(".cb-busca input");
      if (b) b.value = "";
      pintarKpis();
      pintarFiltros();
    }
    st.aberto = id;
    st.rascunho = { id, descricao: c.descricao ?? "", gatilhos: [...(c.gatilhos ?? [])], comoUsar: c.comoUsar ?? "" };
    st.foco = Math.max(0, visiveis().findIndex((x) => x.id === id));
    pintarTabela();
    const exp = $(".cb-exp");
    if (rolar || focar) exp?.scrollIntoView?.({ block: "nearest" });
    if (focar === "gatilho") exp?.querySelector(".cb-chip-inp")?.focus();
    else exp?.querySelector("textarea")?.focus();
    if (!st.detalhes.has(id)) {
      void dados
        .detalhe(id, getPath())
        .then((d) => {
          st.detalhes.set(id, d);
          if (st.aberto === id) pintarDetalhe(id);
        })
        .catch((e) => {
          st.detalhes.set(id, { erro: e?.message ?? String(e) });
          if (st.aberto === id) pintarDetalhe(id);
        });
    }
  }

  function fecharLinha() {
    const id = st.aberto;
    st.aberto = null;
    st.rascunho = null;
    pintarTabela();
    if (id) focarLinha(st.linhas.indexOf(id));
  }

  function linhaAberta(c) {
    const r = st.rascunho;
    const tr = mk("tr", "cb-exp");
    tr.dataset.para = c.id;
    const td = mk("td");
    td.colSpan = COLS.length;
    const grid = mk("div", "cb-exp-grid");
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", `editar ${c.nome}`);
    grid.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        fecharLinha();
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void salvarLinha();
      }
    });

    const col1 = mk("div", "cb-exp-col");
    col1.append(campoTexto("Descrição", r.descricao, DESCRICAO_MAX, (v) => (r.descricao = v)));
    col1.append(campoGatilhos(r, c));
    col1.append(campoTexto("Como usar", r.comoUsar, COMO_USAR_MAX, (v) => (r.comoUsar = v)));
    const info = mk("p", "cb-info");
    info.innerHTML = ico("info");
    if (c.origem === "pessoa") {
      info.append(doc.createTextNode("editada por você; a regeneração do catálogo não passa por cima · "));
      info.append(btn("cb-lk", "voltar ao gerado", () => void voltarAoGerado(c.id)));
    } else {
      info.append(doc.createTextNode("descrição gerada do código; sua edição fica por cima e não é sobrescrita"));
    }
    col1.append(info);

    const col2 = mk("div", "cb-exp-col cb-exp-d2");
    const col3 = mk("div", "cb-exp-col cb-exp-d3");
    col2.append(mk("p", "cb-faint", "carregando o uso…"));

    const rod = mk("div", "cb-exp-rod");
    const salvar = btn("primary cb-mini", "Salvar", () => void salvarLinha());
    salvar.id = "btn-cb-salvar-linha";
    rod.append(salvar, btn("ghost cb-mini", "Cancelar", fecharLinha));
    const dica = mk("span", "cb-faint");
    dica.innerHTML = "edição direto na linha · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> salva · <kbd>Esc</kbd> fecha · vale no próximo turno das conversas";
    rod.append(dica);

    grid.append(col1, col2, col3, rod);
    td.append(grid);
    tr.append(td);
    if (st.detalhes.has(c.id)) queueMicrotask(() => pintarDetalhe(c.id));
    return tr;
  }

  function campoTexto(rotulo, valor, max, onInput) {
    const w = mk("div", "cb-campo");
    const lab = mk("label");
    const id = `cb-c-${Math.random().toString(36).slice(2, 8)}`;
    lab.htmlFor = id;
    const cont = mk("span", "cb-cont", `${valor.length}/${max}`);
    lab.append(mk("span", "", rotulo), cont);
    const ta = mk("textarea");
    ta.id = id;
    ta.rows = 2;
    ta.maxLength = max;
    ta.value = valor;
    ta.addEventListener("input", () => {
      onInput(ta.value);
      cont.textContent = `${ta.value.length}/${max}`;
    });
    w.append(lab, ta);
    return w;
  }

  function campoGatilhos(r, c) {
    const w = mk("div", "cb-campo");
    const lab = mk("label");
    const cont = mk("span", "cb-cont");
    lab.append(mk("span", "", "Gatilhos"), cont);
    const chips = mk("div", "cb-chips");
    const inp = mk("input", "cb-chip-inp");
    inp.type = "text";
    inp.placeholder = "digite e Enter…";
    inp.maxLength = 60;
    inp.setAttribute("aria-label", `novo gatilho de ${c.nome}`);
    lab.htmlFor = inp.id = `cb-g-${Math.random().toString(36).slice(2, 8)}`;
    const add = (v) => {
      const t = v.trim().toLowerCase();
      if (!t || r.gatilhos.includes(t) || r.gatilhos.length >= GATILHOS_MAX) return false;
      r.gatilhos.push(t);
      return true;
    };
    const pintar = () => {
      chips.replaceChildren();
      for (const g of r.gatilhos) {
        const s = mk("span", "cb-chip");
        s.append(mk("span", "", g));
        s.append(btn("cb-chip-x", ico("x"), () => {
          r.gatilhos = r.gatilhos.filter((y) => y !== g);
          pintar();
          inp.focus();
        }, `tirar gatilho ${g}`));
        chips.append(s);
      }
      const d = st.detalhes.get(c.id);
      const sugeridos = (d?.gatilhosSugeridos ?? []).filter((s) => !r.gatilhos.includes(s.termo));
      for (const s of sugeridos) {
        const b = btn("cb-sug-chip", `+ "${s.termo}" <small>visto em ${s.vezes} msgs</small>`, () => {
          add(s.termo);
          pintar();
        });
        b.title = "palavra das mensagens antes de usos sem lembrete";
        chips.append(b);
      }
      chips.append(inp);
      cont.textContent = `${r.gatilhos.length}${sugeridos.length ? ` · sugeridos ${sugeridos.length}` : ""}`;
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (add(inp.value)) {
          inp.value = "";
          pintar();
          inp.focus();
        }
      } else if (e.key === "Backspace" && !inp.value && r.gatilhos.length) {
        r.gatilhos.pop();
        pintar();
        inp.focus();
      }
    });
    w.append(lab, chips);
    w.pintarGatilhos = pintar;
    chips.dataset.campoGatilhos = "1";
    pintar();
    return w;
  }

  function pintarDetalhe(id) {
    const exp = st.raiz?.querySelector(`tr.cb-exp[data-para="${cssEsc(id)}"]`);
    if (!exp) return;
    const d = st.detalhes.get(id);
    const col2 = exp.querySelector(".cb-exp-d2");
    const col3 = exp.querySelector(".cb-exp-d3");
    col2.replaceChildren();
    col3.replaceChildren();
    // sugeridos chegam com o detalhe: repinta os chips sem perder o que foi digitado
    exp.querySelector('[data-campo-gatilhos="1"]')?.closest(".cb-campo")?.pintarGatilhos?.();
    if (!d || d.erro) {
      col2.append(mk("p", "cb-faint", d?.erro ? `Não deu pra ler o uso: ${d.erro}` : "carregando o uso…"));
      return;
    }
    const g = mk("div");
    g.append(mk("p", "cb-rot", "Usos × disparos · 14 dias"));
    const graf = mk("div", "cb-graf");
    graf.setAttribute("aria-label", `usos por dia: ${d.porDia.join(", ")}; disparos por dia: ${d.disparosPorDia.join(", ")}`);
    const maior = Math.max(1, ...d.porDia, ...d.disparosPorDia);
    d.porDia.forEach((u, i) => {
      const di = mk("i", "disp");
      di.style.height = `${Math.round(((d.disparosPorDia[i] ?? 0) / maior) * 100)}%`;
      const us = mk("i");
      us.style.height = `${Math.round((u / maior) * 100)}%`;
      graf.append(di, us);
    });
    const leg = mk("div", "cb-graf-leg");
    leg.innerHTML = '<span>14 d atrás</span><span class="cb-lg2"><i></i>usos <i class="disp"></i>disparos</span><span>hoje</span>';
    g.append(graf, leg);
    col2.append(g);
    const conv = mk("div");
    conv.append(mk("p", "cb-rot", "Em que conversa · 30 d"));
    const ul = mk("ul", "cb-ult");
    const pares = Object.entries(d.porConversa).filter(([, n]) => n > 0);
    if (!pares.length) ul.append(mk("li", "cb-faint", "nenhum uso em 30 dias"));
    for (const [tipo, n] of pares.sort((a, b) => b[1] - a[1])) {
      const li = mk("li");
      li.append(mk("b", "", ROTULO_CONVERSA[tipo] ?? tipo), mk("span", "cb-num", String(n)));
      ul.append(li);
    }
    conv.append(ul);
    col2.append(conv);

    const ult = mk("div");
    ult.append(mk("p", "cb-rot", "Últimos usos"));
    const ul2 = mk("ul", "cb-ult");
    if (!d.ultimos.length) ul2.append(mk("li", "cb-faint", "nunca usada"));
    for (const u of d.ultimos.slice(0, 5)) {
      const li = mk("li");
      li.append(mk("b", "", u.titulo));
      const dir = mk("span");
      dir.append(doc.createTextNode(`${tempoRelativo(u.ts, relogio())} · `));
      dir.append(btn("cb-lk", "abrir", () => aoAbrirConversa({ threadId: u.threadId, projectPath: getPath() || undefined })));
      li.append(dir);
      ul2.append(li);
    }
    ult.append(ul2);
    col3.append(ult);
    const at = mk("div");
    at.append(mk("p", "cb-rot", "Atalhos"));
    const ul3 = mk("ul", "cb-ult cb-atalhos");
    const li1 = mk("li");
    li1.append(btn("cb-lk", "ver no mapa", () => aoVerNoMapa(id)));
    ul3.append(li1);
    const c = item(id);
    if (c && COM_CONTEUDO.has(c.tipo)) {
      const li2 = mk("li");
      li2.append(btn("cb-lk", c.tipo === "doc" || c.tipo === "memoria" ? "ver conteúdo" : c.tipo === "skill" ? "ver SKILL.md" : "ver instruções", () => void verConteudo(id)));
      ul3.append(li2);
    }
    if (c?.disparos30d) {
      const li3 = mk("li");
      li3.append(btn("cb-lk", `ver os disparos (${c.disparos30d})`, () => verDisparosDe(id)));
      ul3.append(li3);
    }
    at.append(ul3);
    col3.append(at);
  }

  async function salvarLinha() {
    const r = st.rascunho;
    if (!r) return;
    const b = $("#btn-cb-salvar-linha");
    if (b) b.disabled = true;
    try {
      const novo = await dados.salvar(r.id, { descricao: r.descricao, gatilhos: r.gatilhos, comoUsar: r.comoUsar }, getPath());
      mesclar(r.id, novo);
      st.aberto = null;
      st.rascunho = null;
      pintarTabela();
      pintarKpis();
      focarLinha(st.linhas.indexOf(r.id));
      mostrarToast("salvo · vale no próximo turno");
    } catch (e) {
      mostrarToast(`não salvou: ${e?.message ?? e}`, { erro: true });
      if (b) b.disabled = false;
    }
  }

  async function voltarAoGerado(id) {
    try {
      await dados.removerAjuste(id, getPath());
      st.aberto = null;
      st.rascunho = null;
      mostrarToast("voltou ao gerado do código");
      aoRecarregar();
    } catch (e) {
      mostrarToast(`não deu: ${e?.message ?? e}`, { erro: true });
    }
  }

  function mesclar(id, novo) {
    const lista = itens();
    const i = lista.findIndex((x) => x.id === id);
    if (i >= 0 && novo?.id) lista[i] = { ...lista[i], ...novo };
  }

  async function alternarLigada(id, ligada, { semDesfazer = false } = {}) {
    const c = item(id);
    if (!c) return;
    const antes = c.ligada !== false;
    c.ligada = ligada;
    repintarLinha(id);
    pintarKpis();
    try {
      const novo = await dados.salvar(id, { ligada }, getPath());
      mesclar(id, novo);
      repintarLinha(id);
      if (!semDesfazer) {
        mostrarToast(`${c.nome} ${ligada ? "ligada" : "desligada"} ${getPath() ? "neste projeto" : "no chat geral"}`, { desfazer: () => void alternarLigada(id, antes, { semDesfazer: true }) });
      }
    } catch (e) {
      c.ligada = antes;
      repintarLinha(id);
      mostrarToast(`não gravou: ${e?.message ?? e}`, { erro: true });
    }
  }

  async function adicionarGatilhos(id, termos) {
    const c = item(id);
    if (!c) return;
    const gatilhos = [...new Set([...(c.gatilhos ?? []), ...termos.map((t) => t.toLowerCase())])].slice(0, GATILHOS_MAX);
    try {
      const novo = await dados.salvar(id, { gatilhos }, getPath());
      mesclar(id, novo);
      st.sugestoes = st.sugestoes.filter((s) => !(s.tipo === "gatilho" && s.id === id));
      st.detalhes.delete(id);
      repintarLinha(id);
      pintarSugestoes();
      pintarKpis();
      mostrarToast(`gatilho ${termos.map((t) => `"${t}"`).join(", ")} em ${c.nome}`, {
        desfazer: () => void dados.salvar(id, { gatilhos: c.gatilhos ?? [] }, getPath()).then((v) => (mesclar(id, v), repintarLinha(id))),
      });
    } catch (e) {
      mostrarToast(`não gravou: ${e?.message ?? e}`, { erro: true });
    }
  }

  /* ================================================================== */
  /*  O Cérebro sugere                                                  */
  /* ================================================================== */

  function secaoSugestoes() {
    const a = mk("aside", "cb-sug");
    a.setAttribute("aria-labelledby", "cb-sug-h");
    const h = mk("h3");
    h.id = "cb-sug-h";
    h.innerHTML = `${ico("lampada")}O Cérebro sugere <span class="cb-faint">· das medições, sem LLM</span>`;
    a.append(h, mk("div", "cb-sug-lista"));
    return a;
  }

  function dispensar(s) {
    st.dispensadas.add(`${s.tipo}:${s.id ?? s.titulo}`);
    try {
      armazenamento?.setItem?.(chaveDispensadas(), JSON.stringify([...st.dispensadas]));
    } catch {
      /* sem armazenamento: só nesta sessão */
    }
    pintarSugestoes();
    pintarTabela();
  }

  function filtrarIds(rotulo, ids) {
    st.ids = { rotulo, set: new Set(ids) };
    st.tipos.clear();
    st.estados.clear();
    st.usadas7d = false;
    st.kpi = "";
    pintarKpis();
    pintarFiltros();
    pintarTabela();
    $(".cb-caixa")?.scrollIntoView?.({ block: "nearest" });
  }

  async function desligarTodas(ids) {
    const alvos = ids.filter((id) => item(id)?.ligada !== false);
    for (const id of alvos) {
      const c = item(id);
      if (c) c.ligada = false;
    }
    pintarTabela();
    pintarKpis();
    let falhas = 0;
    for (const id of alvos) {
      try {
        mesclar(id, await dados.salvar(id, { ligada: false }, getPath()));
      } catch {
        falhas += 1;
      }
    }
    pintarTabela();
    mostrarToast(falhas ? `${alvos.length - falhas} desligadas, ${falhas} falharam` : `${alvos.length} desligadas`, {
      erro: falhas > 0,
      desfazer: async () => {
        for (const id of alvos) {
          try {
            mesclar(id, await dados.salvar(id, { ligada: true }, getPath()));
          } catch {
            /* fica como estava */
          }
        }
        pintarTabela();
        pintarKpis();
      },
    });
  }

  function pintarSugestoes() {
    const alvo = $(".cb-sug-lista");
    if (!alvo) return;
    alvo.replaceChildren();
    const lista = st.sugestoes.filter((s) => !st.dispensadas.has(`${s.tipo}:${s.id ?? s.titulo}`));
    if (!lista.length) {
      alvo.append(mk("p", "cb-faint cb-sug-vazio", "Nada a sugerir agora. As sugestões aparecem quando um gatilho é ignorado, quando o agente usa algo sem lembrete ou quando o bloco do pack enche."));
      return;
    }
    for (const s of lista) {
      const box = mk("div", `cb-sug-i ${s.nivel}`);
      const t = mk("div", "cb-sug-t");
      t.innerHTML = ico(s.nivel === "atencao" ? "alerta" : "info");
      t.append(mk("span", s.id ? "cb-mono" : "", s.titulo));
      const acts = mk("div", "cb-sug-acts");
      if (s.tipo === "ignorado") {
        acts.append(btn("ghost cb-mini", "Editar descrição", () => abrirLinha(s.id, { rolar: true })));
        acts.append(btn("ghost cb-mini", "Ver os disparos", () => verDisparosDe(s.id)));
      } else if (s.tipo === "sem-gatilho") {
        acts.append(btn("ghost cb-mini", "Revisar lista", () => filtrarIds(`sem gatilho e sem uso: ${s.ids.length}`, s.ids)));
        acts.append(btn("ghost cb-mini", "Desligar todas", () => void desligarTodas(s.ids)));
      } else if (s.tipo === "gatilho") {
        acts.append(btn("primary cb-mini", `Adicionar ${s.gatilhos.map((g) => `"${g}"`).join(", ")}`, () => void adicionarGatilhos(s.id, s.gatilhos)));
        acts.append(btn("ghost cb-mini", "Agora não", () => dispensar(s)));
      } else if (s.tipo === "bloco" && s.ids?.length) {
        acts.append(btn("ghost cb-mini", "Ver quais ficaram de fora", () => filtrarIds(`fora do bloco: ${s.ids.length}`, s.ids)));
      }
      if (s.tipo !== "gatilho" && s.tipo !== "bloco") acts.append(btn("cb-lk", "dispensar", () => dispensar(s)));
      box.append(t, mk("p", "", s.texto), acts);
      alvo.append(box);
    }
  }

  /* ================================================================== */
  /*  Linha do tempo                                                    */
  /* ================================================================== */

  function secaoDisparos() {
    const s = mk("section", "cb-lt");
    s.setAttribute("aria-labelledby", "cb-lt-h");
    const h = mk("h2", "cb-lt-h");
    h.id = "cb-lt-h";
    const tog = btn("cb-lt-tog", "", () => {
      st.ltAberta = !st.ltAberta;
      pintarDisparos();
    });
    tog.setAttribute("aria-controls", "cb-lt-corpo");
    h.append(tog);
    const seg = mk("div", "ax-tabs cb-lt-seg");
    seg.setAttribute("role", "tablist");
    seg.setAttribute("aria-label", "Janela");
    for (const j of Object.keys(JANELAS)) {
      const b = btn("ax-tab", j.replace("h", " h").replace("d", " d"), () => {
        st.janela = j;
        pintarDisparos();
      });
      b.setAttribute("role", "tab");
      b.dataset.janela = j;
      seg.append(b);
    }
    h.append(seg);
    const corpo = mk("div", "cb-lt-corpo");
    corpo.id = "cb-lt-corpo";
    s.append(h, corpo);
    return s;
  }

  function verDisparosDe(id) {
    st.ltChave = id;
    st.ltAberta = true;
    st.janela = "30d";
    pintarDisparos();
    $(".cb-lt")?.scrollIntoView?.({ block: "start" });
  }

  function pintarDisparos() {
    const s = $(".cb-lt");
    if (!s) return;
    const agora = relogio();
    const lista = disparosNaJanela(st.disparos, st.janela, agora, st.ltChave);
    const usou = lista.filter((d) => d.usou).length;
    const tog = s.querySelector(".cb-lt-tog");
    tog.innerHTML = `${ico(st.ltAberta ? "baixo" : "cima")}Disparos recentes <span class="cb-faint">· ${JANELAS[st.janela].rotuloInicio.replace(" atrás", "")} · ${lista.length} disparo(s), ${usou} uso(s)</span>`;
    tog.setAttribute("aria-expanded", st.ltAberta ? "true" : "false");
    for (const b of s.querySelectorAll(".cb-lt-seg .ax-tab")) b.dataset.on = b.dataset.janela === st.janela ? "1" : "0";
    const corpo = s.querySelector(".cb-lt-corpo");
    corpo.classList.toggle("hidden", !st.ltAberta);
    corpo.replaceChildren();
    if (!st.ltAberta) return;
    if (st.ltChave) {
      const f = btn("cb-chip-f on", `só ${st.ltChave} ${ico("x")}`, () => {
        st.ltChave = null;
        pintarDisparos();
      });
      f.setAttribute("aria-label", `tirar filtro ${st.ltChave}`);
      corpo.append(f);
    }
    if (!st.disparos.length) {
      corpo.append(mk("p", "cb-faint", "Nenhum disparo nos últimos 30 dias. Use \"Testar gatilhos\" pra ver o que lembraria o agente."));
      return;
    }
    const faixa = mk("div", "cb-faixa");
    faixa.setAttribute("aria-label", `disparos por período: ${usou} viraram uso, ${lista.length - usou} não`);
    const bins = faixaDeDisparos(disparosNaJanela(st.disparos, st.janela, agora, st.ltChave), st.janela, agora);
    bins.forEach((b, i) => {
      const col = mk("i", i === bins.length - 1 ? "agora" : "");
      for (const r of b.slice(0, 6)) col.append(mk("b", r === "usou" ? "ok" : r === "esperando" ? "esp" : ""));
      if (b.length > 6) col.title = `${b.length} disparos`;
      faixa.append(col);
    });
    const leg = mk("div", "cb-faixa-leg");
    leg.innerHTML = `<span>${JANELAS[st.janela].rotuloInicio}</span><span class="cb-lg3"><span class="ok">usou</span><span class="esp">esperando</span><span>ignorou</span></span><span>agora</span>`;
    corpo.append(faixa, leg);
    const ul = mk("ul", "cb-lt-lista");
    if (!lista.length) ul.append(mk("li", "cb-faint", "nenhum disparo nessa janela"));
    for (const d of lista.slice(0, 50)) {
      const li = mk("li", st.novidades.get(`disp:${d.ts}:${d.chave}`) ? "nova" : "");
      const res = resultadoDoDisparo(d, agora);
      li.append(mk("span", "cb-h", tempoRelativo(d.ts, agora)), mk("span", "cb-c", d.titulo ?? "conversa"));
      const cap = btn("cb-lk cb-mono", d.chave, () => abrirLinha(d.chave, { rolar: true }));
      li.append(cap);
      const r = mk("span", `cb-res ${res}`);
      r.innerHTML = `${ico(res === "usou" ? "ok" : res === "esperando" ? "relogio" : "menos")}${res === "usou" ? "usou" : res === "esperando" ? "esperando" : "ignorou"}`;
      li.append(r, btn("cb-lk", "abrir", () => aoAbrirConversa({ threadId: d.threadId, projectPath: d.projectPath })));
      ul.append(li);
    }
    corpo.append(ul);
  }

  /* ================================================================== */
  /*  Rodapé, folha lateral (nova capacidade / conteúdo)                */
  /* ================================================================== */

  function rodape() {
    const r = mk("div", "cb-rodape-p");
    r.innerHTML =
      "<span><kbd>/</kbd> buscar</span><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><kbd>Enter</kbd> editar na linha</span>" +
      "<span><kbd>m</kbd> mapa</span><span><kbd>t</kbd> testar gatilhos</span><span><kbd>n</kbd> nova capacidade</span><span><kbd>Esc</kbd> fechar</span><span class=\"cb-atualizado\"></span>";
    pintarAtualizado(r);
    return r;
  }

  function pintarAtualizado(r = $(".cb-rodape-p")) {
    const el = r?.querySelector(".cb-atualizado");
    const em = getCarregadoEm();
    if (el) el.textContent = em ? `catálogo lido ${tempoRelativo(new Date(em).toISOString(), relogio())}` : "";
  }

  function fecharFolha() {
    st.folha = null;
    st.raiz?.querySelector(".cb-folha")?.remove();
    st.raiz?.querySelector(".cb-folha-veu")?.remove();
  }

  function montarFolha(titulo, eb) {
    fecharFolha();
    const veu = mk("div", "cb-folha-veu");
    veu.addEventListener("click", fecharFolha);
    const f = mk("aside", "cb-folha");
    f.setAttribute("role", "dialog");
    f.setAttribute("aria-modal", "true");
    f.setAttribute("aria-labelledby", "cb-folha-tit");
    const cab = mk("div", "cb-folha-cab");
    const esq = mk("div");
    const h = mk("h2", "cb-folha-tit", titulo);
    h.id = "cb-folha-tit";
    esq.append(mk("span", "cb-rot", eb), h);
    cab.append(esq, btn("ghost cb-ico-b", ico("x"), fecharFolha, "Fechar (Esc)"));
    const corpo = mk("div", "cb-folha-corpo");
    const rod = mk("div", "cb-folha-rod");
    f.append(cab, corpo, rod);
    f.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        fecharFolha();
      }
      if (e.key === "Tab") {
        const foc = [...f.querySelectorAll("button,input,textarea,select")].filter((n) => !n.disabled && n.offsetParent !== null);
        if (!foc.length) return;
        const i = foc.indexOf(doc.activeElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          foc[foc.length - 1].focus();
        } else if (!e.shiftKey && i === foc.length - 1) {
          e.preventDefault();
          foc[0].focus();
        }
      }
    });
    st.raiz.append(veu, f);
    return { f, corpo, rod };
  }

  async function verConteudo(id) {
    const c = item(id);
    if (!c) return;
    const { f, corpo, rod } = montarFolha(c.nome, `${c.tipo} · conteúdo`);
    f.classList.add("larga");
    st.folha = { modo: "conteudo", id };
    corpo.append(mk("p", "cb-faint", "carregando…"));
    rod.append(btn("ghost", "Fechar", fecharFolha));
    f.querySelector(".cb-folha-cab button")?.focus();
    try {
      const r = await dados.conteudo(id, getPath());
      if (st.folha?.id !== id) return;
      corpo.replaceChildren();
      if (r?.caminho) corpo.append(mk("p", "cb-mono cb-faint", r.caminho));
      corpo.append(mk("pre", "cb-pre", r?.texto ?? ""));
    } catch (e) {
      corpo.replaceChildren(mk("p", "cb-erro", `Não deu pra ler: ${e?.message ?? e}`));
    }
  }

  const TIPOS_NOVA = [
    { tipo: "ferramenta", rot: "ferramenta" },
    { tipo: "skill", rot: "skill" },
    { tipo: "doc", rot: "doc" },
    { tipo: "mcp-externo", rot: "mcp externo" },
  ];

  function abrirAdicionar(tipo = "doc") {
    const { corpo, rod } = montarFolha("O que o agente deve saber usar?", "nova capacidade · origem: sua");
    const form = { tipo, nome: "", caminho: "", descricao: "", gatilhos: [], comoUsar: "", transporte: "stdio", comando: "", url: "" };
    st.folha = { modo: "nova", form };
    const tipos = mk("div", "cb-tipos");
    tipos.setAttribute("role", "radiogroup");
    tipos.setAttribute("aria-label", "Tipo");
    const campos = mk("div", "cb-folha-campos");
    const previa = mk("div", "cb-previa");
    const pintarPrevia = () => {
      const comoUsar = form.tipo === "doc" ? `Read ${form.caminho || "…"}` : form.tipo === "mcp-externo" ? `ferramentas \`mcp__${form.nome || "…"}__*\`` : form.comoUsar;
      previa.replaceChildren(mk("b", "", "no pack: "), doc.createTextNode(previaNoPack({ ...form, comoUsar })));
    };
    const linhaCampo = (rot, valor, aoMudar, { max = 200, ph = "", area = false } = {}) => {
      const w = mk("div", "cb-campo");
      const lab = mk("label");
      const id = `cb-n-${Math.random().toString(36).slice(2, 8)}`;
      lab.htmlFor = id;
      lab.append(mk("span", "", rot));
      const inp = mk(area ? "textarea" : "input");
      if (!area) inp.type = "text";
      else inp.rows = 2;
      inp.id = id;
      inp.maxLength = max;
      inp.placeholder = ph;
      inp.value = valor;
      inp.addEventListener("input", () => {
        aoMudar(inp.value);
        pintarPrevia();
      });
      w.append(lab, inp);
      return w;
    };
    const pintarCampos = () => {
      campos.replaceChildren();
      if (form.tipo === "doc") {
        campos.append(linhaCampo("Caminho do .md (relativo ao projeto ou absoluto)", form.caminho, (v) => (form.caminho = v), { ph: "docs/RUNBOOK.md", max: 300 }));
        campos.append(linhaCampo("Nome", form.nome, (v) => (form.nome = v), { ph: "Runbook", max: 60 }));
      } else if (form.tipo === "mcp-externo") {
        campos.append(linhaCampo("Nome do servidor", form.nome, (v) => (form.nome = v.toLowerCase()), { ph: "github", max: 32 }));
        const sel = mk("div", "cb-campo");
        const lab = mk("label", "", "Transporte");
        const s = mk("select");
        s.id = lab.htmlFor = `cb-t-${Math.random().toString(36).slice(2, 8)}`;
        for (const t of ["stdio", "http"]) {
          const o = mk("option", "", t);
          o.value = t;
          o.selected = form.transporte === t;
          s.append(o);
        }
        s.addEventListener("change", () => {
          form.transporte = s.value;
          pintarCampos();
        });
        sel.append(lab, s);
        campos.append(sel);
        if (form.transporte === "stdio") campos.append(linhaCampo("Comando (com argumentos)", form.comando, (v) => (form.comando = v), { ph: "npx -y @modelcontextprotocol/server-github", max: 400 }));
        else campos.append(linhaCampo("URL", form.url, (v) => (form.url = v), { ph: "https://mcp.exemplo.com/mcp", max: 400 }));
        campos.append(mk("p", "cb-faint", "Segredos (env/headers) se configuram depois em Configurações; o log do Nexos mascara os valores."));
      } else {
        campos.append(linhaCampo("Nome", form.nome, (v) => (form.nome = v), { ph: form.tipo === "skill" ? "minha-skill" : "nome_da_ferramenta", max: 60 }));
      }
      campos.append(linhaCampo(`Descrição (até ${DESCRICAO_MAX})`, form.descricao, (v) => (form.descricao = v), { max: DESCRICAO_MAX }));
      if (form.tipo !== "mcp-externo") {
        const g = campoGatilhos(form, { id: "nova", nome: "a nova capacidade" });
        campos.append(g);
        g.addEventListener("click", pintarPrevia);
        g.addEventListener("keyup", pintarPrevia);
      }
      if (form.tipo === "ferramenta" || form.tipo === "skill") campos.append(linhaCampo("Como usar", form.comoUsar, (v) => (form.comoUsar = v), { max: COMO_USAR_MAX, area: true }));
      pintarPrevia();
    };
    for (const t of TIPOS_NOVA) {
      const b = btn(`cb-tipo-b${form.tipo === t.tipo ? " on" : ""}`, `${ico(t.tipo)}${t.rot}`, () => {
        form.tipo = t.tipo;
        for (const x of tipos.children) {
          x.classList.toggle("on", x.dataset.tipo === t.tipo);
          x.setAttribute("aria-checked", x.dataset.tipo === t.tipo ? "true" : "false");
        }
        pintarCampos();
      });
      b.dataset.tipo = t.tipo;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", form.tipo === t.tipo ? "true" : "false");
      tipos.append(b);
    }
    const erro = mk("p", "cb-erro hidden");
    erro.setAttribute("role", "alert");
    corpo.append(tipos, campos, previa, erro);
    pintarCampos();
    const salvar = btn("primary", "Salvar", () => void salvarNova(form, erro, salvar));
    rod.append(salvar, btn("ghost", "Cancelar", fecharFolha));
    corpo.querySelector("input")?.focus();
  }

  async function salvarNova(form, erro, botao) {
    erro.classList.add("hidden");
    const falhar = (msg) => {
      erro.textContent = msg;
      erro.classList.remove("hidden");
      botao.disabled = false;
    };
    botao.disabled = true;
    const path = getPath();
    try {
      if (form.tipo === "mcp-externo") {
        if (!path) return falhar("MCP externo é por projeto: escolha um projeto no topo.");
        const partes = form.comando.trim().split(/\s+/).filter(Boolean);
        const body = form.transporte === "stdio" ? { transporte: "stdio", comando: partes[0] ?? "", args: partes.slice(1), descricao: form.descricao } : { transporte: "http", url: form.url.trim(), descricao: form.descricao };
        await dados.salvarMcp(form.nome.trim(), body, path);
        fecharFolha();
        mostrarToast(`MCP ${form.nome} salvo · procurando as ferramentas dele…`);
        const r = await dados.descobrirMcp(form.nome.trim(), path).catch((e) => ({ erro: e?.message ?? String(e), ferramentas: [] }));
        mostrarToast(r.erro ? `${form.nome}: não consegui listar as ferramentas (${r.erro})` : `${form.nome}: ${r.ferramentas.length} ferramenta(s) no catálogo`, { erro: Boolean(r.erro) });
        aoRecarregar();
        return;
      }
      const nome = form.tipo === "doc" ? form.nome.trim() || form.caminho.trim().split(/[\\/]/).pop() : form.nome.trim();
      const id = idDeNova(form.tipo, form.tipo === "doc" ? nome.replace(/\.md$/i, "") : nome);
      if (!id) return falhar("Dê um nome.");
      if (!form.descricao.trim()) return falhar("Escreva a descrição: é o que o agente lê.");
      if (form.tipo === "doc" && !form.caminho.trim()) return falhar("Doc precisa do caminho do .md.");
      const caminho = form.tipo === "doc" && path && !/^([a-z]:|[\\/])/i.test(form.caminho.trim()) ? `${path.replace(/[\\/]+$/, "")}/${form.caminho.trim()}` : form.caminho.trim();
      await dados.salvar(
        id,
        {
          tipo: form.tipo,
          nome,
          descricao: form.descricao.trim(),
          gatilhos: form.gatilhos,
          ...(form.tipo === "doc" ? { caminho, comoUsar: `Read ${form.caminho.trim()}` } : { comoUsar: form.comoUsar.trim() || undefined }),
        },
        path,
      );
      fecharFolha();
      mostrarToast(`${nome} entrou no catálogo`);
      aoRecarregar();
    } catch (e) {
      falhar(e?.message ?? String(e));
    }
  }

  /* ================================================================== */
  /*  ao vivo, teclado                                                  */
  /* ================================================================== */

  function aoEvento(ev, c) {
    if (!st.raiz) return;
    const agora = relogio();
    if (c) {
      st.novidades.set(c.id, { texto: ev.tipo === "disparo" ? "disparou agora" : "usou agora", ate: agora + NOVIDADE_MS });
      st.detalhes.delete(c.id);
      repintarLinha(c.id);
      agendar(() => {
        if (st.novidades.get(c.id)?.ate <= relogio()) {
          st.novidades.delete(c.id);
          repintarLinha(c.id);
        }
      }, NOVIDADE_MS + 50);
    }
    pintarKpis();
    if (ev.tipo === "disparo") {
      st.disparos.unshift({ ts: ev.ts, threadId: ev.threadId, chave: ev.chave, tipo: "chat", projectPath: ev.projectPath, titulo: "…" });
      st.novidades.set(`disp:${ev.ts}:${ev.chave}`, { ate: agora + NOVIDADE_MS });
    } else if (ev.usou) {
      const d = st.disparos.find((x) => x.threadId === ev.threadId && x.chave === ev.chave && !x.usou);
      if (d) d.usou = true;
    }
    pintarDisparos();
    // título da conversa chega com a releitura (em lote, não por evento)
    cancelar(st.timerDisparos);
    st.timerDisparos = agendar(() => {
      const path = getPath();
      void dados
        .disparos(path, 200)
        .then((l) => {
          if (path !== getPath()) return;
          st.disparos = l;
          pintarDisparos();
        })
        .catch(() => {});
    }, DISPAROS_RECARGA_MS);
  }

  const digitando = (alvo) => /^(INPUT|TEXTAREA|SELECT)$/.test(alvo?.tagName ?? "") || alvo?.isContentEditable;

  /** Atalhos do painel; devolve true se tratou. `m` (mapa) fica com a view. */
  function teclado(e) {
    if (!st.raiz) return false;
    if (e.key === "Escape") {
      if (st.folha) return fecharFolha(), true;
      if (st.aberto) return fecharLinha(), true;
      if (doc.activeElement === $(".cb-teste-inp") && st.teste.texto) {
        st.teste.texto = "";
        $(".cb-teste-inp").value = "";
        st.teste.r = null;
        pintarTeste();
        return true;
      }
      return false;
    }
    if (digitando(e.target) || e.ctrlKey || e.metaKey || e.altKey || st.folha) return false;
    if (e.key === "/") {
      e.preventDefault();
      $(".cb-busca input")?.focus();
      return true;
    }
    if (e.key === "t") {
      e.preventDefault();
      $(".cb-teste-inp")?.focus();
      return true;
    }
    if (e.key === "n") {
      e.preventDefault();
      abrirAdicionar();
      return true;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.target.closest?.("tr.cb-lin")) {
      e.preventDefault();
      focarLinha(proximoIndice(st.foco, e.key === "ArrowDown" ? 1 : -1, st.linhas.length));
      return true;
    }
    return false;
  }

  return {
    desenhar,
    aoEvento,
    teclado,
    abrirAdicionar,
    abrirLinha,
    pintarAtualizado,
    /** Projeto trocou: tira filtros de lista, linha aberta e caches do projeto anterior. */
    reset() {
      st.aberto = null;
      st.rascunho = null;
      st.ids = null;
      st.detalhes.clear();
      st.sugestoes = [];
      st.disparos = [];
      st.ltChave = null;
      st.teste.r = null;
      st.dispensadas.clear();
      try {
        for (const x of JSON.parse(armazenamento?.getItem?.(chaveDispensadas()) ?? "[]")) st.dispensadas.add(x);
      } catch {
        /* nada guardado */
      }
      fecharFolha();
    },
    get estado() {
      return st;
    },
  };
}

function cssEsc(s) {
  return globalThis.CSS?.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1");
}
