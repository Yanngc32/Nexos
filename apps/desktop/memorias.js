/**
 * Seção "Memórias" da tela Memória: a pessoa vê, busca e lê o que o agente guardou pra lembrar
 * entre conversas (daemon: GET /v1/memorias e /v1/memorias/arquivo). Só leitura.
 *
 * Em cima, helpers puros (rótulos, agrupamento, busca, data relativa, markdown simples, textos de
 * erro e de aviso) testados sem DOM. Embaixo, as fábricas da seção e do aviso no chat. Tudo que vem
 * da memória (título, gancho, corpo) é dado não confiável: entra sempre por `textContent`, nunca por
 * `innerHTML`. Segredo vem como `{{secret:nome}}` e vira um chip "senha guardada" — o valor nunca
 * passa por aqui.
 */

export const TIPOS = [
  { id: "instrucao", rotulo: "Instrução" },
  { id: "preferencia", rotulo: "Preferência" },
  { id: "conhecimento", rotulo: "Conhecimento" },
  { id: "decisao", rotulo: "Decisão" },
  { id: "infra", rotulo: "Infra" },
  { id: "correcao", rotulo: "Correção" },
];
const ROTULO_DO_TIPO = Object.fromEntries(TIPOS.map((t) => [t.id, t.rotulo]));

export const AVISO_MS = 6000;
const AVISO_REPETIDO_MS = 4000;
const BUSCA_ESPERA_MS = 250;
const SEGREDO = /\{\{secret:([^}\s]+)\}\}/g;

export function rotuloDoTipo(tipo) {
  const t = String(tipo ?? "").trim();
  if (ROTULO_DO_TIPO[t]) return ROTULO_DO_TIPO[t];
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Memória";
}

/** Minúsculo e sem acento: "Decisão" acha "decisao" e vice-versa. */
export function normalizar(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Título da seção de uma pasta: o que o motor manda em `secoes`; sem isso, a raiz é "Geral" e a pasta vira "a / b". */
export function tituloDaPasta(pasta, secoes) {
  const p = String(pasta ?? "");
  const dado = secoes?.[p];
  if (typeof dado === "string" && dado.trim()) return dado.trim();
  if (!p) return "Geral";
  return p.split("/").filter(Boolean).join(" / ");
}

/** Grupos por pasta: a raiz primeiro, depois as pastas em ordem alfabética; dentro, a mais recente primeiro. */
export function agruparPorPasta(itens, secoes) {
  const grupos = new Map();
  for (const it of itens ?? []) {
    const pasta = String(it.pasta ?? "");
    if (!grupos.has(pasta)) grupos.set(pasta, []);
    grupos.get(pasta).push(it);
  }
  return [...grupos.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, "pt-BR")))
    .map(([pasta, lista]) => ({
      pasta,
      titulo: tituloDaPasta(pasta, secoes),
      itens: lista.slice().sort(
        (x, y) =>
          String(y.atualizadaEm ?? "").localeCompare(String(x.atualizadaEm ?? "")) ||
          String(x.titulo ?? "").localeCompare(String(y.titulo ?? ""), "pt-BR"),
      ),
    }));
}

/** Busca local (enquanto o motor não responde): todas as palavras precisam aparecer em título, gancho, tipo ou pasta. */
export function filtrarMemorias(itens, consulta, secoes) {
  const termos = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (!termos.length) return (itens ?? []).slice();
  return (itens ?? []).filter((it) => {
    const alvo = normalizar(
      [it.titulo, it.gancho, rotuloDoTipo(it.tipo), it.tipo, it.pasta, tituloDaPasta(it.pasta, secoes)].join(" "),
    );
    return termos.every((t) => alvo.includes(t));
  });
}

