import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectDir, projectDirSemCriar, projetosRoot } from "./projeto-dir.ts";
import {
  ALINHAMENTOS,
  cardsDeFundamentos,
  garantirKit,
  htmlDoTipo,
  IDS_FUNDAMENTOS,
  KIT_CSS,
  LARGURAS,
  TIPOS,
  varsDoTipo,
  type Alinhamento,
  type CardFundamento,
  type ConfigFundamento,
  type Largura,
  type TipoCard,
  type TipoDeToken,
} from "./ds-kit.ts";

/**
 * Design system (DS) do projeto — o que a view "Design System" do desktop mostra e edita.
 * Spec: docs/superpowers/specs/2026-09-22-canvas-design-system-design.md.
 *
 * Os ARQUIVOS são a fonte da verdade e moram na pasta do projeto DO NEXOS (`projectDir`, a mesma
 * de memória, tarefas e repo map — dentro de `projetosDir`, que a pessoa já escolheu), em
 * `design-system/<id>/`. Sem seletor de pasta: o lugar é sempre esse, e sincroniza entre máquinas
 * junto com o resto da pasta do projeto. O agente edita com as ferramentas nativas dele
 * (Write/Edit/shell), sem ferramenta MCP própria. Aqui só fica o que o daemon precisa pra servir o
 * Canvas: ler, gravar com checagem de conflito, virar tokens em CSS e passar o lint.
 *
 * Imagem relativa num card (o logo do projeto) é relativa à RAIZ DO PROJETO (repo), que o Canvas
 * usa como `<base>` — `public/logo.svg`, não um caminho que dependa de onde o DS mora.
 */

export type LintItem = { regra: string; msg: string; trecho?: string };

/**
 * `mocksDe`: é um PAINEL DE MOCKS do DS com esse id — a pasta só guarda as telas (cards + meta);
 * tokens, DESIGN.md e kit vêm do DS de origem na leitura, então o painel nunca repete (nem
 * desatualiza) o design system.
 */
export type DsSistema = { id: string; nome: string; mocksDe?: string };

export type DsCard = {
  id: string;
  titulo: string;
  subtitulo?: string;
  secao: string;
  html: string;
  hash: string;
  lint: LintItem[];
  /** Sliders que o card declarou (`data-ds-controles`) — ver `controlesDoCard`. */
  controles: Controle[];
  /** Tipo do card (ver `TIPOS` em ds-kit.ts) e quanto da linha ele ocupa no board. */
  tipo?: TipoCard;
  largura?: Largura;
};

export type DsSecao = { id: string; titulo: string; alinhamento?: Alinhamento };

export type DsVar = { nome: string; caminho: string; tipo?: string; valor: string; bruto: unknown };

export type DsCompleto = DsSistema & {
  /** Onde os arquivos do DS estão (pra mostrar e pro observador). */
  pastaAbs: string;
  /** Raiz do projeto — o Canvas usa como `<base>` pra imagem relativa (logo do projeto). */
  projetoAbs: string;
  tokens: unknown;
  tokensHash: string;
  tokensLint: LintItem[];
  css: string;
  vars: DsVar[];
  designMd: string;
  secoes: DsSecao[];
  cards: DsCard[];
  /** Cards gerados dos tokens (sem arquivo), na ordem de `meta.fundamentos`. */
  fundamentos: CardFundamento[];
  /** Classes do kit que o Canvas injeta em todo card (ver ds-kit.ts). */
  kitCss: string;
  /** Painel de mocks: o DS de onde vêm os tokens e as regras (ver `DsSistema.mocksDe`). */
  origem?: DsSistema;
};

/** `oficial`: o DS do projeto — o que as conversas seguem e de onde saem os painéis de mocks. */
export type DsEstado = { sistemas: DsSistema[]; ativo: string | null; oficial: string | null; ds: DsCompleto | null };

function erro(msg: string, status = 400): Error {
  return Object.assign(new Error(msg), { status });
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function hashDe(texto: string): string {
  return createHash("sha1").update(texto).digest("hex");
}

/* ---------------------------------------------------------------------------
 * Onde mora: <projectDir>/design-system.json (ponteiro) e <projectDir>/design-system/<id>/
 * ------------------------------------------------------------------------- */

type Ponteiro = { sistemas: DsSistema[]; ativo: string | null; oficial?: string | null };

const NOME_MOCKS = "Mocks";

function raizDoProjetoNexos(projectPath: string, home: string, criar: boolean): string {
  return criar ? projectDir(projectPath, home) : projectDirSemCriar(projectPath, home);
}

function ponteiroPath(projectPath: string, home: string, criar: boolean): string {
  return join(raizDoProjetoNexos(projectPath, home, criar), "design-system.json");
}

function lerPonteiro(projectPath: string, home: string): Ponteiro {
  try {
    const bruto = JSON.parse(readFileSync(ponteiroPath(projectPath, home, false), "utf8")) as Partial<Ponteiro>;
    // id é nome de pasta: o que não passa no formato (arquivo editado à mão) some da lista, e o
    // que não tem pasta no disco também (apagada à mão, ou ponteiro de um layout antigo)
    const raiz = join(raizDoProjetoNexos(projectPath, home, false), "design-system");
    const sistemas = Array.isArray(bruto.sistemas)
      ? bruto.sistemas
          .filter((s): s is DsSistema => !!s && typeof s.id === "string" && ID_RE.test(s.id) && typeof s.nome === "string")
          .filter((s) => existsSync(join(raiz, s.id)))
          .map((s) => ({
            id: s.id,
            nome: s.nome,
            ...(typeof s.mocksDe === "string" && ID_RE.test(s.mocksDe) && s.mocksDe !== s.id ? { mocksDe: s.mocksDe } : {}),
          }))
      : [];
    const ativo = sistemas.some((s) => s.id === bruto.ativo) ? (bruto.ativo as string) : (sistemas[0]?.id ?? null);
    const oficial = sistemas.some((s) => s.id === bruto.oficial && !s.mocksDe) ? (bruto.oficial as string) : null;
    return { sistemas, ativo, oficial };
  } catch {
    return { sistemas: [], ativo: null, oficial: null };
  }
}

/**
 * DS oficial do projeto: o escolhido; sem escolha, o ativo (se não for painel de mocks) ou o
 * primeiro DS de verdade — projeto de antes da escolha existir segue igual.
 */
function oficialDe(p: Ponteiro): DsSistema | null {
  const reais = p.sistemas.filter((s) => !s.mocksDe);
  const escolhido = reais.find((s) => s.id === p.oficial);
  if (escolhido) return escolhido;
  // DS "Mocks" de antes do painel existir (cópia inteira) nunca vira o oficial por padrão
  const semMocks = reais.filter((s) => s.nome.trim().toLowerCase() !== NOME_MOCKS.toLowerCase());
  const candidatos = semMocks.length ? semMocks : reais;
  return candidatos.find((s) => s.id === p.ativo) ?? candidatos[0] ?? null;
}

/** Sem oficial escolhido, fixa o de agora antes de trocar/criar — senão o oficial seguiria o ativo. */
function comOficialFixo(p: Ponteiro): Ponteiro {
  return p.oficial ? p : { ...p, oficial: oficialDe(p)?.id ?? null };
}

function salvarPonteiro(projectPath: string, home: string, p: Ponteiro): void {
  escreverAtomico(ponteiroPath(projectPath, home, true), JSON.stringify(p, null, 2));
}

/** Grava por arquivo temporário + rename: o observador nunca vê um arquivo pela metade. */
function escreverAtomico(caminho: string, conteudo: string): void {
  mkdirSync(dirname(caminho), { recursive: true });
  const tmp = `${caminho}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, conteudo, "utf8");
  renameSync(tmp, caminho);
}

export function pastaAbsoluta(projectPath: string, home: string, sistema: DsSistema): string {
  if (!ID_RE.test(sistema.id)) throw erro("id de design system inválido");
  return join(raizDoProjetoNexos(projectPath, home, false), "design-system", sistema.id);
}

/* ---------------------------------------------------------------------------
 * Tokens (W3C DTCG) → CSS
 * ------------------------------------------------------------------------- */

function nomeVar(caminho: string[]): string {
  return `--${caminho.map((p) => p.replace(/[^a-zA-Z0-9-]+/g, "-")).join("-")}`;
}

/** `{color.bg}` → `var(--color-bg)`; o resto passa como está. */
function comReferencias(valor: string): string {
  return valor.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, ref: string) => `var(${nomeVar(ref.split("."))})`);
}

function familia(nome: string): string {
  return /^[a-z-]+$/i.test(nome) ? nome : `"${nome.replace(/"/g, "")}"`;
}

