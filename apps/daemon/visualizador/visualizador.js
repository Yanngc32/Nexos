/**
 * Cliente do visualizador de arquivo (página montada por src/visualizador.ts). Vai EMBUTIDO no
 * HTML: a página roda em origem opaca (CSP `sandbox`), sem import nem fetch — tudo que ela
 * precisa chega no JSON `#vz-dados`.
 *
 * Tabela no jeito do DataFrame do pandas no Colab: índice original à esquerda, tipo da coluna
 * (int64, float64, object…) no cabeçalho, nulo como NaN, forma "linhas × colunas" — e o que o
 * data_table interativo do Colab soma: ordenar, filtrar e paginar.
 *
 * As funções puras ficam exportadas pra teste (test/visualizador-cliente.test.js no desktop).
 */

const NUM_PONTO = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const NUM_VIRGULA = /^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const DATA_BR = /^(\d{2})\/(\d{2})\/(\d{4})( \d{2}:\d{2}(:\d{2})?)?$/;
const BOOL = /^(true|false|verdadeiro|falso)$/i;

export const POR_PAGINA = [25, 50, 100, 500];

const vazio = (v) => v === null || v === undefined || v === "";

/** Número de uma célula; `decimal` "," = arquivo brasileiro (1.234,56). `null` = não é número. */
export function numeroDe(v, decimal = ".") {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (decimal === "," && NUM_VIRGULA.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));
  return NUM_PONTO.test(t) ? Number(t) : null;
}

/** dtype no vocabulário do pandas, olhando os valores não nulos. */
export function tipoDaColuna(valores, decimal = ".") {
  let n = 0;
  let num = true;
  let int = true;
  let bool = true;
  let data = true;
  for (const v of valores) {
    if (vazio(v)) continue;
    n++;
    if (typeof v === "boolean") {
      num = false;
      data = false;
    } else if (typeof v === "number") {
      bool = false;
      data = false;
      if (!Number.isInteger(v)) int = false;
    } else {
      const s = String(v).trim();
      if (bool && !BOOL.test(s)) bool = false;
      if (data && !DATA_ISO.test(s) && !DATA_BR.test(s)) data = false;
      if (num) {
        const x = numeroDe(s, decimal);
        if (x === null) num = false;
        else if (!Number.isInteger(x) || (decimal === "," ? s.includes(",") : /[.eE]/.test(s))) int = false;
      }
    }
    if (!num && !bool && !data) break;
  }
  if (!n) return "object";
  if (num) return int ? "int64" : "float64";
  if (bool) return "bool";
  if (data) return "datetime64";
  return "object";
}

export const ehNumerico = (tipo) => tipo === "int64" || tipo === "float64";

function chaveDeData(s) {
  const br = DATA_BR.exec(s);
  return br ? `${br[3]}-${br[2]}-${br[1]}${br[4] ?? ""}` : s;
}

const colador = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });

/** Índices em ordem pela coluna; nulo sempre por último, empate mantém a ordem original. */
export function ordenar(indices, linhas, col, dir, tipo, decimal = ".") {
  const chave = (v) => {
    if (vazio(v)) return null;
    if (ehNumerico(tipo)) return numeroDe(v, decimal);
    if (tipo === "bool") return v === true || /^(true|verdadeiro)$/i.test(String(v)) ? 1 : 0;
    if (tipo === "datetime64") return chaveDeData(String(v));
    return String(v);
  };
  const pares = indices.map((i) => [i, chave(linhas[i][col])]);
  pares.sort((a, b) => {
    const x = a[1];
    const y = b[1];
    if (x === null && y === null) return a[0] - b[0];
    if (x === null) return 1;
    if (y === null) return -1;
    const c = typeof x === "string" ? colador.compare(x, y) : x - y;
    return (dir === "desc" ? -c : c) || a[0] - b[0];
  });
  return pares.map((p) => p[0]);
}

const semAcento = (s) =>
  String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Linhas com o termo em alguma célula (sem diferença de maiúscula e acento). */
