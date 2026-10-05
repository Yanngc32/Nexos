import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { mdToHtml } from "../../desktop/markdown.js";

/**
 * Visualizador de arquivo da conversa: o que o "Abrir no preview" mostra no lugar do arquivo cru.
 * Markdown formatado, CSV/planilha como tabela (no jeito do DataFrame do pandas no Colab: índice,
 * tipo da coluna, ordenar, filtrar, paginar), JSON e código legíveis.
 *
 * O daemon LÊ o arquivo (aqui) e monta uma página autocontida: o JS e o CSS do cliente moram em
 * `apps/daemon/visualizador/` e vão embutidos no HTML — o app instalado não serve `/app/*`, e a
 * página roda em origem opaca (CSP `sandbox`), sem enxergar o motor.
 */

export type Celula = string | number | boolean | null;
export type Planilha = { nome: string; colunas: string[]; linhas: Celula[][]; total: number; decimal?: "," | "." };
export type DadosDoVisualizador =
  | { tipo: "markdown"; html: string; texto: string }
  | { tipo: "tabela"; planilhas: Planilha[] }
  | { tipo: "json"; texto: string; tabela?: Planilha }
  | { tipo: "codigo"; texto: string; linguagem: string };

/** Texto acima disso a página fica pesada demais pra valer a pena: vai cru. */
const MAX_TEXTO = 4 * 1024 * 1024;
/** Linhas por planilha que vão pra página (o resto, só baixando). */
export const MAX_LINHAS = 20_000;
const MAX_COLUNAS = 300;
/** xlsx é zip: o XML de uma aba pode ser 10× o arquivo. Acima disso não abre aqui. */
const MAX_PLANILHA_BYTES = 30 * 1024 * 1024;

const EXT_CODIGO = new Set(
  "txt log xml yaml yml ts tsx js jsx mjs cjs css scss less py rb php go rs java kt c h cpp hpp cs sh bash ps1 bat cmd sql toml ini cfg conf env gitignore".split(" "),
);

/** Bytes → texto: UTF-8 quando é; senão Windows-1252 (CSV exportado do Excel em português). */
export function decodificar(buf: Buffer): string {
  let texto: string;
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      texto = new TextDecoder("windows-1252").decode(buf);
    } catch {
      texto = buf.toString("latin1");
    }
  }
  return texto.replace(/^﻿/, "");
}

/**
 * Separador mais provável: `,` `;` tab ou `|`. Lê a amostra com o parser de verdade (campo entre
 * aspas pode ter quebra de linha) e fica com o que mais deixa linhas da largura do cabeçalho.
 */
export function detectarSeparador(texto: string): string {
  const amostra = texto.slice(0, 50_000);
  let melhor = ",";
  let nota = -1;
  for (const sep of [",", ";", "\t", "|"]) {
    const { linhas } = lerCsv(amostra, sep, 30);
    const largura = linhas[0]?.length ?? 0;
    if (largura < 2) continue;
    const iguais = linhas.slice(1).filter((l) => l.length === largura).length;
    const n = iguais * 1000 + largura;
    if (n > nota) {
      nota = n;
      melhor = sep;
    }
  }
  return melhor;
}

/** CSV de verdade (RFC 4180): aspas, aspas dobradas, quebra de linha dentro de campo. */
export function lerCsv(texto: string, sep = detectarSeparador(texto), maxLinhas = MAX_LINHAS + 1): { linhas: string[][]; total: number } {
  const linhas: string[][] = [];
  let linha: string[] = [];
  let campo = "";
  let aspas = false;
  let total = 0;
  const fecharLinha = () => {
    linha.push(campo);
    campo = "";
    if (!(linha.length === 1 && linha[0] === "")) {
      total++;
      if (linhas.length < maxLinhas) linhas.push(linha);
    }
    linha = [];
  };
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += ch;
    } else if (ch === '"' && campo === "") aspas = true;
    else if (ch === sep) {
      linha.push(campo);
      campo = "";
    } else if (ch === "\n") fecharLinha();
    else if (ch === "\r") {
      if (texto[i + 1] !== "\n") fecharLinha();
    } else campo += ch;
  }
  if (campo !== "" || linha.length) fecharLinha();
  return { linhas, total };
}

/** Nomes de coluna como o pandas: vazio vira `Unnamed: i`, repetido ganha `.1`, `.2`… */
function nomesDeColuna(cabecalho: Celula[], largura: number): string[] {
  const vistos = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < largura; i++) {
    const bruto = cabecalho[i];
    let nome = bruto === null || bruto === undefined || String(bruto).trim() === "" ? `Unnamed: ${i}` : String(bruto).trim();
    const n = vistos.get(nome) ?? 0;
    vistos.set(nome, n + 1);
    if (n > 0) nome = `${nome}.${n}`;
    out.push(nome);
  }
  return out;
}