/** Valor DTCG → texto CSS. Composto sem forma conhecida devolve `undefined` e vira sub-variáveis. */
export function valorCss(valor: unknown, tipo?: string): string | undefined {
  if (typeof valor === "string") return comReferencias(valor);
  if (typeof valor === "number") return String(valor);
  if (Array.isArray(valor)) {
    if (tipo === "fontFamily" || valor.every((v) => typeof v === "string")) {
      return valor.map((v) => familia(String(v))).join(", ");
    }
    if (tipo === "shadow") return valor.map((v) => valorCss(v, "shadow")).filter(Boolean).join(", ");
    if (tipo === "cubicBezier" && valor.length === 4 && valor.every((v) => typeof v === "number")) {
      return `cubic-bezier(${valor.join(", ")})`;
    }
    return undefined;
  }
  if (valor && typeof valor === "object") {
    const o = valor as Record<string, unknown>;
    // dimension/duration no formato 2025: { value, unit }
    if ((typeof o.value === "number" || typeof o.value === "string") && typeof o.unit === "string") {
      return `${o.value}${o.unit}`;
    }
    if (tipo === "shadow" && "color" in o) {
      const partes = [o.inset ? "inset" : "", o.offsetX, o.offsetY, o.blur, o.spread, o.color]
        .map((p) => (p === "" || p === undefined ? "" : valorCss(p) ?? ""))
        .filter(Boolean);
      return partes.join(" ");
    }
  }
  return undefined;
}

type Tema = Record<string, string>;