export function filtrar(linhas, termo) {
  const t = semAcento(termo.trim());
  const todas = linhas.map((_l, i) => i);
  if (!t) return todas;
  return todas.filter((i) => linhas[i].some((v) => !vazio(v) && semAcento(v).includes(t)));
}

/**
 * Casas decimais de uma coluna float, como o pandas (`display.precision` 6): a coluna inteira
 * com o mesmo tanto, o mínimo que mostra todo valor — [1.7, 2.25] → 2 casas ("1.70", "2.25").
 */
export function casasDaColuna(valores, decimal = ".") {
  let casas = 1;
  for (const v of valores) {
    const n = numeroDe(v, decimal);
    if (n === null || !Number.isFinite(n)) continue;
    const frac = String(Number(n.toFixed(6))).split(".")[1] ?? "";
    if (frac.length > casas) casas = frac.length;
    if (casas >= 6) return 6;
  }
  return casas;
}

/** Float com as casas da coluna, no separador do arquivo. */
export function fmtFloat(n, casas, decimal = ".") {
  const t = n.toFixed(casas);
  return decimal === "," ? t.replace(".", ",") : t;
}

/** Como o pandas escreve: NaN, True/False; float com até 6 casas. */
export function textoDaCelula(v) {
  if (vazio(v)) return "NaN";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  return String(v);
}

export const fmtInt = (n) => new Intl.NumberFormat("pt-BR").format(n);

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function el(tag, cls, texto) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

/** Botões segmentados ("Formatado | Texto"): troca qual painel aparece. */
function alternador(opcoes, aoTrocar) {
  const grupo = el("div", "vz-seg");
  grupo.setAttribute("role", "tablist");
  const botoes = opcoes.map((rotulo, i) => {
    const b = el("button", "vz-seg-btn", rotulo);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => marcar(i));
    grupo.append(b);
    return b;
  });
  function marcar(i) {
    botoes.forEach((b, j) => b.setAttribute("aria-selected", String(i === j)));
    aoTrocar(i);
  }
  return { grupo, marcar };
}

/* ---------- código / texto ---------- */

