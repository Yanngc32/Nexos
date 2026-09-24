/**
 * Checagens de conformidade dos tokens gerados (Diretor ou plano B sem IA) — a versão Nexos das
 * "conformance checks" da extensão DESIGN.md Inspector, só que sobre o JSON DTCG final em vez da
 * coleta crua. O que a extensão só conferia de existência (tem fundo? tem texto?) aqui vira
 * verificação de verdade: contraste AA calculado, escalas em ordem.
 *
 * Tudo aqui é AVISO, não erro: token com aviso é gravado, e o Diretor ganha uma chance de corrigir.
 * Erro que invalida o JSON (falta token obrigatório, referência quebrada) continua em ds-gerar.ts.
 */

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, `#rrggbbaa` (alfa ignorado) ou `rgb()/rgba()`. Qualquer outra coisa: `null`. */
export function paraRgb(valor: string): Rgb | null {
  const v = valor.trim().toLowerCase();
  const h = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (h) {
    const x = h[1]!.length === 3 ? [...h[1]!].map((c) => c + c).join("") : h[1]!.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)) as Rgb;
  }
  const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? ([m[1], m[2], m[3]].map(Number) as Rgb) : null;
}

/** Luminância relativa (WCAG 2.x). */
export function luminancia([r, g, b]: Rgb): number {
  const c = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

export function contraste(a: Rgb, b: Rgb): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

type No = Record<string, unknown>;

function no(tokens: unknown, caminho: string): No | null {
  let atual: unknown = tokens;
  for (const parte of caminho.split(".")) {
    if (!atual || typeof atual !== "object") return null;
    atual = (atual as No)[parte];
  }
  return atual && typeof atual === "object" && "$value" in (atual as No) ? (atual as No) : null;
}

/** Valor do token no tema (ou o base), seguindo `{referência}` até 5 níveis. */
function valorNoTema(tokens: unknown, caminho: string, tema?: string, nivel = 0): unknown {
  const n = no(tokens, caminho);
  if (!n || nivel > 5) return undefined;
  const temas = (n.$extensions as No | undefined)?.["nexos.temas"] as No | undefined;
  const v = tema && temas && tema in temas ? temas[tema] : n.$value;
  const ref = typeof v === "string" ? v.match(/^\{([a-zA-Z0-9_.-]+)\}$/) : null;
  return ref ? valorNoTema(tokens, ref[1]!, tema, nivel + 1) : v;
}

function temasDe(tokens: unknown, caminhos: string[]): string[] {
  const nomes = new Set<string>();
  for (const c of caminhos) {
    const temas = (no(tokens, c)?.$extensions as No | undefined)?.["nexos.temas"];
    if (temas && typeof temas === "object") for (const t of Object.keys(temas)) nomes.add(t);
  }
  return [...nomes];
}

/** px de `"14px"`, `"0.875rem"` ou `{ value, unit }`. `null` se não der pra comparar. */
function px(v: unknown): number | null {
  if (v && typeof v === "object") {
    const o = v as No;
    return px(`${o.value}${o.unit}`);
  }
  const m = typeof v === "string" ? v.trim().match(/^(-?[\d.]+)(px|rem|em)$/) : null;
  if (!m) return null;
  return m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
}

const PARES_DE_CONTRASTE: [string, string, number, string][] = [
  ["color.text", "color.bg", 4.5, "texto"],
  ["color.text", "color.surface", 4.5, "texto em superfície"],
  ["color.muted", "color.bg", 3, "texto secundário"],
  ["color.on-primary", "color.primary", 3, "texto de botão primário"],
];

const ORDEM_TAMANHO = ["2xs", "xs", "sm", "md", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"];

/** Avisos sobre os tokens: contraste abaixo do AA e escalas fora de ordem. Vazio = conforme. */
export function conferirTokens(tokens: unknown): string[] {
  const avisos: string[] = [];

  for (const [frente, fundo, minimo, papel] of PARES_DE_CONTRASTE) {
    for (const tema of [undefined, ...temasDe(tokens, [frente, fundo])]) {
      const a = valorNoTema(tokens, frente, tema);
      const b = valorNoTema(tokens, fundo, tema);
      const ra = typeof a === "string" ? paraRgb(a) : null;
      const rb = typeof b === "string" ? paraRgb(b) : null;
      if (!ra || !rb) continue; // oklch() e afins: sem conversão aqui, não acusa no escuro
      const c = contraste(ra, rb);
      if (c < minimo) {
        avisos.push(
          `contraste de ${frente} sobre ${fundo}${tema ? ` (tema ${tema})` : ""} é ${c.toFixed(2)}:1 — ${papel} precisa de ${minimo}:1 (WCAG AA)`,
        );
      }
    }
  }

  const tamanhos = ORDEM_TAMANHO.map((k) => [k, px(valorNoTema(tokens, `font.size.${k}`))] as const).filter(([, v]) => v !== null);
  for (let i = 1; i < tamanhos.length; i++) {
    const [k0, v0] = tamanhos[i - 1]!;
    const [k1, v1] = tamanhos[i]!;
    if (v1! <= v0!) avisos.push(`font.size.${k1} (${v1}px) não é maior que font.size.${k0} (${v0}px): a escala tem que subir`);
  }

  const espacos = Object.keys((tokens as { space?: No } | null)?.space ?? {})
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => [k, px(valorNoTema(tokens, `space.${k}`))] as const)
    .filter(([, v]) => v !== null);
  if (espacos.length < 3) avisos.push(`escala de espaço com ${espacos.length} passo(s): precisa de pelo menos 3 (space.1…)`);
  for (let i = 1; i < espacos.length; i++) {
    if (espacos[i]![1]! <= espacos[i - 1]![1]!) {
      avisos.push(`space.${espacos[i]![0]} não é maior que space.${espacos[i - 1]![0]}: a escala tem que subir`);
    }
  }

  const raios = ["sm", "md", "lg"].map((k) => [k, px(valorNoTema(tokens, `radius.${k}`))] as const).filter(([, v]) => v !== null);
  for (let i = 1; i < raios.length; i++) {
    if (raios[i]![1]! < raios[i - 1]![1]!) avisos.push(`radius.${raios[i]![0]} é menor que radius.${raios[i - 1]![0]}`);
  }

  return avisos;
}