/** Achata a árvore em variáveis. `$extensions["nexos.temas"]` dá o valor por tema. */
function achatar(no: unknown, caminho: string[], tipoHerdado: string | undefined, vars: DsVar[], temas: Map<string, Tema>): void {
  if (!no || typeof no !== "object" || Array.isArray(no)) return;
  const obj = no as Record<string, unknown>;
  const tipo = typeof obj.$type === "string" ? obj.$type : tipoHerdado;
  if ("$value" in obj) {
    const nome = nomeVar(caminho);
    const css = valorCss(obj.$value, tipo);
    if (css !== undefined) {
      vars.push({ nome, caminho: caminho.join("."), tipo, valor: css, bruto: obj.$value });
    } else if (obj.$value && typeof obj.$value === "object" && !Array.isArray(obj.$value)) {
      // composto (typography etc.): uma variável por campo
      for (const [k, v] of Object.entries(obj.$value as Record<string, unknown>)) {
        const sub = valorCss(v);
        if (sub !== undefined) {
          vars.push({ nome: nomeVar([...caminho, k]), caminho: [...caminho, k].join("."), valor: sub, bruto: v });
        }
      }
    }
    const ext = (obj.$extensions as Record<string, unknown> | undefined)?.["nexos.temas"];
    if (ext && typeof ext === "object") {
      for (const [tema, v] of Object.entries(ext as Record<string, unknown>)) {
        const cssTema = valorCss(v, tipo);
        if (cssTema === undefined || !/^[a-z0-9-]+$/i.test(tema)) continue;
        if (!temas.has(tema)) temas.set(tema, {});
        temas.get(tema)![nome] = cssTema;
      }
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    achatar(v, [...caminho, k], tipo, vars, temas);
  }
}

export function tokensParaCss(tokens: unknown): { css: string; vars: DsVar[] } {
  const vars: DsVar[] = [];
  const temas = new Map<string, Tema>();
  achatar(tokens, [], undefined, vars, temas);
  const linhas = [":root {", ...vars.map((v) => `  ${v.nome}: ${v.valor};`), "}"];
  for (const [tema, mapa] of temas) {
    linhas.push(`:root[data-tema="${tema}"] {`, ...Object.entries(mapa).map(([n, v]) => `  ${n}: ${v};`), "}");
  }
  return { css: linhas.join("\n"), vars };
}

/* ---------------------------------------------------------------------------
 * Lint
 * ------------------------------------------------------------------------- */

const COR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;
const HOSTS_PERMITIDOS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function cortar(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

/** Declarações `prop: valor` de um trecho CSS (só o miolo dos blocos, sem seletor). */
function declaracoes(css: string): { prop: string; valor: string }[] {
  const out: { prop: string; valor: string }[] = [];
  const semComentario = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // miolo de cada bloco mais interno; em atributo style o texto inteiro já é miolo
  const miolos = semComentario.includes("{") ? [...semComentario.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!) : [semComentario];
  for (const miolo of miolos) {
    for (const parte of miolo.split(";")) {
      const i = parte.indexOf(":");
      if (i <= 0) continue;
      out.push({ prop: parte.slice(0, i).trim().toLowerCase(), valor: parte.slice(i + 1).trim() });
    }
  }
  return out;
}

function urlExternaProibida(url: string): boolean {
  const u = url.trim().replace(/^['"]|['"]$/g, "");
  if (!u || u.startsWith("#") || /^data:/i.test(u)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//")) {
    try {
      const host = new URL(u.startsWith("//") ? `https:${u}` : u).hostname;
      return !(/^https:/i.test(u) || u.startsWith("//")) || !HOSTS_PERMITIDOS.has(host);
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Regras do card (spec §2). É um lint de texto, não um parser de HTML: pega o que importa pro
 * design system (cor fora de token, JS, recurso externo, token inexistente) com regex conservador
 * — prefere deixar passar um caso raro a acusar falso positivo em HTML válido.
 *
 * Cor literal é acusada em QUALQUER lugar do card: card não define paleta, quem define é o
 * `tokens.json`. (Cor nomeada tipo `white` não é acusada — falso positivo demais em texto.)
 */
/* ---------------------------------------------------------------------------
 * Controles (spec §5): sliders que o card declara pras próprias variáveis
 * ------------------------------------------------------------------------- */

export type Controle =
  | { var: string; rotulo: string; tipo: "range"; min: number; max: number; passo: number; unidade: string; padrao?: number }
  | { var: string; rotulo: string; tipo: "token"; grupo: string; padrao?: string };

const CONTROLES_RE = /<script\b[^>]*\bdata-ds-controles\b[^>]*>([\s\S]*?)<\/script>/i;
const VAR_RE = /^--[a-zA-Z0-9_-]{1,60}$/;
const CONTROLES_MAX = 8;

/**
 * Controles declarados no card (`<script type="application/json" data-ds-controles>`). O que não
 * tiver a forma certa é ignorado: é texto que o agente escreveu, não dá pra confiar cegamente.
 */
export function controlesDoCard(html: string): Controle[] {
  const m = CONTROLES_RE.exec(html);
  if (!m) return [];
  let bruto: unknown;
  try {
    bruto = JSON.parse(m[1]!);
  } catch {
    return [];
  }
  if (!Array.isArray(bruto)) return [];
  const out: Controle[] = [];
  for (const c of bruto.slice(0, CONTROLES_MAX)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    if (typeof o.var !== "string" || !VAR_RE.test(o.var)) continue;
    const rotulo = typeof o.rotulo === "string" && o.rotulo.trim() ? o.rotulo.trim().slice(0, 60) : o.var;
    if (o.tipo === "token" && typeof o.grupo === "string" && /^[a-z0-9.-]{1,40}$/i.test(o.grupo)) {
      out.push({ var: o.var, rotulo, tipo: "token", grupo: o.grupo, ...(typeof o.padrao === "string" ? { padrao: o.padrao } : {}) });
      continue;
    }
    const min = Number(o.min);
    const max = Number(o.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) continue;
    const passo = Number(o.passo) > 0 ? Number(o.passo) : 1;
    const unidade = typeof o.unidade === "string" && /^[a-z%]{0,4}$/i.test(o.unidade) ? o.unidade : "";
    out.push({
      var: o.var,
      rotulo,
      tipo: "range",
      min,
      max,
      passo,
      unidade,
      ...(Number.isFinite(Number(o.padrao)) ? { padrao: Number(o.padrao) } : {}),
    });
  }
  return out;
}

const VALORES_RE = /<style\b[^>]*\bdata-ds-controles-valores\b[^>]*>[\s\S]*?<\/style>\s*/i;

/**
 * Grava os valores escolhidos nos Controles dentro do próprio card, num bloco `<style
 * data-ds-controles-valores>` que o Canvas é o único a escrever. Só aceita valor que cabe no
 * controle: número dentro de min/max, ou token que existe no grupo pedido.
 */
export function aplicarControles(html: string, valores: Record<string, unknown>, vars: DsVar[]): string {
  const controles = controlesDoCard(html);
  const linhas: string[] = [];
  for (const c of controles) {
    const v = valores[c.var];
    if (v === undefined || v === null || v === "") continue;
    if (c.tipo === "range") {
      const n = Number(v);
      if (!Number.isFinite(n) || n < c.min || n > c.max) throw erro(`${c.rotulo}: valor fora de ${c.min}–${c.max}`);
      linhas.push(`  ${c.var}: ${n}${c.unidade};`);
    } else {
      const alvo = vars.find((x) => x.nome === v && (x.caminho === c.grupo || x.caminho.startsWith(`${c.grupo}.`)));
      if (!alvo) throw erro(`${c.rotulo}: token ${String(v)} não existe no grupo ${c.grupo}`);
      linhas.push(`  ${c.var}: var(${alvo.nome});`);
    }
  }
  const semBloco = html.replace(VALORES_RE, "");
  if (!linhas.length) return semBloco;
  return `<style data-ds-controles-valores>\n:root {\n${linhas.join("\n")}\n}\n</style>\n${semBloco}`;
}

export function lintCard(html: string, varsConhecidas: Set<string>): LintItem[] {
  const itens: LintItem[] = [];
  // variável de controle é do card: usada com fallback, e o valor escolhido vem do bloco de valores
  const deControle = new Set(controlesDoCard(html).map((c) => c.var));
  const semControles = html.replace(/<script\b[^>]*\bdata-ds-controles\b[^>]*>[\s\S]*?<\/script>/gi, (m) =>
    /type\s*=\s*["']application\/json["']/i.test(m) ? "" : m,
  );

  for (const m of semControles.matchAll(/<script\b[^>]*>/gi)) {
    itens.push({ regra: "script", msg: "card não pode ter <script>", trecho: cortar(m[0]) });
  }
  for (const m of semControles.matchAll(/\son[a-z]+\s*=\s*["'][^"']*["']/gi)) {
    itens.push({ regra: "script", msg: "card não pode ter handler de evento inline", trecho: cortar(m[0]) });
  }

  const trechosCss: string[] = [];
  for (const m of semControles.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) trechosCss.push(m[1]!);
  for (const m of semControles.matchAll(/\sstyle\s*=\s*"([^"]*)"|\sstyle\s*=\s*'([^']*)'/gi)) trechosCss.push(m[1] ?? m[2]!);

  const locais = new Set<string>();
  for (const css of trechosCss) {
    for (const d of declaracoes(css)) {
      if (d.prop.startsWith("--")) locais.add(d.prop);
    }
  }

  for (const css of trechosCss) {
    for (const d of declaracoes(css)) {
      if (COR_LITERAL.test(d.valor)) {
        itens.push({ regra: "cor-literal", msg: "cor fora de token — use var(--…)", trecho: cortar(`${d.prop}: ${d.valor}`) });
      }
      for (const u of d.valor.matchAll(/url\(([^)]*)\)/gi)) {
        if (urlExternaProibida(u[1]!)) itens.push({ regra: "externo", msg: "recurso externo fora da allowlist", trecho: cortar(u[0]) });
      }
    }
    for (const imp of css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/gi)) {
      if (urlExternaProibida(imp[1]!)) itens.push({ regra: "externo", msg: "@import fora da allowlist", trecho: cortar(imp[0]) });
    }
  }

  // cor em atributo de apresentação SVG (fill="#fff" etc.)
  for (const m of semControles.matchAll(/\s(fill|stroke|stop-color|flood-color|color)\s*=\s*["']([^"']*)["']/gi)) {
    if (COR_LITERAL.test(m[2]!)) itens.push({ regra: "cor-literal", msg: "cor fora de token — use var(--…)", trecho: cortar(m[0]) });
  }

  for (const m of semControles.matchAll(/\s(src|href|srcset|poster|action|formaction)\s*=\s*["']([^"']*)["']/gi)) {
    const valor = m[2]!;
    if (/^\s*javascript:/i.test(valor)) {
      itens.push({ regra: "script", msg: "URL javascript: não é permitida", trecho: cortar(m[0]) });
      continue;
    }
    const alvos = m[1]!.toLowerCase() === "srcset" ? valor.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "") : [valor];
    // link <a href="https://…"> não carrega nada; só é problema em recurso que o navegador busca
    const ehAncora = m[1]!.toLowerCase() === "href" && !/<link\b[^>]*$/i.test(semControles.slice(0, m.index! + 1));
    if (ehAncora) continue;
    for (const alvo of alvos) {
      if (urlExternaProibida(alvo)) itens.push({ regra: "externo", msg: "recurso externo fora da allowlist", trecho: cortar(m[0]) });
    }
  }

  const faltando = new Set<string>();
  for (const m of semControles.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
    const nome = m[1]!;
    if (!varsConhecidas.has(nome) && !locais.has(nome)) faltando.add(nome);
  }
  for (const nome of deControle) faltando.delete(nome);
  for (const nome of faltando) itens.push({ regra: "token-inexistente", msg: `token ${nome} não existe em tokens.json`, trecho: nome });

  return itens;
}

/** Referência `{a.b}` a token que não existe é o único erro de conteúdo checado nos tokens. */
function lintTokens(vars: DsVar[]): LintItem[] {
  const nomes = new Set(vars.map((v) => v.nome));
  const itens: LintItem[] = [];
  for (const v of vars) {
    for (const m of v.valor.matchAll(/var\((--[a-zA-Z0-9_-]+)\)/g)) {
      if (!nomes.has(m[1]!)) itens.push({ regra: "token-inexistente", msg: `${v.caminho} referencia ${m[1]} que não existe`, trecho: v.caminho });
    }
  }
  return itens;
}

/* ---------------------------------------------------------------------------
 * Leitura
 * ------------------------------------------------------------------------- */

type MetaCard = { id: string; titulo?: string; subtitulo?: string; secao?: string; tipo?: string; largura?: string };
type Meta = { secoes?: DsSecao[]; cards?: MetaCard[]; fundamentos?: ConfigFundamento[] };

const ehLargura = (v: unknown): v is Largura => typeof v === "string" && (LARGURAS as readonly string[]).includes(v);
const ehAlinhamento = (v: unknown): v is Alinhamento => typeof v === "string" && (ALINHAMENTOS as readonly string[]).includes(v);
const ehTipo = (v: unknown): v is TipoCard => typeof v === "string" && TIPOS.some((t) => t.id === v);

/** `meta.fundamentos` validado — o arquivo é editado à mão e pelo agente. */
function fundamentosDoMeta(meta: Meta): ConfigFundamento[] {
  if (!Array.isArray(meta.fundamentos)) return [];
  return meta.fundamentos
    .filter((f) => f && typeof f.id === "string" && IDS_FUNDAMENTOS.includes(f.id))
    .map((f) => ({ id: f.id, ...(ehLargura(f.largura) ? { largura: f.largura } : {}), ...(f.oculto === true ? { oculto: true } : {}) }));
}

function lerTexto(caminho: string): string | null {
  try {
    return readFileSync(caminho, "utf8");
  } catch {
    return null;
  }
}

function lerMeta(pasta: string): Meta {
  try {
    const m = JSON.parse(readFileSync(join(pasta, "meta.json"), "utf8")) as Meta;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

export function lerSistema(projectPath: string, home: string, sistema: DsSistema): DsCompleto {
  const pastaAbs = pastaAbsoluta(projectPath, home, sistema);
  // painel de mocks lê tokens e regras do DS de origem; origem removida = usa o que tiver na pasta
  const origem = sistema.mocksDe ? lerPonteiro(projectPath, home).sistemas.find((s) => s.id === sistema.mocksDe && !s.mocksDe) : undefined;
  const pastaTokens = origem ? pastaAbsoluta(projectPath, home, origem) : pastaAbs;
  const tokensTexto = lerTexto(join(pastaTokens, "tokens.json")) ?? "";
  let tokens: unknown = {};
  const tokensLint: LintItem[] = [];
  if (!tokensTexto) {
    tokensLint.push({ regra: "tokens", msg: "tokens.json não existe" });
  } else {
    try {
      tokens = JSON.parse(tokensTexto);
    } catch (e) {
      tokensLint.push({ regra: "tokens", msg: `tokens.json inválido: ${(e as Error).message}` });
    }
  }
  const { css, vars } = tokensParaCss(tokens);
  tokensLint.push(...lintTokens(vars));
  const conhecidas = new Set(vars.map((v) => v.nome));

  const meta = lerMeta(pastaAbs);
  const porId = new Map((meta.cards ?? []).filter((c) => c && ID_RE.test(c.id)).map((c) => [c.id, c]));
  let arquivos: string[] = [];
  try {
    arquivos = readdirSync(join(pastaAbs, "cards")).filter((f) => f.endsWith(".html") && ID_RE.test(f.slice(0, -5)));
  } catch {
    arquivos = [];
  }
  const ids = new Set(arquivos.map((f) => f.slice(0, -5)));
  // ordem do meta.json primeiro; card em disco que o meta não conhece vai pro fim
  const ordem = [...(meta.cards ?? []).map((c) => c.id).filter((id) => ids.has(id)), ...[...ids].filter((id) => !porId.has(id)).sort()];
  const cards: DsCard[] = ordem.map((id) => {
    const html = lerTexto(join(pastaAbs, "cards", `${id}.html`)) ?? "";
    const m = porId.get(id);
    return {
      id,
      titulo: m?.titulo || id,
      ...(m?.subtitulo ? { subtitulo: m.subtitulo } : {}),
      secao: m?.secao || "outros",
      html,
      hash: hashDe(html),
      lint: lintCard(html, conhecidas),
      controles: controlesDoCard(html),
      ...(ehTipo(m?.tipo) ? { tipo: m.tipo } : {}),
      ...(ehLargura(m?.largura) ? { largura: m.largura } : {}),
    };
  });

  const secoes: DsSecao[] = (meta.secoes ?? [])
    .filter((s) => s && typeof s.id === "string" && typeof s.titulo === "string")
    .map((s) => ({ id: s.id, titulo: s.titulo, ...(ehAlinhamento(s.alinhamento) ? { alinhamento: s.alinhamento } : {}) }));
  for (const c of cards) {
    if (!secoes.some((s) => s.id === c.secao)) secoes.push({ id: c.secao, titulo: c.secao === "outros" ? "Outros" : c.secao });
  }

  return {
    ...sistema,
    pastaAbs,
    projetoAbs: resolve(projectPath),
    tokens,
    tokensHash: hashDe(tokensTexto),
    tokensLint,
    css,
    vars,
    designMd: lerTexto(join(pastaTokens, "DESIGN.md")) ?? "",
    secoes,
    cards,
    // Fundamentos são do DS; no painel de mocks ficariam repetidos
    fundamentos: sistema.mocksDe ? [] : cardsDeFundamentos(vars, fundamentosDoMeta(meta)),
    kitCss: KIT_CSS,
    ...(origem ? { origem } : {}),
  };
}

export function estadoDs(projectPath: string, home: string): DsEstado {
  const p = lerPonteiro(projectPath, home);
  const sistema = p.sistemas.find((s) => s.id === p.ativo);
  return {
    sistemas: p.sistemas,
    ativo: p.ativo,
    oficial: oficialDe(p)?.id ?? null,
    ds: sistema ? lerSistema(projectPath, home, sistema) : null,
  };
}

/** O DS oficial lido por inteiro (regras das conversas, conformidade, exportar), ou `null`. */
export function dsDoProjeto(projectPath: string, home: string): DsCompleto | null {
  const oficial = oficialDe(lerPonteiro(projectPath, home));
  return oficial ? lerSistema(projectPath, home, oficial) : null;
}

/** Escolhe o DS oficial do projeto. Painel de mocks não pode (ele não tem tokens próprios). */
export function definirOficial(projectPath: string, home: string, id: string): DsEstado {
  const p = lerPonteiro(projectPath, home);
  const s = p.sistemas.find((x) => x.id === id);
  if (!s) throw erro("design system não encontrado", 404);
  if (s.mocksDe) throw erro("painel de mocks não pode ser o oficial — ele usa os tokens de outro DS");
  salvarPonteiro(projectPath, home, { ...p, oficial: id });
  return estadoDs(projectPath, home);
}

/**
 * Painel de mocks do DS oficial: acha o que já existe (as telas novas entram nele) ou cria um
 * — pasta só com `meta.json` e `cards/`, sem copiar tokens nem cards do DS. DS "Mocks" antigo
 * (cópia inteira, de antes do painel existir) é adotado: passa a herdar do oficial e os cards
 * dele ficam onde estão. Sem DS nenhum no projeto, cria um DS "Mocks" comum com o padrão do Nexos.
 */
export function painelDeMocks(projectPath: string, home: string): DsSistema {
  const p = lerPonteiro(projectPath, home);
  const oficial = oficialDe(p);
  if (!oficial) {
    // tokens e regras do padrão do Nexos, sem os cards de exemplo dele: o painel é só de telas
    const est = criarDs(projectPath, home, { nome: NOME_MOCKS, base: "padrao" });
    const pasta = est.ds!.pastaAbs;
    rmSync(join(pasta, "cards"), { recursive: true, force: true });
    mkdirSync(join(pasta, "cards"), { recursive: true });
    escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ secoes: [{ id: "telas", titulo: "Telas" }], cards: [] }, null, 2)}
`);
    return est.sistemas.find((s) => s.id === est.ativo)!;
  }
  // projeto que só tem o "Mocks" comum (nasceu aqui sem DS): as telas entram nele mesmo
  if (oficial.nome.trim().toLowerCase() === NOME_MOCKS.toLowerCase()) return oficial;
  const doOficial = p.sistemas.find((s) => s.mocksDe === oficial.id);
  if (doOficial) return doOficial;
  const antigo = p.sistemas.find((s) => !s.mocksDe && s.id !== oficial.id && s.nome.trim().toLowerCase() === NOME_MOCKS.toLowerCase());
  if (antigo) {
    const adotado = { ...antigo, mocksDe: oficial.id };
    salvarPonteiro(projectPath, home, { ...p, sistemas: p.sistemas.map((s) => (s.id === antigo.id ? adotado : s)) });
    return adotado;
  }
  let id = "mocks";
  for (let n = 2; p.sistemas.some((s) => s.id === id); n++) id = `mocks-${n}`;
  const nome = p.sistemas.some((s) => s.nome === NOME_MOCKS) ? `${NOME_MOCKS} · ${oficial.nome}` : NOME_MOCKS;
  raizDoProjetoNexos(projectPath, home, true);
  const novo: DsSistema = { id, nome, mocksDe: oficial.id };
  const abs = pastaAbsoluta(projectPath, home, novo);
  mkdirSync(join(abs, "cards"), { recursive: true });
  if (!existsSync(join(abs, "meta.json"))) {
    escreverAtomico(join(abs, "meta.json"), `${JSON.stringify({ secoes: [{ id: "telas", titulo: "Telas" }], cards: [] }, null, 2)}\n`);
  }
  garantirKit(abs);
  salvarPonteiro(projectPath, home, { ...p, sistemas: [...p.sistemas, novo] });
  return novo;
}

/** Tokens e regras do painel de mocks são do DS de origem: editar ali, não aqui. */
function semPainelDeMocks(s: DsSistema): void {
  if (s.mocksDe) throw erro(`"${s.nome}" é um painel de mocks: tokens e regras vêm do DS "${s.mocksDe}" — ative ele pra editar`);
}

/** Pasta absoluta do DS ativo, ou `null` — pro observador. */
export function pastaDoAtivo(projectPath: string, home: string): string | null {
  const p = lerPonteiro(projectPath, home);
  const sistema = p.sistemas.find((s) => s.id === p.ativo);
  if (!sistema) return null;
  try {
    return pastaAbsoluta(projectPath, home, sistema);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Escrita
 * ------------------------------------------------------------------------- */

function ativoOuErro(projectPath: string, home: string): DsSistema {
  const p = lerPonteiro(projectPath, home);
  const s = p.sistemas.find((x) => x.id === p.ativo);
  if (!s) throw erro("este projeto não tem design system", 404);
  return s;
}

/** Só grava se o arquivo em disco ainda é o que o cliente leu (`base` = hash da leitura). */
function conferirBase(caminho: string, base: string | undefined): void {
  if (base === undefined) return;
  const atual = lerTexto(caminho) ?? "";
  if (hashDe(atual) !== base) throw erro("o arquivo mudou desde a leitura — recarregue antes de salvar", 409);
}

export function salvarTokens(projectPath: string, home: string, tokens: unknown, base?: string): DsCompleto {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) throw erro("tokens precisa ser um objeto DTCG");
  const s = ativoOuErro(projectPath, home);
  semPainelDeMocks(s);
  const caminho = join(pastaAbsoluta(projectPath, home, s), "tokens.json");
  conferirBase(caminho, base);
  escreverAtomico(caminho, `${JSON.stringify(tokens, null, 2)}\n`);
  return lerSistema(projectPath, home, s);
}

const VERSOES_POR_CARD = 10;

/**
 * Guarda a versão atual do card antes de sobrescrever — geração por IA reescreve card inteiro, e
 * perder um card ajustado à mão por causa de um "gerar de novo" não pode acontecer. Fica em
 * `.versoes/<id>/` dentro da pasta do DS (versionável junto no git, se a pessoa quiser).
 */
function guardarVersao(pasta: string, id: string): void {
  const atual = lerTexto(join(pasta, "cards", `${id}.html`));
  if (atual === null || !atual.trim()) return;
  const dir = join(pasta, ".versoes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.html`), atual, "utf8");
  const velhas = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
  for (const f of velhas.slice(0, Math.max(0, velhas.length - VERSOES_POR_CARD))) {
    try {
      rmSync(join(dir, f));
    } catch {
      /* segue */
    }
  }
}

export function salvarDesignMd(projectPath: string, home: string, texto: string): void {
  const s = ativoOuErro(projectPath, home);
  semPainelDeMocks(s);
  escreverAtomico(join(pastaAbsoluta(projectPath, home, s), "DESIGN.md"), texto.endsWith("\n") ? texto : `${texto}\n`);
}

/**
 * Prepara o `meta.json` pra uma geração: garante as seções (sem apagar as que existem) e põe os
 * cards do plano NA ORDEM DO PLANO — senão cada card entraria no fim, na ordem em que chegou.
 * Entrada de card que ainda não tem arquivo é inofensiva: `lerSistema` só mostra o que existe.
 * Card que já existe mantém título/subtítulo que alguém ajustou à mão.
 */
export function prepararMeta(
  projectPath: string,
  home: string,
  secoes: DsSecao[],
  plano: { id: string; titulo: string; subtitulo?: string; secao: string }[],
): void {
  const s = ativoOuErro(projectPath, home);
  semPainelDeMocks(s);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const meta = lerMeta(pasta);
  const atuais = (meta.secoes ?? []).filter((x) => x && typeof x.id === "string");
  const faltando = secoes.filter((x) => !atuais.some((a) => a.id === x.id));
  const existentes = new Map((meta.cards ?? []).filter((c) => c && typeof c.id === "string").map((c) => [c.id, c]));
  const doPlano = plano.map((p) => ({ ...p, ...existentes.get(p.id), secao: p.secao }));
  const idsPlano = new Set(plano.map((p) => p.id));
  const cards = [...doPlano, ...(meta.cards ?? []).filter((c) => c && !idsPlano.has(c.id))];
  escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, secoes: [...atuais, ...faltando], cards }, null, 2)}\n`);
}

export function salvarCard(
  projectPath: string,
  home: string,
  id: string,
  input: { html?: unknown; base?: string; titulo?: unknown; subtitulo?: unknown; secao?: unknown; tipo?: unknown; largura?: unknown },
  opts: { versionar?: boolean } = {},
): DsCompleto {
  if (!ID_RE.test(id)) throw erro("id de card inválido (a-z, 0-9 e hífen)");
  if (typeof input.html !== "string") throw erro("html obrigatório");
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const caminho = join(pasta, "cards", `${id}.html`);
  conferirBase(caminho, input.base);
  if (opts.versionar) guardarVersao(pasta, id);
  escreverAtomico(caminho, input.html);
  if (
    typeof input.titulo === "string" ||
    typeof input.secao === "string" ||
    typeof input.subtitulo === "string" ||
    ehTipo(input.tipo) ||
    ehLargura(input.largura)
  ) {
    const meta = lerMeta(pasta);
    const cards = meta.cards ?? [];
    const i = cards.findIndex((c) => c.id === id);
    const atual = i >= 0 ? cards[i]! : { id };
    const novo = {
      ...atual,
      ...(typeof input.titulo === "string" ? { titulo: input.titulo } : {}),
      ...(typeof input.subtitulo === "string" ? { subtitulo: input.subtitulo } : {}),
      ...(typeof input.secao === "string" ? { secao: input.secao } : {}),
      ...(ehTipo(input.tipo) ? { tipo: input.tipo } : {}),
      ...(ehLargura(input.largura) ? { largura: input.largura } : {}),
    };
    if (i >= 0) cards[i] = novo;
    else cards.push(novo);
    escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, cards }, null, 2)}\n`);
  }
  return lerSistema(projectPath, home, s);
}