function dataValida(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "agora há pouco", "há 5 min", "há 3 h", "ontem", "há 4 dias", "12/10" (ou "12/10/2024" em outro ano). */
export function fmtRelativo(iso, agora = Date.now()) {
  const d = dataValida(iso);
  if (!d) return "";
  const ref = new Date(agora);
  const seg = Math.round((ref.getTime() - d.getTime()) / 1000);
  if (seg < 60) return "agora há pouco";
  const min = Math.floor(seg / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  const meiaNoite = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((meiaNoite(ref) - meiaNoite(d)) / 86_400_000);
  if (dias === 0) return `há ${h} h`;
  if (dias === 1) return "ontem";
  if (dias < 7) return `há ${dias} dias`;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return d.getFullYear() === ref.getFullYear() ? `${dd}/${mm}` : `${dd}/${mm}/${d.getFullYear()}`;
}

/** "12/10/2025 às 14:05" — vai no title da data relativa. */
export function fmtDataCompleta(iso) {
  const d = dataValida(iso);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} às ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Texto dividido em pedaços: texto comum e segredos (`{{secret:nome}}` → { tipo: "segredo", nome }). */
export function partesDoCorpo(texto) {
  const s = String(texto ?? "");
  const partes = [];
  let i = 0;
  for (const m of s.matchAll(SEGREDO)) {
    if (m.index > i) partes.push({ tipo: "texto", texto: s.slice(i, m.index) });
    partes.push({ tipo: "segredo", nome: m[1] });
    i = m.index + m[0].length;
  }
  if (i < s.length) partes.push({ tipo: "texto", texto: s.slice(i) });
  return partes;
}

/** Inline do markdown: `código`, **negrito** e segredos. O resto é texto. */
export function partesInline(texto) {
  const out = [];
  for (const p of partesDoCorpo(texto)) {
    if (p.tipo === "segredo") {
      out.push(p);
      continue;
    }
    const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let i = 0;
    for (const m of p.texto.matchAll(re)) {
      if (m.index > i) out.push({ tipo: "texto", texto: p.texto.slice(i, m.index) });
      out.push(m[1] !== undefined ? { tipo: "codigo", texto: m[1] } : { tipo: "negrito", texto: m[2] });
      i = m.index + m[0].length;
    }
    if (i < p.texto.length) out.push({ tipo: "texto", texto: p.texto.slice(i) });
  }
  return out;
}

/**
 * Markdown simples em blocos: títulos (#), listas (-, *, 1.), citação (>), bloco de código (```) e
 * parágrafos. Frontmatter no começo some. Não é um parser completo — é o suficiente pra ler.
 */
export function blocosDoMarkdown(md) {
  let s = String(md ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const blocos = [];
  let par = null;
  let lista = null;
  let codigo = null;
  const fecharPar = () => {
    if (par) blocos.push(par);
    par = null;
  };
  const fecharLista = () => {
    if (lista) blocos.push(lista);
    lista = null;
  };
  for (const linha of s.split("\n")) {
    if (codigo) {
      if (/^\s*```/.test(linha)) {
        blocos.push(codigo);
        codigo = null;
      } else codigo.texto = codigo.texto === null ? linha : `${codigo.texto}\n${linha}`;
      continue;
    }
    if (/^\s*```/.test(linha)) {
      fecharPar();
      fecharLista();
      codigo = { tipo: "codigo", texto: null };
      continue;
    }
    const t = /^(#{1,6})\s+(.*)$/.exec(linha);
    if (t) {
      fecharPar();
      fecharLista();
      blocos.push({ tipo: "titulo", nivel: t[1].length, texto: t[2].trim() });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(linha);
    if (li) {
      fecharPar();
      const ordenada = /\d/.test(li[1]);
      if (!lista || lista.ordenada !== ordenada) {
        fecharLista();
        lista = { tipo: "lista", ordenada, itens: [] };
      }
      lista.itens.push(li[2].trim());
      continue;
    }
    if (!linha.trim()) {
      fecharPar();
      fecharLista();
      continue;
    }
    fecharLista();
    const cit = /^\s*>\s?(.*)$/.exec(linha);
    const tipo = cit ? "citacao" : "paragrafo";
    const texto = (cit ? cit[1] : linha).trim();
    if (par && par.tipo === tipo) par.texto += ` ${texto}`;
    else {
      fecharPar();
      par = { tipo, texto };
    }
  }
  if (codigo) blocos.push({ ...codigo, texto: codigo.texto ?? "" });
  fecharPar();
  fecharLista();
  return blocos.map((b) => (b.tipo === "codigo" ? { ...b, texto: b.texto ?? "" } : b));
}

/** Título que dá pra mostrar mesmo sem `titulo`: o nome do arquivo sem ".md". */
export function tituloDaMemoria(m) {
  const t = String(m?.titulo ?? "").trim();
  if (t) return t;
  const nome = String(m?.relPath ?? "").split("/").pop() ?? "";
  return nome.replace(/\.md$/i, "");
}

const VERBO_DO_AVISO = { create: "Memória salva", update: "Memória atualizada", retire: "Memória aposentada" };

/** "Memória salva: Deploy usa a porta 8080" — vazio se o evento não diz o que mudou. */
export function textoDoAviso(ev) {
  const verbo = VERBO_DO_AVISO[ev?.op] ?? VERBO_DO_AVISO.create;
  const titulo = tituloDaMemoria(ev);
  return titulo ? `${verbo}: ${titulo}` : "";
}

export function textoDoContador(n, buscando) {
  if (buscando) return n === 1 ? "1 encontrada" : `${n} encontradas`;
  return n === 1 ? "1 memória" : `${n} memórias`;
}

export const TEXTO_VAZIO = {
  titulo: "Nenhuma memória ainda",
  texto:
    "O agente guarda aqui o que vale lembrar entre conversas: sozinho, quando percebe algo importante, ou quando você pede — basta escrever “lembra disso” no chat.",
};

export function textoSemResultado(consulta) {
  return {
    titulo: `Nada encontrado para “${String(consulta ?? "").trim()}”`,
    texto: "Tente outra palavra, ou limpe a busca pra ver todas as memórias.",
  };
}

const semPonto = (s) => String(s ?? "").trim().replace(/[.\s]+$/, "");

/** Texto de erro claro, em pt-BR. `onde`: "lista" ou "arquivo". */
export function textoDoErro(e, onde = "lista") {
  const status = e?.status;
  if (onde === "arquivo") {
    if (status === 404) return "Essa memória não existe mais. Ela pode ter sido apagada ou renomeada — atualize a lista.";
    const msg = semPonto(e?.message);
    return msg ? `Não deu pra abrir essa memória. ${msg}.` : "Não deu pra abrir essa memória. Tente de novo.";
  }
  if (status === 404) return "Este motor ainda não mostra as memórias. Atualize o Nexos e tente de novo.";
  const msg = semPonto(e?.message);
  return msg ? `Não deu pra carregar as memórias. ${msg}.` : "Não deu pra carregar as memórias. Tente de novo.";
}

/* ---------------------------------------------------------------------------
 * DOM
 * ------------------------------------------------------------------------- */

const SVG_CADEADO =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false"><rect x="2.5" y="5.5" width="7" height="5" rx="1.2"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>';
const SVG_MARCADOR =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3.5 1.8h5v8.4L6 8.4l-2.5 1.8Z"/></svg>';

function no(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function botao(texto, classe, onClick) {
  const b = no("button", classe, texto);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function chipDoSegredo(nome) {
  const c = no("span", "mem-segredo");
  c.title = `Segredo “${nome}”, guardado no cofre. O valor não aparece aqui.`;
  c.insertAdjacentHTML("afterbegin", SVG_CADEADO);
  c.append(no("span", "", "senha guardada"));
  return c;
}

/** Pedaços inline → nós DOM (texto sempre por textContent). */
export function desenharInline(texto) {
  const f = document.createDocumentFragment();
  for (const p of partesInline(texto)) {
    if (p.tipo === "segredo") f.append(chipDoSegredo(p.nome));
    else if (p.tipo === "codigo") f.append(no("code", "", p.texto));
    else if (p.tipo === "negrito") f.append(no("strong", "", p.texto));
    else f.append(document.createTextNode(p.texto));
  }
  return f;
}

/** Corpo da memória → DOM legível. Títulos descem dois níveis: dentro da seção o h3 é o título da memória. */
export function desenharCorpo(corpo) {
  const f = document.createDocumentFragment();
  for (const b of blocosDoMarkdown(corpo)) {
    if (b.tipo === "titulo") {
      const h = no(`h${Math.min(6, b.nivel + 3)}`, "mem-md-h");
      h.append(desenharInline(b.texto));
      f.append(h);
    } else if (b.tipo === "lista") {
      const l = no(b.ordenada ? "ol" : "ul");
      for (const it of b.itens) {
        const li = no("li");
        li.append(desenharInline(it));
        l.append(li);
      }
      f.append(l);
    } else if (b.tipo === "codigo") {
      const pre = no("pre");
      const code = no("code");
      for (const p of partesDoCorpo(b.texto)) code.append(p.tipo === "segredo" ? chipDoSegredo(p.nome) : document.createTextNode(p.texto));
      pre.append(code);
      f.append(pre);
    } else {
      const p = no(b.tipo === "citacao" ? "blockquote" : "p");
      p.append(desenharInline(b.texto));
      f.append(p);
    }
  }
  return f;
}

function selo(tipo) {
  const s = no("span", "mem-tipo", rotuloDoTipo(tipo));
  s.dataset.tipo = String(tipo ?? "");
  return s;
}

function quando(iso, agora) {
  const rel = fmtRelativo(iso, agora);
  if (!rel) return null;
  const t = no("time", "mem-quando", rel);
  t.dateTime = String(iso);
  t.title = `Atualizada em ${fmtDataCompleta(iso)}`;
  return t;
}

/**
 * `req`: cliente do daemon. `el`: `$`. `agora`: relógio (teste). `esperaBuscaMs`: quanto a busca
 * espera a pessoa parar de digitar antes de perguntar ao motor.
 */
export function createMemorias({ req, el, agora = () => Date.now(), esperaBuscaMs = BUSCA_ESPERA_MS }) {
  const st = {
    dados: null,
    consulta: "",
    consultaDoMotor: null,
    carregando: false,
    erro: "",
    aberta: null,
    abrindo: "",
    erroArquivo: "",
    relAberto: "",
  };
  let seqLista = 0;
  let seqArquivo = 0;
  let timerBusca = 0;

  const busca = el("mem-busca");
  const lista = el("mem-lista");

  busca?.addEventListener("input", () => {
    st.consulta = busca.value;
    desenharLista();
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => void carregar(), esperaBuscaMs);
  });
  busca?.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && busca.value) {
      e.preventDefault();
      e.stopPropagation();
      limparBusca();
    } else if (e.key === "ArrowDown") {
      const primeiro = lista?.querySelector(".mem-item");
      if (primeiro) {
        e.preventDefault();
        primeiro.focus();
      }
    }
  });
  el("btn-mem-tentar")?.addEventListener("click", () => void carregar());
  el("btn-mem-fechar")?.addEventListener("click", () => fechar());
  el("mem-leitor")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      fechar();
    }
  });
  // setas e Home/End andam pela lista; Tab sai dela como de costume
  lista?.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const itens = [...lista.querySelectorAll(".mem-item")];
    const i = itens.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    let j = i;
    if (e.key === "ArrowDown") j = Math.min(itens.length - 1, i + 1);
    else if (e.key === "ArrowUp") {
      if (i === 0 && busca) return busca.focus();
      j = Math.max(0, i - 1);
    } else if (e.key === "Home") j = 0;
    else j = itens.length - 1;
    itens[j].focus();
  });

  function limparBusca() {
    if (!busca) return;
    busca.value = "";
    st.consulta = "";
    clearTimeout(timerBusca);
    desenharLista();
    void carregar();
    busca.focus();
  }

  async function carregar() {
    clearTimeout(timerBusca);
    const consulta = st.consulta.trim();
    const seq = ++seqLista;
    st.carregando = true;
    desenharStatus();
    try {
      const dados = await req(consulta ? `/v1/memorias?consulta=${encodeURIComponent(consulta)}` : "/v1/memorias");
      if (seq !== seqLista) return;
      st.dados = { dir: dados?.dir ?? "", itens: Array.isArray(dados?.itens) ? dados.itens : [], secoes: dados?.secoes ?? {} };
      st.consultaDoMotor = consulta;
      st.erro = "";
    } catch (e) {
      if (seq !== seqLista) return;
      st.erro = textoDoErro(e, "lista");
    } finally {
      if (seq === seqLista) st.carregando = false;
    }
    desenharLista();
  }

  async function abrir(relPath) {
    if (!relPath) return;
    const seq = ++seqArquivo;
    st.relAberto = relPath;
    st.abrindo = relPath;
    st.erroArquivo = "";
    st.aberta = null;
    desenharLeitor();
    marcarAberta();
    try {
      const m = await req(`/v1/memorias/arquivo?path=${encodeURIComponent(relPath)}`);
      if (seq !== seqArquivo) return;
      st.aberta = m;
    } catch (e) {
      if (seq !== seqArquivo) return;
      st.erroArquivo = textoDoErro(e, "arquivo");
    }
    st.abrindo = "";
    desenharLeitor();
    el("mem-leitor-h")?.focus({ preventScroll: true });
  }

  function fechar() {
    const rel = st.relAberto;
    seqArquivo++;
    st.relAberto = "";
    st.aberta = null;
    st.abrindo = "";
    st.erroArquivo = "";
    desenharLeitor();
    marcarAberta();
    const item = [...(lista?.querySelectorAll(".mem-item") ?? [])].find((b) => b.dataset.rel === rel);
    (item ?? busca)?.focus();
  }

  /** O que a lista mostra: a resposta do motor pra consulta atual; enquanto ele não responde, o filtro local. */
  function itensVisiveis() {
    const d = st.dados;
    if (!d) return [];
    if (st.consultaDoMotor === st.consulta.trim()) return d.itens;
    return filtrarMemorias(d.itens, st.consulta, d.secoes);
  }

  function desenharStatus() {
    const s = el("mem-contador");
    if (!s) return;
    if (st.carregando && !st.dados) s.textContent = "carregando…";
    else if (st.erro && !st.dados) s.textContent = "não carregou";
    else s.textContent = textoDoContador(itensVisiveis().length, Boolean(st.consulta.trim()));
    s.dataset.on = st.dados && !st.erro ? "1" : "0";
    lista?.setAttribute("aria-busy", st.carregando ? "true" : "false");
  }

  function vazio(titulo, texto, acao) {
    const v = no("div", "aprend-vazio mem-vazio");
    v.append(no("h3", "", titulo), no("p", "", texto));
    if (acao) v.append(acao);
    return v;
  }

  function desenharLista() {
    desenharStatus();
    const erroBox = el("mem-erro");
    erroBox?.classList.toggle("hidden", !st.erro);
    const erroMsg = el("mem-erro-msg");
    if (erroMsg) erroMsg.textContent = st.erro;
    if (!lista) return;
    if (!st.dados) {
      lista.replaceChildren();
      return;
    }
    const itens = itensVisiveis();
    if (!itens.length) {
      const q = st.consulta.trim();
      if (q) {
        const t = textoSemResultado(q);
        lista.replaceChildren(vazio(t.titulo, t.texto, botao("Limpar busca", "ghost", limparBusca)));
      } else lista.replaceChildren(vazio(TEXTO_VAZIO.titulo, TEXTO_VAZIO.texto));
      return;
    }
    const agoraMs = agora();
    const frag = document.createDocumentFragment();
    for (const g of agruparPorPasta(itens, st.dados.secoes)) {
      const sec = no("section", "mem-grupo");
      const hid = `mem-grupo-${normalizar(g.pasta || "raiz").replace(/[^a-z0-9]+/g, "-")}`;
      sec.setAttribute("aria-labelledby", hid);
      const h = no("h3", "mem-grupo-h");
      h.id = hid;
      h.append(no("span", "mem-grupo-t", g.titulo), no("span", "mem-grupo-n", String(g.itens.length)));
      if (g.pasta) h.title = g.pasta;
      const ul = no("ul", "mem-itens");
      ul.setAttribute("role", "list");
      for (const it of g.itens) {
        const li = no("li");
        const b = botao("", "mem-item", () => void abrir(it.relPath));
        b.dataset.rel = String(it.relPath ?? "");
        const topo = no("span", "mem-item-topo");
        topo.append(no("span", "mem-item-t", tituloDaMemoria(it)));
        b.append(topo);
        if (it.gancho) b.append(no("span", "mem-item-g", String(it.gancho)));
        const meta = no("span", "mem-item-meta");
        meta.append(selo(it.tipo));
        const q = quando(it.atualizadaEm, agoraMs);
        if (q) meta.append(q);
        b.append(meta);
        li.append(b);
        ul.append(li);
      }
      sec.append(h, ul);
      frag.append(sec);
    }
    lista.replaceChildren(frag);
    marcarAberta();
  }

  function marcarAberta() {
    for (const b of lista?.querySelectorAll(".mem-item") ?? []) {
      if (b.dataset.rel === st.relAberto && st.relAberto) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    el("mem-corpo")?.setAttribute("data-aberto", st.relAberto ? "1" : "0");
  }

  function desenharLeitor() {
    const leitor = el("mem-leitor");
    if (!leitor) return;
    leitor.classList.toggle("hidden", !st.relAberto);
    const h = el("mem-leitor-h");
    const eyebrow = el("mem-leitor-pasta");
    const gancho = el("mem-leitor-gancho");
    const meta = el("mem-leitor-meta");
    const corpo = el("mem-leitor-corpo");
    const caminho = el("mem-leitor-caminho");
    const err = el("mem-leitor-erro");
    if (!st.relAberto) return;
    const resumo = st.dados?.itens.find((i) => i.relPath === st.relAberto);
    const m = st.aberta ?? resumo ?? { relPath: st.relAberto };
    if (eyebrow) eyebrow.textContent = tituloDaPasta(m.pasta ?? resumo?.pasta ?? "", st.dados?.secoes);
    if (h) h.textContent = tituloDaMemoria(m);
    if (gancho) {
      gancho.textContent = m.gancho ? String(m.gancho) : "";
      gancho.classList.toggle("hidden", !m.gancho);
    }
    if (meta) {
      meta.replaceChildren();
      if (m.tipo) meta.append(selo(m.tipo));
      const q = quando(m.atualizadaEm, agora());
      if (q) meta.append(q);
      if (m.revisao) meta.append(no("span", "mem-rev", `revisão ${m.revisao}`));
    }
    if (caminho) caminho.textContent = String(st.relAberto);
    if (err) {
      err.textContent = st.erroArquivo;
      err.classList.toggle("hidden", !st.erroArquivo);
    }
    if (corpo) {
      corpo.setAttribute("aria-busy", st.abrindo ? "true" : "false");
      if (st.abrindo) corpo.replaceChildren(no("p", "mem-abrindo", "Abrindo…"));
      else if (st.aberta) {
        const f = desenharCorpo(st.aberta.corpo);
        if (f.childNodes.length) corpo.replaceChildren(f);
        else corpo.replaceChildren(no("p", "mem-abrindo", "Esta memória não tem texto além do título."));
      } else corpo.replaceChildren();
    }
  }

  return { carregar, abrir, fechar, estado: () => st };
}

