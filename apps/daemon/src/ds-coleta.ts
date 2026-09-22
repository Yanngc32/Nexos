import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/**
 * Coleta de contexto pra geração do design system (spec §3, passo 1) — sem LLM. Varre o código
 * do projeto (e, se houver, uma URL de referência) atrás do que já define a linguagem visual:
 * variáveis CSS, cores mais usadas, fontes, config do Tailwind e arquivos de logo.
 *
 * O resultado é um resumo em texto, curto, que vai no pedido do agente "Diretor". Não substitui
 * o agente olhar o código (quem tem ferramenta olha), mas garante o mínimo pra quem não tem
 * (motor `api`) e poupa o agente de gastar turno procurando o óbvio.
 */

export type Coleta = {
  variaveis: [string, string][];
  cores: [string, number][];
  fontes: [string, number][];
  tailwind: string[];
  logos: string[];
  arquivosLidos: number;
  url?: { endereco: string; titulo?: string; themeColor?: string; erro?: string };
};

const PULAR_PASTA = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage", "vendor",
  "target", ".venv", "venv", "__pycache__", ".turbo", ".cache", "daemon-dist", ".versoes",
]);
const EXT_ESTILO = new Set([".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte", ".astro"]);
const EXT_CODIGO = new Set([".tsx", ".jsx"]);
const EXT_LOGO = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const MAX_ARQUIVOS = 1500;
const MAX_BYTES_ARQUIVO = 200_000;
const MAX_BYTES_TOTAL = 4_000_000;
const PROFUNDIDADE = 8;

type Acumulador = {
  vars: Map<string, string>;
  cores: Map<string, number>;
  fontes: Map<string, number>;
  tailwind: string[];
};

function novoAcumulador(): Acumulador {
  return { vars: new Map(), cores: new Map(), fontes: new Map(), tailwind: [] };
}

function normalizarHex(h: string): string {
  const x = h.toLowerCase();
  return x.length === 4 ? `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}` : x;
}