export function ativarDs(projectPath: string, home: string, id: string): DsEstado {
  const p = lerPonteiro(projectPath, home);
  if (!p.sistemas.some((s) => s.id === id)) throw erro("design system não encontrado", 404);
  salvarPonteiro(projectPath, home, { ...comOficialFixo(p), ativo: id });
  return estadoDs(projectPath, home);
}

/**
 * Registra um DS na pasta escolhida. Pasta que já tem `tokens.json` é ADOTADA como está (DS
 * criado à mão ou por agente, ou vindo de outra máquina); pasta vazia recebe o esqueleto inicial.
 * Nunca sobrescreve arquivo existente.
 */
/**
 * Cria um DS em `<projectDir>/design-system/<id>/` com o esqueleto inicial. O id sai do nome.
 * Pasta que já tem arquivos (ex.: sincronizada de outra máquina sem o ponteiro) é ADOTADA como
 * está: esqueleto nunca sobrescreve arquivo existente.
 */
/* ---------------------------------------------------------------------------
 * Base do DS novo: do zero, o padrão do Nexos, ou cópia de um DS que já existe (qualquer projeto)
 * ------------------------------------------------------------------------- */

export type BaseDs = { id: string; nome: string; projeto?: string };

/** Pasta de projeto no Nexos → os DS dela (pelo ponteiro, só os que têm pasta no disco). */
function sistemasDaPasta(dirProjeto: string): { sistema: DsSistema; pasta: string }[] {
  try {
    const bruto = JSON.parse(readFileSync(join(dirProjeto, "design-system.json"), "utf8")) as Partial<Ponteiro>;
    if (!Array.isArray(bruto.sistemas)) return [];
    return bruto.sistemas
      .filter((s): s is DsSistema => !!s && typeof s.id === "string" && ID_RE.test(s.id) && typeof s.nome === "string")
      .map((s) => ({ sistema: { id: s.id, nome: s.nome }, pasta: join(dirProjeto, "design-system", s.id) }))
      .filter((x) => existsSync(join(x.pasta, "tokens.json")));
  } catch {
    return [];
  }
}