/**
 * Aviso discreto no chat quando o agente salva, atualiza ou aposenta uma memória (SSE
 * `memoria.salva`). O contêiner (`#mem-aviso`, role=status) fica sempre no DOM pro leitor de tela
 * anunciar a troca; o botão some sozinho em `duracaoMs`, e passar o mouse ou focar segura.
 */
export function createAvisoDeMemoria({ el, aoAbrir = () => {}, duracaoMs = AVISO_MS, agora = () => Date.now() }) {
  let timer = 0;
  let ultimo = { chave: "", em: 0 };

  function esconder() {
    clearTimeout(timer);
    timer = 0;
    el("mem-aviso")?.replaceChildren();
  }

  function agendar() {
    clearTimeout(timer);
    timer = setTimeout(esconder, duracaoMs);
  }

  function mostrar(ev) {
    const texto = textoDoAviso(ev);
    const raiz = el("mem-aviso");
    if (!texto || !raiz) return false;
    const chave = `${ev.relPath ?? ""}|${ev.op ?? ""}`;
    const t = agora();
    if (chave === ultimo.chave && t - ultimo.em < AVISO_REPETIDO_MS) return false;
    ultimo = { chave, em: t };
    const b = botao("", "mem-aviso", () => {
      esconder();
      aoAbrir(ev);
    });
    b.dataset.op = String(ev.op ?? "create");
    b.title = "Abrir na tela Memória";
    const ico = no("span", "mem-aviso-ico");
    ico.insertAdjacentHTML("afterbegin", SVG_MARCADOR);
    b.append(ico, no("span", "mem-aviso-txt", texto), no("span", "mem-aviso-lk", "Ver"));
    b.addEventListener("mouseenter", () => clearTimeout(timer));
    b.addEventListener("mouseleave", agendar);
    b.addEventListener("focus", () => clearTimeout(timer));
    b.addEventListener("blur", agendar);
    raiz.replaceChildren(b);
    agendar();
    return true;
  }

  return { mostrar, esconder };
}