/** Tira o que é de outro assunto (comentário, data URI) antes de contar cor. */
function extrair(texto: string, acc: Acumulador): void {
  const limpo = texto.replace(/\/\*[\s\S]*?\*\//g, "").replace(/data:[^"')\s]+/g, "");
  for (const m of limpo.matchAll(/(--[a-zA-Z0-9-]{2,60})\s*:\s*([^;{}\n]{1,120})[;}\n]/g)) {
    if (acc.vars.size >= 120) break;
    if (!acc.vars.has(m[1]!)) acc.vars.set(m[1]!, m[2]!.trim());
  }
  for (const m of limpo.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
    const h = normalizarHex(m[0]);
    acc.cores.set(h, (acc.cores.get(h) ?? 0) + 1);
  }
  for (const m of limpo.matchAll(/font-family\s*:\s*([^;{}\n]{2,160})/gi)) {
    const f = m[1]!.trim().replace(/\s*!important$/, "");
    if (f.startsWith("var(")) continue;
    acc.fontes.set(f, (acc.fontes.get(f) ?? 0) + 1);
  }
  const theme = limpo.match(/@theme\b[^{]*\{[\s\S]{0,3000}?\}/);
  if (theme && acc.tailwind.length < 3) acc.tailwind.push(theme[0].slice(0, 3000));
}

function topo<T>(m: Map<T, number>, n: number): [T, number][] {
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Varre o projeto. `ignorar` = caminhos absolutos que não entram (a própria pasta do DS). */
export function coletarDoCodigo(projectPath: string, ignorar: string[] = []): Coleta {
  const acc = novoAcumulador();
  const logos: string[] = [];
  let lidos = 0;
  let bytes = 0;
  const ignorarNorm = ignorar.map((p) => p.toLowerCase());

  const andar = (dir: string, nivel: number): void => {
    if (nivel > PROFUNDIDADE || lidos >= MAX_ARQUIVOS || bytes >= MAX_BYTES_TOTAL) return;
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (lidos >= MAX_ARQUIVOS || bytes >= MAX_BYTES_TOTAL) return;
      const caminho = join(dir, e.name);
      if (ignorarNorm.some((p) => caminho.toLowerCase().startsWith(p))) continue;
      if (e.isDirectory()) {
        if (!PULAR_PASTA.has(e.name) && !e.name.startsWith(".")) andar(caminho, nivel + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      if (EXT_LOGO.has(ext) && /logo|brand|marca/i.test(e.name) && logos.length < 12) {
        logos.push(relative(projectPath, caminho).split(sep).join("/"));
      }
      const ehTailwind = /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(e.name);
      if (!EXT_ESTILO.has(ext) && !EXT_CODIGO.has(ext) && !ehTailwind) continue;
      let tam = 0;
      try {
        tam = statSync(caminho).size;
      } catch {
        continue;
      }
      if (tam > MAX_BYTES_ARQUIVO) continue;
      let texto: string;
      try {
        texto = readFileSync(caminho, "utf8");
      } catch {
        continue;
      }
      lidos += 1;
      bytes += tam;
      if (ehTailwind) {
        if (acc.tailwind.length < 3) acc.tailwind.push(`// ${relative(projectPath, caminho)}\n${texto.slice(0, 3000)}`);
        continue;
      }
      extrair(texto, acc);
    }
  };
  andar(projectPath, 0);

  return {
    variaveis: [...acc.vars].slice(0, 80),
    cores: topo(acc.cores, 20),
    fontes: topo(acc.fontes, 8),
    tailwind: acc.tailwind,
    logos,
    arquivosLidos: lidos,
  };
}

async function baixarTexto(url: string, ms: number, max: number): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 Nexos-DS" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const texto = await res.text();
    return texto.slice(0, max);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Lê a URL de referência: HTML + até 5 folhas de estilo. Só texto — sem screenshot (o daemon não
 * tem navegador; o agente com ferramenta pode abrir a página por conta própria).
 */
export async function coletarDaUrl(endereco: string, coleta: Coleta): Promise<Coleta> {
  let u: URL;
  try {
    u = new URL(endereco);
    if (!/^https?:$/.test(u.protocol)) throw new Error("só http(s)");
  } catch (e) {
    return { ...coleta, url: { endereco, erro: `URL inválida: ${(e as Error).message}` } };
  }
  const acc = novoAcumulador();
  try {
    const html = await baixarTexto(u.href, 8000, 600_000);
    extrair(html, acc);
    const titulo = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim();
    const themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const folhas = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
      .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1])
      .filter((h): h is string => !!h)
      .slice(0, 5);
    await Promise.allSettled(
      folhas.map(async (h) => {
        const css = await baixarTexto(new URL(h, u).href, 8000, 800_000);
        extrair(css, acc);
      }),
    );
    // o que veio da URL vai na frente: é a referência que a pessoa escolheu
    const cores = new Map(coleta.cores);
    for (const [c, n] of acc.cores) cores.set(c, (cores.get(c) ?? 0) + n * 3);
    const fontes = new Map(coleta.fontes);
    for (const [f, n] of acc.fontes) fontes.set(f, (fontes.get(f) ?? 0) + n * 3);
    return {
      ...coleta,
      variaveis: [...acc.vars, ...coleta.variaveis].slice(0, 80),
      cores: topo(cores, 20),
      fontes: topo(fontes, 8),
      url: { endereco: u.href, ...(titulo ? { titulo } : {}), ...(themeColor ? { themeColor } : {}) },
    };
  } catch (e) {
    return { ...coleta, url: { endereco: u.href, erro: (e as Error).message } };
  }
}

export function coletaVazia(): Coleta {
  return { variaveis: [], cores: [], fontes: [], tailwind: [], logos: [], arquivosLidos: 0 };
}

/** Resumo em markdown pro pedido do agente. */
export function resumoDaColeta(c: Coleta): string {
  const partes: string[] = [];
  if (c.url) {
    partes.push(
      c.url.erro
        ? `Referência: ${c.url.endereco} (não consegui ler: ${c.url.erro})`
        : `Referência: ${c.url.endereco}${c.url.titulo ? ` — "${c.url.titulo}"` : ""}${c.url.themeColor ? ` · theme-color ${c.url.themeColor}` : ""}`,
    );
  }
  if (c.arquivosLidos) partes.push(`Arquivos de estilo lidos no projeto: ${c.arquivosLidos}.`);
  if (c.cores.length) partes.push(`Cores mais usadas (hex · ocorrências):\n${c.cores.map(([h, n]) => `- ${h} · ${n}`).join("\n")}`);
  if (c.fontes.length) partes.push(`Fontes declaradas:\n${c.fontes.map(([f, n]) => `- ${f} · ${n}`).join("\n")}`);
  if (c.variaveis.length) partes.push(`Variáveis CSS existentes:\n${c.variaveis.slice(0, 60).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  if (c.tailwind.length) partes.push(`Tema do Tailwind:\n\`\`\`\n${c.tailwind.join("\n\n").slice(0, 4000)}\n\`\`\``);
  if (c.logos.length) partes.push(`Arquivos de logo no projeto (caminho relativo à raiz):\n${c.logos.map((l) => `- ${l}`).join("\n")}`);
  return partes.join("\n\n") || "Nada de estilo encontrado no projeto.";
}