/** O que dá pra usar de ponto de partida ao criar um DS (o combobox do Canvas). */
export function listarBases(projectPath: string, home: string): BaseDs[] {
  const bases: BaseDs[] = [
    { id: "zero", nome: "Do zero (vazio)" },
    { id: "padrao", nome: "Padrão do Nexos" },
  ];
  const raiz = projetosRoot(home);
  const atual = projectDirSemCriar(projectPath, home);
  let dirs: string[] = [];
  try {
    dirs = readdirSync(raiz, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    dirs = [];
  }
  for (const slug of dirs) {
    const dir = join(raiz, slug);
    for (const { sistema } of sistemasDaPasta(dir)) {
      bases.push({ id: `copia:${slug}/${sistema.id}`, nome: sistema.nome, projeto: resolve(dir) === resolve(atual) ? "este projeto" : slug });
    }
  }
  return bases;
}

/** Arquivos de um DS vazio: sem token, sem card — a pessoa gera com IA ou monta com + Card. */
function vazio(nome: string): Record<string, string> {
  return {
    "tokens.json": "{}\n",
    "DESIGN.md": `# ${nome}\n`,
    "meta.json": `${JSON.stringify({ secoes: [], cards: [] }, null, 2)}\n`,
  };
}

/** Pasta do DS de origem de `copia:<slug-do-projeto>/<id>` — validada (nada de ".." no caminho). */
function pastaDaCopia(base: string, home: string): string {
  const m = /^copia:([a-z0-9][a-z0-9._-]{0,80})\/([a-z0-9][a-z0-9-]{0,63})$/.exec(base);
  if (!m) throw erro("base inválida");
  const dir = join(projetosRoot(home), m[1]!);
  const achado = sistemasDaPasta(dir).find((x) => x.sistema.id === m[2]);
  if (!achado) throw erro("o design system de origem não existe mais", 404);
  return achado.pasta;
}

export function criarDs(projectPath: string, home: string, input: { nome?: unknown; base?: unknown }): DsEstado {
  const nome = typeof input.nome === "string" && input.nome.trim() ? input.nome.trim().slice(0, 80) : "Design system";
  const p = lerPonteiro(projectPath, home);
  let base = nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!ID_RE.test(base)) base = "ds";
  let id = base;
  for (let n = 2; p.sistemas.some((s) => s.id === id); n++) id = `${base}-${n}`;
  raizDoProjetoNexos(projectPath, home, true); // garante a pasta do projeto (com meta.json)
  const abs = pastaAbsoluta(projectPath, home, { id, nome });
  // sem `base` = padrão do Nexos (quem chamava antes continua igual); o Canvas manda sempre
  const escolhida = typeof input.base === "string" && input.base ? input.base : "padrao";
  // "ativo" = copiar o DS ativo deste projeto (o agente cria "Mocks" com o mesmo visual)
  const ativo = p.sistemas.find((x) => x.id === p.ativo);
  if (escolhida === "ativo" && !ativo) throw erro("este projeto não tem design system ativo pra copiar");
  if (escolhida.startsWith("copia:") || escolhida === "ativo") {
    const origem = escolhida === "ativo" ? pastaAbsoluta(projectPath, home, ativo!) : pastaDaCopia(escolhida, home);
    if (resolve(origem) === resolve(abs)) throw erro("não dá pra copiar um design system em cima dele mesmo");
    // o histórico de versões é do DS de origem, não entra na cópia
    cpSync(origem, abs, { recursive: true, force: false, errorOnExist: false, filter: (src) => !/[\\/]\.versoes([\\/]|$)/.test(src) });
  } else {
    if (escolhida !== "zero" && escolhida !== "padrao") throw erro("base inválida");
    for (const [arquivo, conteudo] of Object.entries(escolhida === "zero" ? vazio(nome) : esqueleto(nome))) {
      const caminho = join(abs, arquivo);
      if (!existsSync(caminho)) escreverAtomico(caminho, conteudo);
    }
  }
  salvarPonteiro(projectPath, home, { ...comOficialFixo(p), sistemas: [...p.sistemas, { id, nome }], ativo: id });
  garantirKit(abs);
  return estadoDs(projectPath, home);
}