/** Chave, texto, número e literal do JSON em cor — sobre o texto JÁ escapado. */
function realceJson(texto) {
  return esc(texto).replace(/(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g, (m, str, doisPontos, lit, num) => {
    if (str) return doisPontos ? `<span class="vz-j-chave">${str}</span>${doisPontos}` : `<span class="vz-j-texto">${str}</span>`;
    if (lit) return `<span class="vz-j-lit">${lit}</span>`;
    if (num) return `<span class="vz-j-num">${num}</span>`;
    return m;
  });
}

function painelDeCodigo(texto, linguagem) {
  const caixa = el("div", "vz-codigo");
  const linhas = texto.split("\n");
  if (linhas.length > 1 && linhas[linhas.length - 1] === "") linhas.pop();
  const calha = el("pre", "vz-calha");
  calha.setAttribute("aria-hidden", "true");
  calha.textContent = linhas.map((_l, i) => i + 1).join("\n");
  const pre = el("pre", "vz-texto");
  // realce só no JSON e só até onde não pesa
  if (linguagem === "json" && texto.length < 400_000) pre.innerHTML = realceJson(linhas.join("\n"));
  else pre.textContent = linhas.join("\n");
  caixa.append(calha, pre);
  return caixa;
}

/* ---------- markdown ---------- */

function painelDeMarkdown(html) {
  const art = el("article", "vz-md");
  art.innerHTML = html;
  for (const a of art.querySelectorAll("a[href]")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return art;
}

/* ---------- tabela ---------- */

function painelDeTabela(planilhas) {
  const raiz = el("section", "vz-tab");
  const barra = el("div", "vz-tab-barra");
  const abas = el("div", "vz-abas");
  abas.setAttribute("role", "tablist");
  const filtro = el("input", "vz-filtro");
  filtro.type = "search";
  filtro.placeholder = "Filtrar linhas…";
  filtro.setAttribute("aria-label", "Filtrar linhas");
  const forma = el("span", "vz-forma");
  barra.append(abas, filtro, forma);

  const rolagem = el("div", "vz-grade-rolagem");
  const tabela = el("table", "vz-grade");
  const thead = el("thead");
  const tbody = el("tbody");
  tabela.append(thead, tbody);
  rolagem.append(tabela);

  const rodape = el("div", "vz-paginacao");
  const rotPor = el("label", "vz-por");
  const select = el("select");
  for (const n of POR_PAGINA) {
    const o = el("option", "", String(n));
    o.value = String(n);
    select.append(o);
  }
  select.value = "50";
  rotPor.append("Linhas por página", select);
  const faixa = el("span", "vz-faixa");
  const ant = el("button", "vz-pag", "‹");
  ant.type = "button";
  ant.setAttribute("aria-label", "Página anterior");
  const prox = el("button", "vz-pag", "›");
  prox.type = "button";
  prox.setAttribute("aria-label", "Próxima página");
  const aviso = el("span", "vz-aviso");
  rodape.append(aviso, rotPor, faixa, ant, prox);
  raiz.append(barra, rolagem, rodape);

  const st = { aba: 0, ordem: null, termo: "", pagina: 0, porPagina: 50, tipos: [], casas: [], visiveis: [] };

  function planilha() {
    return planilhas[st.aba];
  }

  function recalcular() {
    const p = planilha();
    let idx = filtrar(p.linhas, st.termo);
    if (st.ordem) idx = ordenar(idx, p.linhas, st.ordem.col, st.ordem.dir, st.tipos[st.ordem.col], p.decimal);
    st.visiveis = idx;
    const paginas = Math.max(1, Math.ceil(idx.length / st.porPagina));
    if (st.pagina >= paginas) st.pagina = paginas - 1;
  }

  function pintarCabecalho() {
    const p = planilha();
    const tr = el("tr");
    const canto = el("th", "vz-idx");
    canto.scope = "col";
    tr.append(canto);
    p.colunas.forEach((nome, c) => {
      const th = el("th");
      th.scope = "col";
      const tipo = st.tipos[c];
      if (ehNumerico(tipo)) th.classList.add("vz-num");
      const dir = st.ordem?.col === c ? st.ordem.dir : null;
      th.setAttribute("aria-sort", dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none");
      const b = el("button", "vz-col");
      b.type = "button";
      b.title = `${nome} — clique pra ordenar`;
      const n = el("span", "vz-col-nome", nome);
      const t = el("span", "vz-dtype", tipo);
      const seta = el("span", "vz-seta", dir === "asc" ? "↑" : dir === "desc" ? "↓" : "↕");
      seta.setAttribute("aria-hidden", "true");
      if (dir) seta.dataset.on = "1";
      b.append(n, t, seta);
      b.addEventListener("click", () => {
        // asc → desc → sem ordem
        st.ordem = !dir ? { col: c, dir: "asc" } : dir === "asc" ? { col: c, dir: "desc" } : null;
        st.pagina = 0;
        recalcular();
        pintarCabecalho();
        pintarCorpo();
      });
      th.append(b);
      tr.append(th);
    });
    thead.replaceChildren(tr);
  }

  function pintarCorpo() {
    const p = planilha();
    const ini = st.pagina * st.porPagina;
    const fatia = st.visiveis.slice(ini, ini + st.porPagina);
    const num = st.tipos.map(ehNumerico);
    let html = "";
    for (const i of fatia) {
      html += `<tr><th scope="row" class="vz-idx">${i}</th>`;
      const linha = p.linhas[i];
      for (let c = 0; c < p.colunas.length; c++) {
        const v = linha[c];
        const n = st.tipos[c] === "float64" && !vazio(v) ? numeroDe(v, p.decimal) : null;
        const t = n !== null ? fmtFloat(n, st.casas[c], p.decimal) : textoDaCelula(v);
        const cls = [num[c] ? "vz-num" : "", vazio(v) ? "vz-nan" : ""].filter(Boolean).join(" ");
        const longo = t.length > 60 ? ` title="${esc(t)}"` : "";
        html += `<td${cls ? ` class="${cls}"` : ""}${longo}>${esc(t)}</td>`;
      }
      html += "</tr>";
    }
    tbody.innerHTML = html || `<tr><td class="vz-sem" colspan="${p.colunas.length + 1}">Nenhuma linha com “${esc(st.termo)}”.</td></tr>`;
    const total = st.visiveis.length;
    faixa.textContent = total ? `${fmtInt(ini + 1)}–${fmtInt(ini + fatia.length)} de ${fmtInt(total)}` : "0 de 0";
    ant.disabled = st.pagina === 0;
    prox.disabled = ini + st.porPagina >= total;
    const filtradas = st.termo.trim() ? ` · ${fmtInt(total)} no filtro` : "";
    forma.textContent = `${fmtInt(p.total)} linhas × ${fmtInt(p.colunas.length)} colunas${filtradas}`;
    aviso.textContent =
      p.total > p.linhas.length ? `Mostrando as primeiras ${fmtInt(p.linhas.length)} de ${fmtInt(p.total)} linhas — baixe pra ver tudo.` : "";
    rolagem.scrollTop = 0;
  }

  function trocarAba(a) {
    st.aba = a;
    st.ordem = null;
    st.pagina = 0;
    const p = planilha();
    st.tipos = p.colunas.map((_n, c) => tipoDaColuna(p.linhas.map((l) => l[c]), p.decimal));
    st.casas = st.tipos.map((t, c) => (t === "float64" ? casasDaColuna(p.linhas.map((l) => l[c]), p.decimal) : 0));
    for (const [j, b] of [...abas.children].entries()) b.setAttribute("aria-selected", String(j === a));
    recalcular();
    pintarCabecalho();
    pintarCorpo();
  }

  if (planilhas.length > 1) {
    planilhas.forEach((p, a) => {
      const b = el("button", "vz-aba", p.nome);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => trocarAba(a));
      abas.append(b);
    });
  } else abas.hidden = true;

  let espera = 0;
  filtro.addEventListener("input", () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      st.termo = filtro.value;
      st.pagina = 0;
      recalcular();
      pintarCorpo();
    }, 120);
  });
  select.addEventListener("change", () => {
    st.porPagina = Number(select.value);
    st.pagina = 0;
    recalcular();
    pintarCorpo();
  });
  ant.addEventListener("click", () => {
    st.pagina = Math.max(0, st.pagina - 1);
    pintarCorpo();
  });
  prox.addEventListener("click", () => {
    st.pagina += 1;
    recalcular();
    pintarCorpo();
  });

  trocarAba(0);
  return raiz;
}

