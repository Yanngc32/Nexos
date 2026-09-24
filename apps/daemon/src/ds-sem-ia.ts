import type { Coleta } from "./ds-coleta.ts";
import { conferirTokens, contraste, luminancia, paraRgb } from "./ds-conformidade.ts";

/**
 * Plano B da geração do design system: tokens + DESIGN.md por REGRA, sem modelo — pra quando não
 * há conta de IA, ou a conta falhou (quota, login). Faz o que a extensão DESIGN.md Inspector faz
 * (papel da cor por luminância/saturação, escala a partir do que a página usa), em cima da mesma
 * coleta que o Diretor receberia: a página capturada no Browser, se houver; senão o código.
 *
 * Parte SEMPRE dos tokens atuais do DS e só troca o que a coleta sustenta — o que não deu pra
 * inferir (success/warning/danger, por ex.) fica como estava. Nunca inventa: sem dado, sem troca.
 */

type Rgb = [number, number, number];
type Contagem = [string, number];
type No = Record<string, any>;

export type EntradaSemIa = {
  nome: string;
  /** Tokens atuais do DS (ponto de partida). */
  base: unknown;
  /** `dados` de `ds-extrator.js` (página capturada no Browser). */
  referencia?: { url?: string; dados: Record<string, any> } | null;
  coleta?: Coleta | null;
};

const hex = (rgb: Rgb) => `#${rgb.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

/** Só cor opaca: `#rrggbb@40%` (translúcida) é sobreposição, não papel de paleta. */
function cores(lista: unknown): { hex: string; rgb: Rgb; n: number }[] {
  if (!Array.isArray(lista)) return [];
  const out: { hex: string; rgb: Rgb; n: number }[] = [];
  for (const item of lista) {
    const [v, n] = item as Contagem;
    if (typeof v !== "string" || v.includes("@")) continue;
    const rgb = paraRgb(v);
    if (rgb && !out.some((c) => c.hex === hex(rgb))) out.push({ hex: hex(rgb), rgb, n: Number(n) || 1 });
  }
  return out;
}

function saturacao([r, g, b]: Rgb): number {
  const mx = Math.max(r, g, b);
  return mx ? (mx - Math.min(r, g, b)) / mx : 0;
}