/* ---------------------------------------------------------------------------
 * Versões e variantes de card
 * ------------------------------------------------------------------------- */

export type VersaoCard = { nome: string; em: string; bytes: number };

/** Versões guardadas de um card (`.versoes/<id>/`), da mais nova pra mais velha. */
export function listarVersoes(projectPath: string, home: string, id: string): VersaoCard[] {
  if (!ID_RE.test(id)) throw erro("id de card inválido");
  const dir = join(pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home)), ".versoes", id);
  let nomes: string[] = [];
  try {
    nomes = readdirSync(dir).filter((f) => /^[0-9TZ-]+\.html$/.test(f));
  } catch {
    return [];
  }
  return nomes
    .sort()
    .reverse()
    .map((nome) => {
      // nome é o ISO com ":" e "." trocados por "-" (ver guardarVersao): volta pro formato de data
      const iso = nome.replace(/\.html$/, "").replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
      let bytes = 0;
      try {
        bytes = readFileSync(join(dir, nome)).length;
      } catch {
        /* segue */
      }
      return { nome, em: iso, bytes };
    });
}

/** Volta o card pra uma versão guardada. A atual vira versão antes (dá pra desfazer o desfazer). */
export function restaurarVersao(projectPath: string, home: string, id: string, nome: string): DsCompleto {
  if (!ID_RE.test(id) || !/^[0-9TZ-]+\.html$/.test(nome)) throw erro("versão inválida");
  const pasta = pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home));
  const html = lerTexto(join(pasta, ".versoes", id, nome));
  if (html === null) throw erro("versão não existe", 404);
  return salvarCard(projectPath, home, id, { html }, { versionar: true });
}

/** Tira o card do DS (variante descartada, card que não serve). Versionado antes: recuperável. */
export function apagarCard(projectPath: string, home: string, id: string): DsCompleto {
  if (!ID_RE.test(id)) throw erro("id de card inválido");
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const caminho = join(pasta, "cards", `${id}.html`);
  if (!existsSync(caminho)) throw erro("card não existe", 404);
  guardarVersao(pasta, id);
  rmSync(caminho);
  const meta = lerMeta(pasta);
  if (meta.cards?.some((c) => c.id === id)) {
    escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, cards: meta.cards.filter((c) => c.id !== id) }, null, 2)}\n`);
  }
  return lerSistema(projectPath, home, s);
}

/** Variante (`<id>-var-N`) vira o card original; a variante some. */
export function promoverVariante(projectPath: string, home: string, idVariante: string): DsCompleto {
  const m = /^(.+)-var-\d+$/.exec(idVariante);
  if (!m || !ID_RE.test(idVariante)) throw erro("isso não é uma variante");
  const original = m[1]!;
  const pasta = pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home));
  const html = lerTexto(join(pasta, "cards", `${idVariante}.html`));
  if (html === null) throw erro("variante não existe", 404);
  salvarCard(projectPath, home, original, { html }, { versionar: true });
  return apagarCard(projectPath, home, idVariante);
}

/**
 * Põe a entrada de um card no `meta.json` logo DEPOIS de outro (variante ao lado do original, não
 * no fim da seção). Não cria o arquivo: quem grava o HTML é a geração.
 */
export function registrarCardDepois(
  projectPath: string,
  home: string,
  novo: { id: string; titulo: string; subtitulo?: string; secao: string },
  depoisDe: string,
): void {
  const pasta = pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home));
  const meta = lerMeta(pasta);
  const cards = (meta.cards ?? []).filter((c) => c && c.id !== novo.id);
  const i = cards.findIndex((c) => c.id === depoisDe);
  cards.splice(i >= 0 ? i + 1 : cards.length, 0, novo);
  escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, cards }, null, 2)}\n`);
}

/** Próximo id livre de variante pra um card (`botoes-var-1`, `-var-2`…). */
export function proximaVariante(projectPath: string, home: string, id: string): string {
  const pasta = pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home));
  for (let n = 1; n < 100; n++) {
    const cand = `${id}-var-${n}`;
    if (ID_RE.test(cand) && !existsSync(join(pasta, "cards", `${cand}.html`))) return cand;
  }
  throw erro("variantes demais pra este card");
}

/* ---------------------------------------------------------------------------
 * Layout do board e cards novos (o agente faz o mesmo editando meta.json — ver KIT.md)
 * ------------------------------------------------------------------------- */

const ID_SECAO_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function slug(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Id livre pra um card novo, a partir do título (`cores-da-marca`, `-2`…). */
export function idNovoDeCard(projectPath: string, home: string, titulo: string): string {
  const pasta = pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home));
  const meta = lerMeta(pasta);
  let base = slug(titulo);
  if (!ID_RE.test(base)) base = "card";
  const ocupado = (id: string) =>
    existsSync(join(pasta, "cards", `${id}.html`)) || IDS_FUNDAMENTOS.includes(id) || (meta.cards ?? []).some((c) => c?.id === id);
  let id = base;
  for (let n = 2; ocupado(id); n++) id = `${base}-${n}`;
  return id;
}