/** Primeira linha é o cabeçalho (como `pd.read_csv`/`read_excel`); célula vazia vira nulo (NaN). */
function planilhaDe(nome: string, grade: Celula[][], totalDeLinhas: number, decimal?: "," | "."): Planilha {
  const [cab = [], ...resto] = grade;
  const largura = Math.min(MAX_COLUNAS, Math.max(cab.length, ...resto.slice(0, 2000).map((l) => l.length), 0));
  const colunas = nomesDeColuna(cab, largura);
  const linhas = resto.slice(0, MAX_LINHAS).map((l) => {
    const out: Celula[] = [];
    for (let i = 0; i < largura; i++) {
      const v = l[i];
      out.push(v === undefined || v === "" ? null : v);
    }
    return out;
  });
  return { nome, colunas, linhas, total: Math.max(0, totalDeLinhas - 1), ...(decimal ? { decimal } : {}) };
}

/* ---------- xlsx ---------- */

function desescaparXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Texto de um nó com runs (`<r><t>…</t></r>`), sem a leitura fonética (`<rPh>`). */
function textoDosRuns(xml: string): string {
  const semFonetica = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of semFonetica.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1];
  return desescaparXml(out);
}

function colunaDaRef(letras: string): number {
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Formatos embutidos do Excel que são data/hora. */
const NUMFMT_DATA = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function formatoEhData(codigo: string): boolean {
  // tira texto entre aspas, cor/condição entre colchetes e escapes antes de procurar d/m/y/h/s
  const limpo = codigo.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(limpo) && !/^general$/i.test(limpo.trim());
}

/** Número de série do Excel → "AAAA-MM-DD" (com hora se tiver). */
function serialParaData(serial: number, base1904: boolean): string {
  const dias = serial + (base1904 ? 1462 : 0);
  const ms = Math.round((dias - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}

/**
 * xlsx/xlsm → abas (valores, não fórmulas). Só o que o visualizador precisa: textos
 * compartilhados, número, booleano, data pelo estilo da célula. Aba oculta fica de fora.
 */
export function lerXlsx(buf: Buffer): Planilha[] {
  const zip = new AdmZip(buf);
  const ler = (nome: string): string => {
    const e = zip.getEntry(nome);
    if (!e) return "";
    if (e.header.size > MAX_PLANILHA_BYTES) throw new Error("planilha grande demais pra abrir aqui");
    return e.getData().toString("utf8");
  };
  const workbook = ler("xl/workbook.xml");
  if (!workbook) throw new Error("não é uma planilha xlsx");
  const base1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbook);

  const alvos = new Map<string, string>();
  for (const m of ler("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1] ?? "")?.[1];
    const alvo = /\bTarget="([^"]+)"/.exec(m[1] ?? "")?.[1];
    if (id && alvo) alvos.set(id, alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo}`);
  }

  const compartilhados: string[] = [];
  for (const m of ler("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) compartilhados.push(textoDosRuns(m[1] ?? ""));

  const estilos = ler("xl/styles.xml");
  const formatos = new Map<number, string>();
  for (const m of estilos.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) formatos.set(Number(m[1]), desescaparXml(m[2] ?? ""));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(estilos)?.[1] ?? "";
  const estiloEhData: boolean[] = [];
  for (const m of xfs.matchAll(/<xf\b([^>]*?)\/?>/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(m[1] ?? "")?.[1] ?? 0);
    const custom = formatos.get(id);
    estiloEhData.push(NUMFMT_DATA.has(id) || (custom !== undefined && formatoEhData(custom)));
  }

  const abas: Planilha[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    if (/\bstate="(hidden|veryHidden)"/.test(attrs)) continue;
    const nome = desescaparXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Planilha ${abas.length + 1}`);
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1] ?? /\bid="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const xml = ler(alvos.get(rid) ?? "");
    if (!xml) continue;
    const grade: Celula[][] = [];
    let total = 0;
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const corpo = r[1] ?? "";
      if (!corpo) continue;
      const linha: Celula[] = [];
      let col = 0;
      for (const c of corpo.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1] ?? "";
        const ref = /\br="([A-Z]+)\d+"/.exec(a)?.[1];
        if (ref) col = colunaDaRef(ref);
        const tipo = /\bt="(\w+)"/.exec(a)?.[1] ?? "n";
        const conteudo = c[2] ?? "";
        const v = /<v>([\s\S]*?)<\/v>/.exec(conteudo)?.[1];
        let valor: Celula = null;
        if (tipo === "s" && v !== undefined) valor = compartilhados[Number(v)] ?? null;
        else if (tipo === "inlineStr") valor = textoDosRuns(conteudo);
        else if (tipo === "b" && v !== undefined) valor = v === "1";
        else if ((tipo === "str" || tipo === "e") && v !== undefined) valor = desescaparXml(v);
        else if (v !== undefined && v !== "") {
          const n = Number(v);
          const estilo = Number(/\bs="(\d+)"/.exec(a)?.[1] ?? -1);
          valor = Number.isFinite(n) ? (estiloEhData[estilo] ? serialParaData(n, base1904) : n) : desescaparXml(v);
        }
        if (col < MAX_COLUNAS) linha[col] = valor === "" ? null : valor;
        col++;
      }
      if (!linha.some((x) => x !== null && x !== undefined)) continue;
      total++;
      if (grade.length <= MAX_LINHAS) grade.push(Array.from({ length: linha.length }, (_x, i) => linha[i] ?? null));
    }
    abas.push(planilhaDe(nome, grade, total));
  }
  if (!abas.length) throw new Error("planilha sem abas visíveis");
  return abas;
}

