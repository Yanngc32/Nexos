import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";

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

export type DsSistema = { id: string; nome: string };

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
};

export type DsSecao = { id: string; titulo: string };

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
};

export type DsEstado = { sistemas: DsSistema[]; ativo: string | null; ds: DsCompleto | null };

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

type Ponteiro = { sistemas: DsSistema[]; ativo: string | null };

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
          .map((s) => ({ id: s.id, nome: s.nome }))
      : [];
    const ativo = sistemas.some((s) => s.id === bruto.ativo) ? (bruto.ativo as string) : (sistemas[0]?.id ?? null);
    return { sistemas, ativo };
  } catch {
    return { sistemas: [], ativo: null };
  }
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

type Meta = { secoes?: DsSecao[]; cards?: { id: string; titulo?: string; subtitulo?: string; secao?: string }[] };

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
  const tokensTexto = lerTexto(join(pastaAbs, "tokens.json")) ?? "";
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
    };
  });

  const secoes = (meta.secoes ?? []).filter((s) => s && typeof s.id === "string" && typeof s.titulo === "string");
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
    designMd: lerTexto(join(pastaAbs, "DESIGN.md")) ?? "",
    secoes,
    cards,
  };
}

export function estadoDs(projectPath: string, home: string): DsEstado {
  const p = lerPonteiro(projectPath, home);
  const sistema = p.sistemas.find((s) => s.id === p.ativo);
  return { sistemas: p.sistemas, ativo: p.ativo, ds: sistema ? lerSistema(projectPath, home, sistema) : null };
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
  input: { html?: unknown; base?: string; titulo?: unknown; subtitulo?: unknown; secao?: unknown },
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
  if (typeof input.titulo === "string" || typeof input.secao === "string" || typeof input.subtitulo === "string") {
    const meta = lerMeta(pasta);
    const cards = meta.cards ?? [];
    const i = cards.findIndex((c) => c.id === id);
    const atual = i >= 0 ? cards[i]! : { id };
    const novo = {
      ...atual,
      ...(typeof input.titulo === "string" ? { titulo: input.titulo } : {}),
      ...(typeof input.subtitulo === "string" ? { subtitulo: input.subtitulo } : {}),
      ...(typeof input.secao === "string" ? { secao: input.secao } : {}),
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
  salvarPonteiro(projectPath, home, { ...p, ativo: id });
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
export function criarDs(projectPath: string, home: string, input: { nome?: unknown }): DsEstado {
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
  for (const [arquivo, conteudo] of Object.entries(esqueleto(nome))) {
    const caminho = join(abs, arquivo);
    if (!existsSync(caminho)) escreverAtomico(caminho, conteudo);
  }
  salvarPonteiro(projectPath, home, { sistemas: [...p.sistemas, { id, nome }], ativo: id });
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

/** Tira o DS da lista do projeto. Os arquivos ficam no disco (dá pra recuperar à mão). */
export function removerDs(projectPath: string, home: string, id: string): DsEstado {
  const p = lerPonteiro(projectPath, home);
  const sistemas = p.sistemas.filter((s) => s.id !== id);
  if (sistemas.length === p.sistemas.length) throw erro("design system não encontrado", 404);
  salvarPonteiro(projectPath, home, { sistemas, ativo: p.ativo === id ? (sistemas[0]?.id ?? null) : p.ativo });
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
