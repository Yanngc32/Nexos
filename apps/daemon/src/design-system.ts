import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectDir, projectDirSemCriar } from "./projeto-dir.ts";

/**
 * Design system (DS) do projeto — o que a view "Design System" do desktop mostra e edita.
 * Spec: docs/superpowers/specs/2026-09-22-canvas-design-system-design.md.
 *
 * Os ARQUIVOS são a fonte da verdade e moram DENTRO do projeto, na pasta que o usuário
 * escolheu: o agente edita com as ferramentas nativas dele (Write/Edit/shell), sem ferramenta
 * MCP própria. Aqui só fica o que o daemon precisa pra servir o Canvas: ler, gravar com
 * checagem de conflito, virar tokens em CSS e passar o lint.
 *
 * O ponteiro "quais DS este projeto tem e qual é o ativo" NÃO fica no projeto: fica na pasta
 * do projeto do Nexos (`projectDir`), com a pasta do DS relativa ao projeto — mesmo projeto em
 * outra máquina (outro caminho absoluto) continua achando o DS.
 */

export type LintItem = { regra: string; msg: string; trecho?: string };

export type DsSistema = { id: string; nome: string; pasta: string };

export type DsCard = {
  id: string;
  titulo: string;
  subtitulo?: string;
  secao: string;
  html: string;
  hash: string;
  lint: LintItem[];
};

export type DsSecao = { id: string; titulo: string };

export type DsVar = { nome: string; caminho: string; tipo?: string; valor: string; bruto: unknown };