/* ---------- entrada ---------- */

/** Monta o visualizador em `raiz` a partir do que o daemon leu do arquivo. */
export function montar(raiz, dados) {
  raiz.replaceChildren();
  if (dados.tipo === "tabela") {
    raiz.classList.add("vz-corpo-tabela");
    raiz.append(painelDeTabela(dados.planilhas));
    return;
  }
  if (dados.tipo === "markdown" || (dados.tipo === "json" && dados.tabela)) {
    const ehMd = dados.tipo === "markdown";
    const barra = el("div", "vz-sub");
    const palco = el("div", "vz-palco");
    const paineis = ehMd
      ? [() => painelDeMarkdown(dados.html), () => painelDeCodigo(dados.texto, "md")]
      : [() => painelDeTabela([dados.tabela]), () => painelDeCodigo(dados.texto, "json")];
    const feitos = [];
    const { grupo, marcar } = alternador(ehMd ? ["Formatado", "Texto"] : ["Tabela", "JSON"], (i) => {
      feitos[i] ??= paineis[i]();
      palco.replaceChildren(feitos[i]);
      raiz.classList.toggle("vz-corpo-tabela", !ehMd && i === 0);
    });
    barra.append(grupo);
    raiz.append(barra, palco);
    marcar(0);
    return;
  }
  raiz.append(painelDeCodigo(dados.texto, dados.linguagem));
}