/** Seção do card novo: id existente, ou título de seção nova (vira id e entra em `secoes`). */
function secaoParaCard(pasta: string, bruto: unknown): string {
  const texto = typeof bruto === "string" ? bruto.trim() : "";
  if (!texto) return "outros";
  const meta = lerMeta(pasta);
  const secoes = meta.secoes ?? [];
  if (secoes.some((s) => s?.id === texto) || texto === "outros") return texto;
  const id = ID_SECAO_RE.test(texto) ? texto : slug(texto) || "outros";
  if (!secoes.some((s) => s?.id === id)) {
    escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, secoes: [...secoes, { id, titulo: texto.slice(0, 60) }] }, null, 2)}\n`);
  }
  return id;
}

export type NovoCardDeTipo = { tipo?: unknown; titulo?: unknown; subtitulo?: unknown; secao?: unknown; largura?: unknown; tokens?: unknown };

/** Card de token (cores, tipografia, espaçamento, forma) montado do modelo, sem IA. */
export function criarCardDeTipo(projectPath: string, home: string, input: NovoCardDeTipo): { ds: DsCompleto; id: string } {
  const tipo = TIPOS.find((t) => t.id === input.tipo);
  if (!tipo || tipo.daIa) throw erro("tipo de card sem modelo pronto (use cores, tipografia, espacamento ou forma)");
  const titulo = typeof input.titulo === "string" && input.titulo.trim() ? input.titulo.trim().slice(0, 80) : tipo.titulo;
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const ds = lerSistema(projectPath, home, s);
  const doTipo = varsDoTipo(tipo.id as TipoDeToken, ds.vars);
  const pedidos = Array.isArray(input.tokens) ? new Set(input.tokens.filter((t): t is string => typeof t === "string")) : null;
  const vars = pedidos ? doTipo.filter((v) => pedidos.has(v.nome)) : doTipo;
  if (!vars.length) throw erro("marque ao menos um token");
  const id = idNovoDeCard(projectPath, home, titulo);
  const novo = salvarCard(projectPath, home, id, {
    html: htmlDoTipo(tipo.id as TipoDeToken, vars),
    titulo,
    ...(typeof input.subtitulo === "string" && input.subtitulo.trim() ? { subtitulo: input.subtitulo.trim().slice(0, 120) } : {}),
    secao: secaoParaCard(pasta, input.secao),
    tipo: tipo.id,
    largura: ehLargura(input.largura) ? input.largura : "1/2",
  });
  return { ds: novo, id };
}

/** Reserva a entrada no meta.json de um card que a IA vai desenhar (o esqueleto já aparece no lugar). */
export function registrarCardNovo(
  projectPath: string,
  home: string,
  novo: { id: string; titulo: string; subtitulo?: string; secao: unknown; tipo?: TipoCard; largura?: unknown },
): { id: string; titulo: string; subtitulo?: string; secao: string } {
  const pasta = pastaAbsoluta(projectPath, home, ativoOuErro(projectPath, home));
  const secao = secaoParaCard(pasta, novo.secao);
  const meta = lerMeta(pasta);
  const entrada: MetaCard = {
    id: novo.id,
    titulo: novo.titulo,
    ...(novo.subtitulo ? { subtitulo: novo.subtitulo } : {}),
    secao,
    ...(novo.tipo ? { tipo: novo.tipo } : {}),
    largura: ehLargura(novo.largura) ? novo.largura : "1/2",
  };
  const cards = [...(meta.cards ?? []).filter((c) => c && c.id !== novo.id), entrada];
  escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, cards }, null, 2)}\n`);
  return { id: novo.id, titulo: novo.titulo, ...(novo.subtitulo ? { subtitulo: novo.subtitulo } : {}), secao };
}

export type CardDaFerramenta = {
  id?: unknown;
  titulo?: unknown;
  subtitulo?: unknown;
  secao?: unknown;
  html?: unknown;
  largura?: unknown;
  tipo?: unknown;
};

/**
 * Card gravado pelo agente (`nexo_ds_card_salvar`): id existente = atualiza (com versão guardada);
 * sem id, ou id novo, sai do título. Seção por id ou título (vira seção nova). Grava pelo daemon
 * porque um DS criado no meio do turno fica fora das pastas que o CLI pode escrever naquele turno.
 */
export function salvarCardDaFerramenta(projectPath: string, home: string, c: CardDaFerramenta): { ds: DsCompleto; id: string; novo: boolean } {
  if (typeof c.html !== "string" || !c.html.trim()) throw erro("html obrigatório");
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const pedido = typeof c.id === "string" ? c.id.trim() : "";
  const existe = !!pedido && ID_RE.test(pedido) && existsSync(join(pasta, "cards", `${pedido}.html`));
  const titulo = typeof c.titulo === "string" && c.titulo.trim() ? c.titulo.trim().slice(0, 80) : pedido || "Card";
  const id = existe ? pedido : pedido && ID_RE.test(pedido) && !IDS_FUNDAMENTOS.includes(pedido) ? pedido : idNovoDeCard(projectPath, home, titulo);
  const ds = salvarCard(
    projectPath,
    home,
    id,
    {
      html: c.html,
      titulo,
      ...(typeof c.subtitulo === "string" && c.subtitulo.trim() ? { subtitulo: c.subtitulo.trim().slice(0, 120) } : {}),
      ...(typeof c.secao === "string" && c.secao.trim() ? { secao: secaoParaCard(pasta, c.secao) } : existe ? {} : { secao: "outros" }),
      ...(ehTipo(c.tipo) ? { tipo: c.tipo } : {}),
      ...(ehLargura(c.largura) ? { largura: c.largura } : existe ? {} : { largura: "1/2" }),
    },
    { versionar: existe },
  );
  return { ds, id, novo: !existe };
}

export type MudancaDeCard = { titulo?: unknown; subtitulo?: unknown; secao?: unknown; largura?: unknown; oculto?: unknown; mover?: unknown };

/**
 * Layout de um card pelo Canvas: título, seção, largura, posição (`mover` -1/+1 dentro da seção) e,
 * pros Fundamentos (que não têm arquivo), `oculto`.
 */
export function mudarCard(projectPath: string, home: string, id: string, m: MudancaDeCard): DsCompleto {
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const meta = lerMeta(pasta);
  const ds = lerSistema(projectPath, home, s);
  const mover = m.mover === -1 || m.mover === 1 ? m.mover : 0;

  if (IDS_FUNDAMENTOS.includes(id)) {
    // ordem completa dos fundamentos (inclusive os que o meta ainda não lista) pra dar pra mover
    const lista: ConfigFundamento[] = ds.fundamentos.map((f) => fundamentosDoMeta(meta).find((c) => c.id === f.id) ?? { id: f.id });
    const i = lista.findIndex((c) => c.id === id);
    if (i < 0) throw erro("card não existe", 404);
    const c = { ...lista[i]! };
    if (ehLargura(m.largura)) c.largura = m.largura;
    if (typeof m.oculto === "boolean") {
      if (m.oculto) c.oculto = true;
      else delete c.oculto;
    }
    lista[i] = c;
    if (mover && lista[i + mover]) [lista[i], lista[i + mover]] = [lista[i + mover]!, lista[i]!];
    escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, fundamentos: lista }, null, 2)}\n`);
    return lerSistema(projectPath, home, s);
  }

  const card = ds.cards.find((c) => c.id === id);
  if (!card) throw erro("card não existe", 404);
  // meta com todos os cards do disco, na ordem do board (card sem entrada ganha uma)
  const porId = new Map((meta.cards ?? []).filter((c) => c && typeof c.id === "string").map((c) => [c.id, c]));
  const cards: MetaCard[] = ds.cards.map((c) => porId.get(c.id) ?? { id: c.id, titulo: c.titulo, secao: c.secao });
  const semArquivo = (meta.cards ?? []).filter((c) => c && !ds.cards.some((x) => x.id === c.id));
  const i = cards.findIndex((c) => c.id === id);
  const e: MetaCard = { ...cards[i]! };
  if (typeof m.titulo === "string" && m.titulo.trim()) e.titulo = m.titulo.trim().slice(0, 80);
  if (typeof m.subtitulo === "string") {
    if (m.subtitulo.trim()) e.subtitulo = m.subtitulo.trim().slice(0, 120);
    else delete e.subtitulo;
  }
  if (typeof m.secao === "string" && m.secao.trim()) e.secao = secaoParaCard(pasta, m.secao);
  if (ehLargura(m.largura)) e.largura = m.largura;
  cards[i] = e;
  if (mover) {
    // vizinho na MESMA seção (é o que a pessoa vê lado a lado)
    const secao = e.secao || "outros";
    let j = i + mover;
    while (j >= 0 && j < cards.length && (cards[j]!.secao || "outros") !== secao) j += mover;
    if (j >= 0 && j < cards.length) [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }
  const metaAtual = lerMeta(pasta); // secaoParaCard pode ter acrescentado seção
  escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...metaAtual, cards: [...cards, ...semArquivo] }, null, 2)}\n`);
  return lerSistema(projectPath, home, s);
}