export type DsCompleto = DsSistema & {
  /** Caminho absoluto — o Canvas usa como `<base>` pra imagem relativa (logo do projeto). */
  pastaAbs: string;
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
 * Ponteiro por projeto
 * ------------------------------------------------------------------------- */

type Ponteiro = { sistemas: DsSistema[]; ativo: string | null };

function ponteiroPath(projectPath: string, home: string, criar: boolean): string {
  const dir = criar ? projectDir(projectPath, home) : projectDirSemCriar(projectPath, home);
  return join(dir, "design-system.json");
}

function lerPonteiro(projectPath: string, home: string): Ponteiro {
  try {
    const bruto = JSON.parse(readFileSync(ponteiroPath(projectPath, home, false), "utf8")) as Partial<Ponteiro>;
    const sistemas = Array.isArray(bruto.sistemas)
      ? bruto.sistemas.filter(
          (s): s is DsSistema =>
            !!s && typeof s.id === "string" && typeof s.nome === "string" && typeof s.pasta === "string",
        )
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

/* ---------------------------------------------------------------------------
 * Caminho da pasta: sempre DENTRO do projeto
 * ------------------------------------------------------------------------- */

function dentro(raiz: string, alvo: string): boolean {
  const rel = relative(raiz, alvo);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `realpath` do trecho que já existe + o resto — pasta nova ainda não existe no disco. */
function realOuPai(alvo: string): string {
  let atual = alvo;
  const resto: string[] = [];
  while (!existsSync(atual)) {
    const pai = dirname(atual);
    if (pai === atual) return alvo;
    resto.unshift(atual.slice(pai.length + (pai.endsWith(sep) ? 0 : 1)));
    atual = pai;
  }
  return join(realpathSync(atual), ...resto);
}

/**
 * Normaliza a pasta pedida (absoluta, do seletor de pasta, ou relativa ao projeto) pra um caminho
 * RELATIVO ao projeto, e recusa o que sai dele — inclusive por symlink.
 */
export function pastaRelativa(projectPath: string, pasta: string): string {
  const bruta = (pasta || "").trim();
  if (!bruta) throw erro("pasta obrigatória");
  const raiz = resolve(projectPath);
  const alvo = resolve(raiz, bruta);
  if (!dentro(raiz, alvo)) throw erro("a pasta do design system precisa ficar dentro do projeto");
  if (existsSync(raiz) && !dentro(realpathSync(raiz), realOuPai(alvo))) {
    throw erro("a pasta do design system aponta pra fora do projeto (symlink)");
  }
  const rel = relative(raiz, alvo).split(sep).join("/");
  if (!rel) throw erro("escolha uma subpasta do projeto, não a raiz dele");
  return rel;
}

export function pastaAbsoluta(projectPath: string, sistema: DsSistema): string {
  // revalida a cada uso: o ponteiro é um arquivo editável à mão
  return resolve(projectPath, pastaRelativa(projectPath, sistema.pasta));
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
export function lintCard(html: string, varsConhecidas: Set<string>): LintItem[] {
  const itens: LintItem[] = [];
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

export function lerSistema(projectPath: string, sistema: DsSistema): DsCompleto {
  const pastaAbs = pastaAbsoluta(projectPath, sistema);
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
    };
  });

  const secoes = (meta.secoes ?? []).filter((s) => s && typeof s.id === "string" && typeof s.titulo === "string");
  for (const c of cards) {
    if (!secoes.some((s) => s.id === c.secao)) secoes.push({ id: c.secao, titulo: c.secao === "outros" ? "Outros" : c.secao });
  }

  return {
    ...sistema,
    pastaAbs,
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
  return { sistemas: p.sistemas, ativo: p.ativo, ds: sistema ? lerSistema(projectPath, sistema) : null };
}

/** Pasta absoluta do DS ativo, ou `null` — pro observador. */
export function pastaDoAtivo(projectPath: string, home: string): string | null {
  const p = lerPonteiro(projectPath, home);
  const sistema = p.sistemas.find((s) => s.id === p.ativo);
  if (!sistema) return null;
  try {
    return pastaAbsoluta(projectPath, sistema);
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
  const caminho = join(pastaAbsoluta(projectPath, s), "tokens.json");
  conferirBase(caminho, base);
  escreverAtomico(caminho, `${JSON.stringify(tokens, null, 2)}\n`);
  return lerSistema(projectPath, s);
}

export function salvarCard(
  projectPath: string,
  home: string,
  id: string,
  input: { html?: unknown; base?: string; titulo?: unknown; subtitulo?: unknown; secao?: unknown },
): DsCompleto {
  if (!ID_RE.test(id)) throw erro("id de card inválido (a-z, 0-9 e hífen)");
  if (typeof input.html !== "string") throw erro("html obrigatório");
  const s = ativoOuErro(projectPath, home);
  const pasta = pastaAbsoluta(projectPath, s);
  const caminho = join(pasta, "cards", `${id}.html`);
  conferirBase(caminho, input.base);
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
  return lerSistema(projectPath, s);
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
export function criarDs(projectPath: string, home: string, input: { nome?: unknown; pasta?: unknown }): DsEstado {
  const nome = typeof input.nome === "string" && input.nome.trim() ? input.nome.trim().slice(0, 80) : "Design system";
  const pasta = pastaRelativa(projectPath, typeof input.pasta === "string" ? input.pasta : "design-system");
  const p = lerPonteiro(projectPath, home);
  const existente = p.sistemas.find((s) => s.pasta === pasta);
  if (existente) {
    salvarPonteiro(projectPath, home, { ...p, ativo: existente.id });
    return estadoDs(projectPath, home);
  }
  const abs = resolve(projectPath, pasta);
  for (const [arquivo, conteudo] of Object.entries(esqueleto(nome))) {
    const caminho = join(abs, arquivo);
    if (!existsSync(caminho)) escreverAtomico(caminho, conteudo);
  }
  let base = pasta.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "ds";
  if (!ID_RE.test(base)) base = "ds";
  let id = base;
  for (let n = 2; p.sistemas.some((s) => s.id === id); n++) id = `${base}-${n}`;
  salvarPonteiro(projectPath, home, { sistemas: [...p.sistemas, { id, nome, pasta }], ativo: id });
  return estadoDs(projectPath, home);
}

/** Tira o DS da lista do projeto. Os arquivos ficam no disco — são do projeto, não do Nexos. */
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