/* ---------- json ---------- */

function ehObjetoSimples(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Lista de objetos vira tabela, como `pd.DataFrame(registros)`. */
function tabelaDoJson(v: unknown): Planilha | undefined {
  if (!Array.isArray(v) || !v.length || !v.every(ehObjetoSimples)) return undefined;
  const chaves: string[] = [];
  const vistas = new Set<string>();
  for (const o of v.slice(0, 2000)) {
    for (const k of Object.keys(o)) {
      if (!vistas.has(k) && chaves.length < MAX_COLUNAS) {
        vistas.add(k);
        chaves.push(k);
      }
    }
  }
  const linhas = v.slice(0, MAX_LINHAS).map((o) =>
    chaves.map((k): Celula => {
      const x = o[k];
      if (x === undefined || x === null) return null;
      if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return x;
      return JSON.stringify(x);
    }),
  );
  return { nome: "dados", colunas: chaves, linhas, total: v.length };
}

/* ---------- entrada ---------- */

/**
 * O que o visualizador mostra pra este arquivo; `null` = vai cru (imagem, PDF, vídeo, página,
 * binário) — o navegador já mostra bem, ou não há o que mostrar.
 */
export function dadosDoVisualizador(buf: Buffer, ext: string): DadosDoVisualizador | null {
  const e = ext.toLowerCase();
  if (e === "xlsx" || e === "xlsm") {
    if (buf.length > MAX_PLANILHA_BYTES) return null;
    try {
      return { tipo: "tabela", planilhas: lerXlsx(buf) };
    } catch {
      return null;
    }
  }
  const texto = ["md", "markdown", "csv", "tsv", "json", ...EXT_CODIGO].includes(e) && buf.length <= MAX_TEXTO ? decodificar(buf) : null;
  if (texto === null) return null;
  if (e === "md" || e === "markdown") return { tipo: "markdown", html: mdToHtml(texto, { titulos: "documento" }), texto };
  if (e === "csv" || e === "tsv") {
    const sep = e === "tsv" ? "\t" : detectarSeparador(texto);
    const { linhas, total } = lerCsv(texto, sep);
    return { tipo: "tabela", planilhas: [planilhaDe("dados", linhas, total, sep === ";" ? "," : ".")] };
  }
  if (e === "json") {
    try {
      const v: unknown = JSON.parse(texto);
      const tabela = tabelaDoJson(v);
      return { tipo: "json", texto: JSON.stringify(v, null, 2), ...(tabela ? { tabela } : {}) };
    } catch {
      return { tipo: "codigo", texto, linguagem: "json" };
    }
  }
  return { tipo: "codigo", texto, linguagem: e };
}

/* ---------- página ---------- */

const aqui = dirname(fileURLToPath(import.meta.url));
/** `src/` e `dist/` ficam na mesma profundidade: a pasta do cliente é irmã das duas. */
const pastaDoCliente = () => process.env.NEXOS_VISUALIZADOR || join(aqui, "..", "visualizador");

let cliente: { js: string; css: string } | null = null;
function arquivosDoCliente(): { js: string; css: string } {
  if (!cliente || process.env.NEXOS_DEV === "1") {
    const dir = pastaDoCliente();
    cliente = { js: readFileSync(join(dir, "visualizador.js"), "utf8"), css: readFileSync(join(dir, "visualizador.css"), "utf8") };
  }
  return cliente;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** Só o que a página pode carregar: script e estilo embutidos, imagem em data:. */
export const CSP_DO_VISUALIZADOR =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src 'none'; " +
  "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export function paginaDoVisualizador(
  dados: DadosDoVisualizador,
  o: { nome: string; bytes: number; hrefBaixar: string; cor?: string },
): string {
  const { js, css } = arquivosDoCliente();
  // `<` escapado: nada do arquivo fecha o <script> da página
  const json = JSON.stringify(dados).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const cor = o.cor && /^#[0-9a-f]{6}$/i.test(o.cor) ? `<style>:root{--accent:${o.cor}}</style>` : "";
  const ext = /\.([a-z0-9]{1,6})$/i.exec(o.nome)?.[1]?.toUpperCase() ?? "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.nome)}</title>
<style>${css}</style>${cor}
</head>
<body>
<header class="vz-topo">
  <span class="vz-selo" aria-hidden="true">${esc(ext || "ARQ")}</span>
  <div class="vz-id"><h1 class="vz-nome" title="${esc(o.nome)}">${esc(o.nome)}</h1><span class="vz-meta">${esc(fmtBytes(o.bytes))}</span></div>
  <nav class="vz-acoes">
    <a class="vz-btn" href="${esc(o.hrefBaixar)}">Baixar</a>
  </nav>
</header>
<main id="vz" class="vz-corpo"></main>
<script type="application/json" id="vz-dados">${json}</script>
<script type="module">
${js}
montar(document.getElementById("vz"), JSON.parse(document.getElementById("vz-dados").textContent));
</script>
</body>
</html>`;
}
