import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { estadoDs, type DsCompleto, type DsVar } from "./design-system.ts";
import { coletarDoCodigo } from "./ds-coleta.ts";

/**
 * Design system ↔ código do projeto (spec §6, Fase 5):
 *
 * - `blocoDoDsParaPack`: o que entra no contexto de TODA conversa do projeto quando há DS ativo —
 *   é o que faz o agente usar os tokens ao mexer no front, que é o ponto do DS existir.
 * - `conformidade`: varre o front atrás de cor solta (hex) e diz qual token usar. Sem LLM:
 *   determinístico, instantâneo e de graça — o agente só entra se a pessoa pedir a correção.
 * - `ressincronizar`: o que o código usa e o DS não tem (e o contrário).
 * - `exportar`: CSS vars, Tailwind v4 `@theme`, Tailwind v3 `theme.extend`, DTCG.
 */

const DESIGN_MD_NO_PACK = 2500;
const VARS_NO_PACK = 60;

export function blocoDoDsParaPack(projectPath: string, home: string): string | null {
  let ds: DsCompleto | null = null;
  try {
    ds = estadoDs(projectPath, home).ds;
  } catch {
    return null;
  }
  if (!ds) return null;
  const regras = ds.designMd.trim();
  const tokens = ds.vars
    .slice(0, VARS_NO_PACK)
    .map((v) => `${v.nome}: ${v.valor}`)
    .join("\n");
  return [
    `# Design system do projeto: ${ds.nome}`,
    `Pasta: ${ds.pastaAbs} (tokens.json, DESIGN.md e cards/<id>.html — pode ler e editar).`,
    "Ao criar ou mudar o front deste projeto: use estes tokens (cor, fonte, espaço, raio, sombra) no lugar de " +
      "valor solto e siga as regras de uso. Faltou um token? Proponha adicionar em tokens.json em vez de inventar um hex. " +
      "Pra ver como um componente deve ficar, leia o card dele na pasta acima.",
    regras ? `## Regras de uso (DESIGN.md)\n${regras.length > DESIGN_MD_NO_PACK ? `${regras.slice(0, DESIGN_MD_NO_PACK)}…` : regras}` : "",
    tokens ? `## Tokens (variável CSS → valor)\n${tokens}${ds.vars.length > VARS_NO_PACK ? `\n… (${ds.vars.length - VARS_NO_PACK} a mais em tokens.json)` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ---------------------------------------------------------------------------
 * Cores: hex → rgb, e o token mais perto
 * ------------------------------------------------------------------------- */

function rgbDe(hex: string): [number, number, number] | null {
  let h = hex.replace("#", "").toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function normalizarHex(hex: string): string | null {
  const rgb = rgbDe(hex);
  return rgb ? `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}` : null;
}

/** Valor final de uma variável, seguindo `var(--x)` até chegar num valor de verdade. */
function resolver(v: DsVar, porNome: Map<string, DsVar>, fundo = 0): string {
  const m = /^var\((--[a-zA-Z0-9_-]+)\)$/.exec(v.valor.trim());
  if (!m || fundo > 8) return v.valor;
  const alvo = porNome.get(m[1]!);
  return alvo ? resolver(alvo, porNome, fundo + 1) : v.valor;
}

type CorDoToken = { nome: string; hex: string; rgb: [number, number, number] };

function coresDosTokens(ds: DsCompleto): CorDoToken[] {
  const porNome = new Map(ds.vars.map((v) => [v.nome, v]));
  const out: CorDoToken[] = [];
  for (const v of ds.vars) {
    // sem $type vale pelo valor; com $type só "color" (peso/raio com hex é erro do token, não cor)
    if (v.tipo && v.tipo !== "color") continue;
    const hex = normalizarHex(resolver(v, porNome).trim());
    const rgb = hex ? rgbDe(hex) : null;
    if (hex && rgb) out.push({ nome: v.nome, hex, rgb });
  }
  return out;
}

function distancia(a: [number, number, number], b: [number, number, number]): number {
  // distância perceptual simples ("redmean"): bem melhor que euclidiana crua e sem biblioteca
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

function tokenMaisPerto(hex: string, cores: CorDoToken[]): { token: CorDoToken; distancia: number } | null {
  const rgb = rgbDe(hex);
  if (!rgb || !cores.length) return null;
  let melhor = cores[0]!;
  let d = distancia(rgb, melhor.rgb);
  for (const c of cores.slice(1)) {
    const dc = distancia(rgb, c.rgb);
    if (dc < d) {
      d = dc;
      melhor = c;
    }
  }
  return { token: melhor, distancia: Math.round(d) };
}

/** Abaixo disso a cor solta é "quase" o token (provavelmente o mesmo, digitado à mão). */
const PERTO = 40;

/* ---------------------------------------------------------------------------
 * Conformidade
 * ------------------------------------------------------------------------- */

export type Achado = {
  arquivo: string;
  linha: number;
  valor: string;
  /** Token com exatamente essa cor. */
  exato?: string;
  /** Senão, o token mais perto e quão longe (0 = igual). */
  sugestao?: { token: string; hex: string; distancia: number };
};

export type Conformidade = {
  arquivosLidos: number;
  total: number;
  exatos: number;
  perto: number;
  foraDaPaleta: number;
  porArquivo: { arquivo: string; n: number }[];
  achados: Achado[];
};

const PULAR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage", "vendor", "target", ".venv", "venv", "__pycache__", ".turbo", ".cache", "daemon-dist"]);
const EXT_FRONT = new Set([".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte", ".astro", ".tsx", ".jsx"]);
const MAX_ARQUIVOS = 2000;
const MAX_BYTES = 300_000;
const MAX_ACHADOS = 400;
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;

function arquivosDoFront(raiz: string): string[] {
  const out: string[] = [];
  const andar = (dir: string, nivel: number): void => {
    if (nivel > 10 || out.length >= MAX_ARQUIVOS) return;
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (out.length >= MAX_ARQUIVOS) return;
      const caminho = join(dir, e.name);
      if (e.isDirectory()) {
        if (!PULAR.has(e.name) && !e.name.startsWith(".")) andar(caminho, nivel + 1);
      } else if (e.isFile() && EXT_FRONT.has(extname(e.name).toLowerCase())) out.push(caminho);
    }
  };
  andar(raiz, 0);
  return out;
}

/** Linha "de cor" de verdade: pula comentário de uma linha e âncora/id (`href="#abc"`, `#main {`). */
function linhaDeCor(linha: string, idx: number): boolean {
  const antes = linha.slice(0, idx);
  if (/^\s*(\/\/|\*|<!--)/.test(linha)) return false;
  // dentro de /* … */ aberto antes, na mesma linha
  if (antes.lastIndexOf("/*") > antes.lastIndexOf("*/")) return false;
  if (/(href|to|id|xlink:href)\s*=\s*["'{]?\s*$/.test(antes)) return false;
  // seletor de id no CSS: "#abc {" ou "#abc," no começo da linha
  if (/^\s*$/.test(antes) && /^#[\w-]+\s*[{,]/.test(linha.slice(idx))) return false;
  return true;
}

export function conformidade(projectPath: string, home: string): Conformidade {
  const ds = estadoDs(projectPath, home).ds;
  if (!ds) throw Object.assign(new Error("este projeto não tem design system"), { status: 404 });
  const cores = coresDosTokens(ds);
  const exatoPorHex = new Map<string, string>();
  for (const c of cores) if (!exatoPorHex.has(c.hex)) exatoPorHex.set(c.hex, c.nome);

  const achados: Achado[] = [];
  const contagem = new Map<string, number>();
  let total = 0;
  let exatos = 0;
  let perto = 0;
  let fora = 0;
  const arquivos = arquivosDoFront(projectPath);
  for (const caminho of arquivos) {
    let texto: string;
    try {
      if (statSync(caminho).size > MAX_BYTES) continue;
      texto = readFileSync(caminho, "utf8");
    } catch {
      continue;
    }
    const rel = relative(projectPath, caminho).split(sep).join("/");
    const linhas = texto.split(/\r?\n/);
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i]!;
      for (const m of linha.matchAll(HEX_RE)) {
        if (!linhaDeCor(linha, m.index!)) continue;
        const hex = normalizarHex(m[0]);
        if (!hex) continue;
        total += 1;
        contagem.set(rel, (contagem.get(rel) ?? 0) + 1);
        const exato = exatoPorHex.get(hex);
        const achado: Achado = { arquivo: rel, linha: i + 1, valor: m[0] };
        if (exato) {
          exatos += 1;
          achado.exato = exato;
        } else {
          const t = tokenMaisPerto(hex, cores);
          if (t) {
            achado.sugestao = { token: t.token.nome, hex: t.token.hex, distancia: t.distancia };
            if (t.distancia <= PERTO) perto += 1;
            else fora += 1;
          } else fora += 1;
        }
        if (achados.length < MAX_ACHADOS) achados.push(achado);
      }
    }
  }
  return {
    arquivosLidos: arquivos.length,
    total,
    exatos,
    perto,
    foraDaPaleta: fora,
    porArquivo: [...contagem].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([arquivo, n]) => ({ arquivo, n })),
    achados,
  };
}

/* ---------------------------------------------------------------------------
 * Ressincronizar (código → DS)
 * ------------------------------------------------------------------------- */

export type Ressincronia = {
  /** Cores que o código usa bastante e nenhum token cobre (nem de perto). */
  coresNovas: { hex: string; usos: number; maisPerto?: { token: string; distancia: number } }[];
  /** Tokens de cor cujo valor não aparece no código (pode ser que o código use outra coisa). */
  coresSemUso: { token: string; hex: string }[];
  /** Fontes declaradas no código que não estão em nenhum token de fonte. */
  fontesNovas: { familia: string; usos: number }[];
};

export function ressincronizar(projectPath: string, home: string): Ressincronia {
  const est = estadoDs(projectPath, home);
  const ds = est.ds;
  if (!ds) throw Object.assign(new Error("este projeto não tem design system"), { status: 404 });
  const coleta = coletarDoCodigo(projectPath);
  const cores = coresDosTokens(ds);
  const usadas = new Set<string>();
  const coresNovas: Ressincronia["coresNovas"] = [];
  for (const [hexBruto, usos] of coleta.cores) {
    const hex = normalizarHex(hexBruto);
    if (!hex) continue;
    usadas.add(hex);
    const t = tokenMaisPerto(hex, cores);
    if (usos >= 3 && (!t || t.distancia > PERTO)) {
      coresNovas.push({ hex, usos, ...(t ? { maisPerto: { token: t.token.nome, distancia: t.distancia } } : {}) });
    }
  }
  const coresSemUso = cores.filter((c) => !usadas.has(c.hex)).map((c) => ({ token: c.nome, hex: c.hex }));
  const familiasDoDs = ds.vars
    .filter((v) => v.tipo === "fontFamily" || /family/i.test(v.caminho))
    .flatMap((v) => v.valor.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase()));
  const fontesNovas = coleta.fontes
    .map(([f, usos]) => ({ familia: f.split(",")[0]!.trim().replace(/^["']|["']$/g, ""), usos }))
    .filter((f) => f.familia && !familiasDoDs.includes(f.familia.toLowerCase()));
  return { coresNovas: coresNovas.slice(0, 20), coresSemUso: coresSemUso.slice(0, 30), fontesNovas: fontesNovas.slice(0, 10) };
}

/* ---------------------------------------------------------------------------
 * Exportar
 * ------------------------------------------------------------------------- */

export type FormatoExport = "css" | "tailwind4" | "tailwind3" | "dtcg";

/** Nome no namespace do Tailwind v4 pro caminho do token (color.bg → --color-bg, space.4 → --spacing-4…). */
function nomeTailwind(caminho: string): { ns: string; resto: string } {
  const p = caminho.split(".");
  const resto = (n: number) => p.slice(n).join("-");
  if (p[0] === "color" || p[0] === "colors") return { ns: "color", resto: resto(1) };
  if (p[0] === "font" && p[1] === "family") return { ns: "font", resto: resto(2) };
  if (p[0] === "font" && p[1] === "size") return { ns: "text", resto: resto(2) };
  if (p[0] === "font" && p[1] === "weight") return { ns: "font-weight", resto: resto(2) };
  if (p[0] === "space" || p[0] === "spacing") return { ns: "spacing", resto: resto(1) };
  if (p[0] === "radius" || p[0] === "radii") return { ns: "radius", resto: resto(1) };
  if (p[0] === "shadow") return { ns: "shadow", resto: resto(1) };
  if (p[0] === "motion" && p[1] === "ease") return { ns: "ease", resto: resto(2) };
  return { ns: p[0]!, resto: resto(1) };
}

const CHAVE_TAILWIND3: Record<string, string> = {
  color: "colors",
  font: "fontFamily",
  text: "fontSize",
  "font-weight": "fontWeight",
  spacing: "spacing",
  radius: "borderRadius",
  shadow: "boxShadow",
  ease: "transitionTimingFunction",
};

export function exportar(projectPath: string, home: string, formato: FormatoExport): { nome: string; mime: string; texto: string } {
  const ds = estadoDs(projectPath, home).ds;
  if (!ds) throw Object.assign(new Error("este projeto não tem design system"), { status: 404 });
  const base = ds.id;
  if (formato === "dtcg") return { nome: `${base}.tokens.json`, mime: "application/json", texto: `${JSON.stringify(ds.tokens, null, 2)}\n` };
  if (formato === "css") return { nome: `${base}.tokens.css`, mime: "text/css", texto: `/* ${ds.nome} — gerado pelo Nexos a partir de tokens.json */\n${ds.css}\n` };

  // Tailwind: os nomes mudam de namespace, então referência entre tokens vira o valor final
  const porNome = new Map(ds.vars.map((v) => [v.nome, v]));
  const itens = ds.vars.map((v) => ({ ...nomeTailwind(v.caminho), valor: resolver(v, porNome), bruto: v.bruto }));
  if (formato === "tailwind4") {
    const linhas = itens.filter((i) => i.resto).map((i) => `  --${i.ns}-${i.resto}: ${i.valor};`);
    return { nome: `${base}.theme.css`, mime: "text/css", texto: `/* ${ds.nome} — Tailwind v4 */\n@theme {\n${linhas.join("\n")}\n}\n` };
  }
  const extend: Record<string, Record<string, unknown>> = {};
  for (const i of itens) {
    const chave = CHAVE_TAILWIND3[i.ns];
    if (!chave || !i.resto) continue;
    extend[chave] ??= {};
    extend[chave]![i.resto] = chave === "fontFamily" && Array.isArray(i.bruto) ? i.bruto : i.valor;
  }
  const texto = `// ${ds.nome} — Tailwind v3 (theme.extend)\n/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  theme: {\n    extend: ${JSON.stringify(extend, null, 2).replace(/\n/g, "\n    ")},\n  },\n};\n`;
  return { nome: `${base}.tailwind.config.js`, mime: "text/javascript", texto };
}