function matiz([r, g, b]: Rgb): number {
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function misturar(a: Rgb, b: Rgb, t: number): Rgb {
  return a.map((x, i) => x + (b[i]! - x) * t) as Rgb;
}

const BRANCO: Rgb = [255, 255, 255];
const PRETO: Rgb = [17, 17, 17];
const melhorSobre = (fundo: Rgb) => (contraste(BRANCO, fundo) >= contraste(PRETO, fundo) ? BRANCO : PRETO);

const pxDe = (v: unknown) => {
  const m = String(v ?? "").match(/^(-?[\d.]+)px/);
  return m ? Number(m[1]) : null;
};

/** Paleta a partir das cores contadas. Cada papel só é preenchido se a coleta sustentar. */
function paleta(fundos: ReturnType<typeof cores>, textos: ReturnType<typeof cores>, bordas: ReturnType<typeof cores>, destaques: ReturnType<typeof cores>) {
  const p: Record<string, Rgb> = {};
  const bg = fundos[0];
  if (!bg) return p;
  p.bg = bg.rgb;
  const lbg = luminancia(bg.rgb);
  const vizinhas = fundos.slice(1).filter((c) => saturacao(c.rgb) < 0.25 && Math.abs(luminancia(c.rgb) - lbg) < 0.25);
  const texto = [...textos].sort((a, b) => b.n - a.n).find((c) => contraste(c.rgb, bg.rgb) >= 4.5);
  p.text = texto?.rgb ?? melhorSobre(bg.rgb);
  p.surface = vizinhas[0]?.rgb ?? misturar(bg.rgb, p.text, 0.05);
  p["surface-2"] = vizinhas[1]?.rgb ?? misturar(bg.rgb, p.text, 0.1);
  const muted = textos.find((c) => c.hex !== hex(p.text!) && contraste(c.rgb, bg.rgb) >= 3 && contraste(c.rgb, p.text!) > 1.3);
  p.muted = muted?.rgb ?? misturar(p.text, bg.rgb, 0.4);
  p.border = bordas.find((c) => c.hex !== bg.hex)?.rgb ?? misturar(bg.rgb, p.text, 0.15);

  // marca: cor saturada, nem quase preta nem quase branca. Sem exigir contraste com o fundo: o
  // amarelo #ffe600 do Mercado Livre sobre branco é marca, e a saturação já o separa do fundo
  const marca = destaques.filter((c) => {
    const l = luminancia(c.rgb);
    return saturacao(c.rgb) > 0.35 && l > 0.03 && l < 0.9;
  });
  const primaria = marca[0];
  if (primaria) {
    p.primary = primaria.rgb;
    p["on-primary"] = melhorSobre(primaria.rgb);
    const h = matiz(primaria.rgb);
    const segunda = marca.find((c) => Math.min(Math.abs(matiz(c.rgb) - h), 360 - Math.abs(matiz(c.rgb) - h)) > 30);
    if (segunda) p.secondary = segunda.rgb;
  }
  return p;
}

/** Soma contagens da mesma cor vindas de listas diferentes (fundo de botão + texto de link…). */
function juntar(...listas: ReturnType<typeof cores>[]): ReturnType<typeof cores> {
  const m = new Map<string, { hex: string; rgb: Rgb; n: number }>();
  for (const l of listas) for (const c of l) m.set(c.hex, { ...c, n: (m.get(c.hex)?.n ?? 0) + c.n });
  return [...m.values()].sort((a, b) => b.n - a.n);
}

const ICONE = /icon|awesome|material symbols|glyph/i;
const MONO = /mono|code|consol|courier|menlo/i;

function familias(nomes: string[]): { body?: string[]; mono?: string[] } {
  const limpos = nomes.map((n) => n.split(",")[0]!.trim().replace(/["']/g, "")).filter((n) => n && !ICONE.test(n));
  const texto = limpos.find((n) => !MONO.test(n) && !/^(serif|sans-serif|monospace|system-ui|inherit)$/i.test(n));
  const mono = limpos.find((n) => MONO.test(n) && !/^monospace$/i.test(n));
  return {
    ...(texto ? { body: [texto, "system-ui", "sans-serif"] } : {}),
    ...(mono ? { mono: [mono, "ui-monospace", "monospace"] } : {}),
  };
}

/** xs…2xl ao redor do tamanho mais usado (o do corpo). Faltou degrau: 1.2× a partir do vizinho. */
function escalaDeFonte(tamanhos: Contagem[]): Record<string, string> | null {
  const usados = tamanhos.map(([v, n]) => [pxDe(v), n] as const).filter(([v]) => v !== null && v >= 8 && v <= 120) as [number, number][];
  if (!usados.length) return null;
  const md = [...usados].sort((a, b) => b[1] - a[1])[0]![0];
  const unicos = [...new Set(usados.map(([v]) => Math.round(v)))].sort((a, b) => a - b);
  const abaixo = unicos.filter((v) => v <= md - 1).reverse();
  const acima = unicos.filter((v) => v >= md + 2);
  const sm = abaixo[0] ?? Math.round(md / 1.15);
  const xs = abaixo.find((v) => v <= sm - 1) ?? Math.max(9, Math.round(sm / 1.15));
  const lg = acima[0] ?? Math.round(md * 1.2);
  const xl = acima.find((v) => v >= lg + 2) ?? Math.round(lg * 1.25);
  const x2 = acima.find((v) => v >= xl + 4) ?? Math.round(xl * 1.33);
  return { xs: `${xs}px`, sm: `${sm}px`, md: `${Math.round(md)}px`, lg: `${lg}px`, xl: `${xl}px`, "2xl": `${x2}px` };
}

/** Os 6 espaçamentos mais usados (até 64px), em ordem. */
function escalaDeEspaco(espacos: Contagem[]): string[] | null {
  const vals = espacos.map(([v, n]) => [pxDe(v), n] as const).filter(([v]) => v !== null && v >= 2 && v <= 64) as [number, number][];
  const escolhidos = [...new Set([...vals].sort((a, b) => b[1] - a[1]).map(([v]) => Math.round(v)))].slice(0, 6).sort((a, b) => a - b);
  return escolhidos.length >= 3 ? escolhidos.map((v) => `${v}px`) : null;
}

function escalaDeRaio(raios: Contagem[]): { sm: string; md: string; lg: string } | null {
  const vals = [...new Set(raios.map(([v]) => pxDe(v)).filter((v): v is number => v !== null && v > 0 && v < 999))].sort((a, b) => a - b);
  if (!vals.length) return null;
  return { sm: `${vals[0]}px`, md: `${vals[Math.floor((vals.length - 1) / 2)]}px`, lg: `${vals[vals.length - 1]}px` };
}

function movimento(transicoes: Contagem[]): { duracao?: string; curva?: string } {
  const t = transicoes[0]?.[0];
  if (typeof t !== "string") return {};
  const m = t.match(/^([\d.]+)(m?s)\b\s*(.*)$/);
  if (!m) return {};
  const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
  // "0.15s, 0.3s ease" (várias propriedades): fica a primeira duração e a primeira curva
  const curva = m[3]!.split(",")[0]!.trim();
  return { ...(ms > 0 && ms <= 1000 ? { duracao: `${Math.round(ms)}ms` } : {}), ...(curva ? { curva } : {}) };
}

/** Papéis a partir das variáveis de :root do código (`--background`, `--primary`…), quando são hex. */
function paletaDoCodigo(c: Coleta): Record<string, Rgb> {
  const p: Record<string, Rgb> = {};
  const regras: [RegExp, string][] = [
    [/(^|-)(bg|background)$/, "bg"],
    [/(^|-)(surface|card)$/, "surface"],
    [/(^|-)(fg|foreground|text)$/, "text"],
    [/(^|-)muted(-foreground)?$/, "muted"],
    [/(^|-)border$/, "border"],
    [/(^|-)(primary|brand)$/, "primary"],
    [/(^|-)secondary$/, "secondary"],
  ];
  for (const [nome, valor] of c.variaveis) {
    const rgb = paraRgb(valor);
    if (!rgb) continue;
    for (const [re, papel] of regras) if (re.test(nome.replace(/^--(color-)?/, "")) && !p[papel]) p[papel] = rgb;
  }
  if (!p.primary) {
    const marca = c.cores.map(([h]) => paraRgb(h)).find((rgb): rgb is Rgb => !!rgb && saturacao(rgb) > 0.35 && luminancia(rgb) > 0.03 && luminancia(rgb) < 0.85);
    if (marca) p.primary = marca;
  }
  if (p.primary) p["on-primary"] = melhorSobre(p.primary);
  return p;
}

/** Troca o `$value` do token (tirando tema: um valor novo com o claro antigo misturaria duas paletas). */
function definir(tokens: No, caminho: string, valor: unknown): void {
  const partes = caminho.split(".");
  let atual = tokens;
  for (const p of partes.slice(0, -1)) atual = atual[p] && typeof atual[p] === "object" ? atual[p] : (atual[p] = {});
  atual[partes.at(-1)!] = { $value: valor };
}

const USO_DA_COR: Record<string, string> = {
  bg: "Fundo da página",
  surface: "Card, painel, área elevada",
  "surface-2": "Superfície sobre superfície (hover, linha zebrada)",
  border: "Borda e divisória",
  text: "Texto principal",
  muted: "Texto secundário, legenda, placeholder",
  primary: "Ação principal e destaque (botão primário, item ativo)",
  "on-primary": "Texto/ícone sobre a cor primária",
  secondary: "Destaque secundário",
  success: "Concluído/aprovado",
  warning: "Alerta",
  danger: "Estado crítico",
};

function designMd(nome: string, tokens: No, origem: string, perfil: No | undefined, avisos: string[]): string {
  const v = (caminho: string) => {
    let n: any = tokens;
    for (const p of caminho.split(".")) n = n?.[p];
    const x = n?.$value;
    return Array.isArray(x) ? x.join(", ") : x === undefined ? "—" : String(x);
  };
  const linhasCor = Object.keys(USO_DA_COR)
    .filter((k) => tokens.color?.[k])
    .map((k) => `| \`--color-${k}\` | \`${v(`color.${k}`)}\` | ${USO_DA_COR[k]} |`);
  const tamanhos = ["xs", "sm", "md", "lg", "xl", "2xl"].filter((k) => tokens.font?.size?.[k]).map((k) => `${k} ${v(`font.size.${k}`)}`);
  const espacos = Object.keys(tokens.space ?? {}).filter((k) => /^\d+$/.test(k)).map((k) => v(`space.${k}`));
  const raios = ["sm", "md", "lg", "pill"].filter((k) => tokens.radius?.[k]).map((k) => `${k} ${v(`radius.${k}`)}`);
  const pesos = Object.keys(tokens.font?.weight ?? {}).filter((k) => !k.startsWith("$")).map((k) => `${k} ${v(`font.weight.${k}`)}`);

  return `# ${nome}

> Gerado **sem IA** (plano B), por regra, a partir de ${origem}. Os papéis de cor saem de luminância e saturação: revise antes de tratar como definitivo.
${perfil?.tipo && perfil.tipo !== "indefinido" ? `\nTipo de site detectado: **${perfil.tipo}** (confiança ${perfil.confianca}).\n` : ""}
## Cor

| Token | Valor | Uso |
|---|---|---|
${linhasCor.join("\n")}

- Cor de marca (\`--color-primary\`) só em ação principal e destaque. Nunca em texto corrido.
- \`--color-warning\` só em alerta; \`--color-success\` só em concluído/aprovado; \`--color-danger\` pra estado crítico, nunca em botão comum.
- Texto sempre em \`--color-text\` ou \`--color-muted\` sobre \`--color-bg\`/\`--color-surface\`.

## Tipografia

- Títulos e KPIs: \`--font-family-display\` (${v("font.family.display")}). Interface: \`--font-family-body\` (${v("font.family.body")}). Código, IDs e valores: \`--font-family-mono\` (${v("font.family.mono")}).
- Escala: ${tamanhos.join(" · ")}. Corpo em \`--font-size-md\`.
- Pesos: ${pesos.join(" · ")}.

## Espaço e forma

- Espaçamento só da escala \`--space-*\` (${espacos.join(" · ")}).
- Raio só de \`--radius-*\` (${raios.join(" · ")}).

## Movimento

- Duração base \`--motion-duration-base\` (${v("motion.duration.base")}), curva \`--motion-ease-base\` (${v("motion.ease.base")}).

## Regra geral

- Componente nunca usa hex/rgb direto: sempre \`var(--token)\`. Faltou um valor? Ele entra em \`tokens.json\`.
${avisos.length ? `\n## Pendências (checagem automática)\n\n${avisos.map((a) => `- ${a}`).join("\n")}\n` : ""}`;
}

/** Tokens e DESIGN.md sem modelo. `origem` diz de onde veio, pro título da etapa e o DESIGN.md. */
export function designSemIa(e: EntradaSemIa): { tokens: No; designMd: string; origem: string } {
  const tokens: No = structuredClone(e.base && typeof e.base === "object" ? e.base : {});
  const d = e.referencia?.dados;
  let p: Record<string, Rgb> = {};
  let origem = "o código do projeto";

  if (d) {
    origem = e.referencia?.url ? `a página ${e.referencia.url}` : "a página capturada no Browser";
    const botoes = cores((Array.isArray(d.botoes) ? d.botoes : []).map((b: No) => [b.fundo, 3]));
    p = paleta(cores(d.cores?.fundo), cores(d.cores?.texto), cores(d.cores?.borda), juntar(botoes, cores(d.cores?.fundo), cores(d.cores?.texto), cores(d.cores?.borda)));
    const f = familias((d.fontes ?? []).map(([n]: Contagem) => n));
    if (f.body) {
      definir(tokens, "font.family.body", f.body);
      definir(tokens, "font.family.display", f.body);
    }
    if (f.mono) definir(tokens, "font.family.mono", f.mono);
    const tam = escalaDeFonte(d.tamanhos ?? []);
    if (tam) for (const [k, val] of Object.entries(tam)) definir(tokens, `font.size.${k}`, val);
    const pesos = (d.pesos ?? []).map(([w]: Contagem) => Number(w)).filter((w: number) => w >= 100 && w <= 900);
    if (pesos.length) {
      const regular = pesos.includes(400) ? 400 : Math.min(...pesos);
      const bold = Math.max(...pesos) >= 600 ? Math.max(...pesos) : 700;
      const meio = pesos.filter((w: number) => w > regular && w < bold).sort((a: number, b: number) => Math.abs(a - 550) - Math.abs(b - 550))[0];
      definir(tokens, "font.weight.regular", regular);
      definir(tokens, "font.weight.medium", meio ?? Math.min(bold, 600));
      definir(tokens, "font.weight.bold", bold);
    }
    const esp = escalaDeEspaco(d.espacos ?? []);
    if (esp) {
      if (tokens.space) for (const k of Object.keys(tokens.space)) if (/^\d+$/.test(k)) delete tokens.space[k];
      esp.forEach((val, i) => definir(tokens, `space.${i + 1}`, val));
    }
    const r = escalaDeRaio(d.raios ?? []);
    if (r) for (const [k, val] of Object.entries(r)) definir(tokens, `radius.${k}`, val);
    const sombras = (d.sombras ?? []).map(([s]: Contagem) => s).filter((s: unknown) => typeof s === "string");
    sombras.slice(0, 2).forEach((s: string, i: number) => definir(tokens, `shadow.${i + 1}`, s));
    const mov = movimento(d.transicoes ?? []);
    if (mov.duracao) definir(tokens, "motion.duration.base", mov.duracao);
    if (mov.curva) definir(tokens, "motion.ease.base", mov.curva);
  } else if (e.coleta) {
    p = paletaDoCodigo(e.coleta);
    const f = familias(e.coleta.fontes.map(([n]) => n));
    if (f.body) {
      definir(tokens, "font.family.body", f.body);
      definir(tokens, "font.family.display", f.body);
    }
    if (f.mono) definir(tokens, "font.family.mono", f.mono);
  }

  for (const [papel, rgb] of Object.entries(p)) definir(tokens, `color.${papel}`, hex(rgb));
  if (tokens.color && !tokens.color.$type) tokens.color.$type = "color";

  const avisos = conferirTokens(tokens);
  return { tokens, designMd: designMd(e.nome, tokens, origem, d?.perfil, avisos), origem };
}