/** Título e alinhamento de uma seção (inclusive "fundamentos", que não precisa estar em `secoes`). */
export function mudarSecao(projectPath: string, home: string, id: string, m: { titulo?: unknown; alinhamento?: unknown }): DsCompleto {
  if (!ID_SECAO_RE.test(id)) throw erro("id de seção inválido");
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, home, s);
  const meta = lerMeta(pasta);
  const secoes = [...(meta.secoes ?? [])];
  let i = secoes.findIndex((x) => x?.id === id);
  if (i < 0) {
    const titulo = id === "fundamentos" ? "Fundamentos" : id === "outros" ? "Outros" : id;
    secoes.push({ id, titulo });
    i = secoes.length - 1;
  }
  const atual = { ...secoes[i]! };
  if (typeof m.titulo === "string" && m.titulo.trim()) atual.titulo = m.titulo.trim().slice(0, 60);
  if (ehAlinhamento(m.alinhamento)) atual.alinhamento = m.alinhamento;
  secoes[i] = atual;
  escreverAtomico(join(pasta, "meta.json"), `${JSON.stringify({ ...meta, secoes }, null, 2)}\n`);
  return lerSistema(projectPath, home, s);
}

/** Tira o DS da lista do projeto. Os arquivos ficam no disco (dá pra recuperar à mão). */
export function removerDs(projectPath: string, home: string, id: string): DsEstado {
  const p = lerPonteiro(projectPath, home);
  const sistemas = p.sistemas.filter((s) => s.id !== id);
  if (sistemas.length === p.sistemas.length) throw erro("design system não encontrado", 404);
  salvarPonteiro(projectPath, home, {
    sistemas,
    ativo: p.ativo === id ? (sistemas[0]?.id ?? null) : p.ativo,
    oficial: p.oficial === id ? null : (p.oficial ?? null),
  });
  return estadoDs(projectPath, home);
}

/* ---------------------------------------------------------------------------
 * Esqueleto inicial
 * ------------------------------------------------------------------------- */

function cor(v: string, claro?: string) {
  return claro ? { $value: v, $extensions: { "nexos.temas": { claro } } } : { $value: v };
}

function esqueleto(nome: string): Record<string, string> {
  const tokens = {
    color: {
      $type: "color",
      bg: cor("#161616", "#f5f3f1"),
      surface: cor("#212121", "#ffffff"),
      "surface-2": cor("#2a2a2a", "#efedea"),
      border: cor("#333333", "#dedad5"),
      text: cor("#f2f2f2", "#1a1a1a"),
      muted: cor("#9a9a9a", "#6b6b6b"),
      primary: { $value: "#c81e2c" },
      "on-primary": { $value: "#ffffff" },
      secondary: { $value: "#0e5d6b" },
      warning: { $value: "#f0b400" },
      success: { $value: "#22c55e" },
      danger: { $value: "#8f1620" },
    },
    font: {
      family: {
        $type: "fontFamily",
        display: { $value: ["Archivo", "system-ui", "sans-serif"] },
        body: { $value: ["IBM Plex Sans", "system-ui", "sans-serif"] },
        mono: { $value: ["IBM Plex Mono", "ui-monospace", "monospace"] },
      },
      size: {
        $type: "dimension",
        xs: { $value: "11px" },
        sm: { $value: "13px" },
        md: { $value: "15px" },
        lg: { $value: "18px" },
        xl: { $value: "24px" },
        "2xl": { $value: "32px" },
      },
      weight: { $type: "fontWeight", regular: { $value: 400 }, medium: { $value: 600 }, bold: { $value: 700 } },
    },
    space: {
      $type: "dimension",
      "1": { $value: "4px" },
      "2": { $value: "8px" },
      "3": { $value: "12px" },
      "4": { $value: "16px" },
      "5": { $value: "24px" },
      "6": { $value: "32px" },
    },
    radius: { $type: "dimension", sm: { $value: "4px" }, md: { $value: "8px" }, lg: { $value: "12px" }, pill: { $value: "999px" } },
    shadow: { $type: "shadow", "1": { $value: "0 1px 2px rgb(0 0 0 / .3)" }, "2": { $value: "0 10px 28px -6px rgb(0 0 0 / .5)" } },
    motion: { duration: { $type: "duration", base: { $value: "150ms" } }, ease: { $type: "cubicBezier", base: { $value: "cubic-bezier(.32,.72,.35,1)" } } },
  };

  const designMd = `# ${nome}

Regras de uso deste design system. É o que os agentes leem antes de mexer no front.

## Cor
- Cor de marca (\`--color-primary\`) só em ação principal e destaque (botão primário, item ativo).
- \`--color-warning\` só em alerta; \`--color-success\` só em concluído/aprovado.
- \`--color-danger\` pra estado crítico, nunca em botão.

## Tipografia
- \`--font-family-display\` em títulos e KPIs; \`--font-family-body\` na interface; \`--font-family-mono\` em código, IDs e valores.

## Espaço e forma
- Espaçamento só da escala \`--space-*\`. Raio só de \`--radius-*\`.

## Regra geral
- Componente nunca usa hex/rgb direto: sempre \`var(--token)\`. Faltou um valor? Ele entra em \`tokens.json\`.
`;

  const meta = {
    secoes: [
      { id: "core", titulo: "Core" },
      { id: "layout", titulo: "Layout" },
      { id: "dados", titulo: "Dados & formulários" },
      { id: "navegacao", titulo: "Navegação" },
      { id: "feedback", titulo: "Feedback & overlays" },
      { id: "graficos", titulo: "Gráficos" },
      { id: "telas", titulo: "Telas-exemplo" },
    ],
    cards: [
      { id: "core-botoes", titulo: "Botões", subtitulo: "Primário, secundário, contorno e fantasma", secao: "core" },
      { id: "dados-campos", titulo: "Campos", subtitulo: "Texto, validação e select", secao: "dados" },
    ],
  };

  const botoes = `<style>
  .linha { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
  .btn { font: var(--font-weight-medium) var(--font-size-sm) / 1 var(--font-family-body); padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-sm); border: 1px solid transparent; cursor: pointer; }
  .primario { background: var(--color-primary); color: var(--color-on-primary); }
  .secundario { background: var(--color-secondary); color: var(--color-on-primary); }
  .contorno { background: transparent; color: var(--color-text); border-color: var(--color-border); }
  .fantasma { background: var(--color-surface-2); color: var(--color-muted); }
</style>
<div class="linha">
  <button class="btn primario">Salvar</button>
  <button class="btn secundario">Novo orçamento</button>
  <button class="btn contorno">Cancelar</button>
  <button class="btn fantasma">Filtros</button>
</div>
`;

  const campos = `<style>
  .grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-4); }
  label { display: block; font: var(--font-weight-medium) var(--font-size-xs) / 1.4 var(--font-family-body); color: var(--color-muted);
    text-transform: uppercase; letter-spacing: .06em; margin-bottom: var(--space-2); }
  input, select { width: 100%; box-sizing: border-box; padding: var(--space-3); border-radius: var(--radius-sm);
    background: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border);
    font: var(--font-size-sm) var(--font-family-body); }
  .erro input { border-color: var(--color-primary); }
  .dica { font-size: var(--font-size-xs); color: var(--color-primary); margin-top: var(--space-1); }
</style>
<div class="grade">
  <div><label>Nome / razão social</label><input value="Transportes Vieira ME" /></div>
  <div class="erro"><label>CPF / CNPJ</label><input value="12.345.678/0001" /><div class="dica">CNPJ incompleto</div></div>
  <div><label>Forma de pagamento</label><select><option>Pix</option><option>Boleto</option></select></div>
</div>
`;

  return {
    "tokens.json": `${JSON.stringify(tokens, null, 2)}\n`,
    "DESIGN.md": designMd,
    "meta.json": `${JSON.stringify(meta, null, 2)}\n`,
    "cards/core-botoes.html": botoes,
    "cards/dados-campos.html": campos,
  };
}
