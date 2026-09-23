import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { estadoDs, salvarTokens, type DsCompleto, type DsVar } from "./design-system.ts";
import { coletarDoCodigo } from "./ds-coleta.ts";
import { garantirKit } from "./ds-kit.ts";

/**
 * Design system ↔ código do projeto (spec §6, Fase 5):
 *
 * - `blocoDoDsParaPack`: o que entra no contexto de TODA conversa do projeto quando há DS ativo —
 *   é o que faz o agente usar os tokens ao mexer no front, que é o ponto do DS existir.
 * - `conformidade`: varre o front atrás de cor (hex) e tamanho (px/rem em fonte, espaço, raio) soltos e diz qual token usar. Sem LLM:
 *   determinístico, instantâneo e de graça — o agente só entra se a pessoa pedir a correção.
 * - `ressincronizar`: o que o código usa e o DS não tem (e o contrário).
 * - `exportar`: CSS vars, Tailwind v4 `@theme`, Tailwind v3 `theme.extend`, DTCG.
 */

const DESIGN_MD_NO_PACK = 2500;
const VARS_NO_PACK = 60;
const AVISOS_NO_PACK = 12;

export function blocoDoDsParaPack(projectPath: string, home: string): string | null {
  let ds: DsCompleto | null = null;
  try {
    ds = estadoDs(projectPath, home).ds;
  } catch {
    return null;
  }
  if (!ds) return null;
  garantirKit(ds.pastaAbs);
  const regras = ds.designMd.trim();
  const tokens = ds.vars
    .slice(0, VARS_NO_PACK)
    .map((v) => `${v.nome}: ${v.valor}`)
    .join("\n");
  // spec §4: edição livre pelo chat não tem reenvio automático — o aviso vai no próximo turno
  const avisos = [
    ...ds.tokensLint.map((l) => `- tokens.json: ${l.msg}`),
    ...ds.cards.flatMap((c) => c.lint.map((l) => `- cards/${c.id}.html: ${l.msg}${l.trecho ? ` (\`${l.trecho}\`)` : ""}`)),
  ];
  return [
    `# Design system do projeto: ${ds.nome}`,
    `Pasta: ${ds.pastaAbs} (tokens.json, DESIGN.md e cards/<id>.html — pode ler e editar).`,
    "Ao criar ou mudar o front deste projeto: use estes tokens (cor, fonte, espaço, raio, sombra) no lugar de " +
      "valor solto e siga as regras de uso. Faltou um token? Proponha adicionar em tokens.json em vez de inventar um hex. " +
      "Pra ver como um componente deve ficar, leia o card dele na pasta acima. Pra CRIAR card, apagar " +
      "ou reorganizar o board (\"alinha os cards\"), leia KIT.md na pasta: classes prontas e o layout do meta.json. " +
      "Depois de criar ou editar um card, confira o visual com `nexo_ds_print` (print do card renderizado) antes de dar por pronto. " +
      "Pra mostrar uma tela ou ideia SEM mexer neste DS: `nexo_ds_criar` (ex.: \"Mocks\", base \"ativo\" copia o visual), " +
      "`nexo_ds_card_salvar` pra cada tela e `nexo_ds_ativar` pra voltar.",
    regras ? `## Regras de uso (DESIGN.md)\n${regras.length > DESIGN_MD_NO_PACK ? `${regras.slice(0, DESIGN_MD_NO_PACK)}…` : regras}` : "",
    tokens ? `## Tokens (variável CSS → valor)\n${tokens}${ds.vars.length > VARS_NO_PACK ? `\n… (${ds.vars.length - VARS_NO_PACK} a mais em tokens.json)` : ""}` : "",
    avisos.length
      ? `## Avisos pendentes no DS (corrija se for mexer nesses arquivos)\n${avisos.slice(0, AVISOS_NO_PACK).join("\n")}${
          avisos.length > AVISOS_NO_PACK ? `\n… e mais ${avisos.length - AVISOS_NO_PACK}` : ""
        }`
      : "",
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

export type Classe = "exato" | "perto" | "fora";
export type GrupoTamanho = "fonte" | "espaco" | "raio";

export type Achado = {
  arquivo: string;
  linha: number;
  /** "cor" = hex solto; "tamanho" = px/rem solto em fonte, espaçamento ou raio. */
  tipo: "cor" | "tamanho";
  /** Só tamanho: que grupo de token vale ali. */
  grupo?: GrupoTamanho;
  valor: string;
  classe: Classe;
  /** Token com exatamente esse valor. */
  exato?: string;
  /** Senão, o token mais perto e quão longe (cor: distância perceptual; tamanho: px). */
  sugestao?: { token: string; valor: string; distancia: number };
};

export type Conformidade = {
  arquivosLidos: number;
  total: number;
  cores: number;
  tamanhos: number;
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
  // declaração de variável (`--x: #abc`) é definição de token no código — isso é assunto da ressincronia
  if (/--[\w-]+\s*:[^;{}]*$/.test(antes)) return false;
  // seletor de id no CSS: "#abc {" ou "#abc," no começo da linha
  if (/^\s*$/.test(antes) && /^#[\w-]+\s*[{,]/.test(linha.slice(idx))) return false;
  return true;
}

/* ---------- tamanhos soltos: fonte, espaçamento, raio ---------- */

type MedidaDoToken = { nome: string; valor: string; px: number };

/** px de "12px" / "0.75rem" (rem = 16px); outro formato (%, em, calc) não entra. */
function emPx(valor: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(valor.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "rem" ? n * 16 : n;
}

/** Em que grupo o token cai, pelo caminho (`font.size.sm`, `space.4`, `radius.md`). */
function grupoDoCaminho(caminho: string): GrupoTamanho | null {
  const c = caminho.toLowerCase();
  if (/(^|\.)(font|text|type)[^.]*\.(size|sizes)(\.|$)|fontsize|font-size/.test(c) || /^text\./.test(c)) return "fonte";
  if (/(^|\.)(radius|radii|rounded|corner)/.test(c)) return "raio";
  if (/(^|\.)(space|spacing|spacings|gap|inset|gutter)/.test(c)) return "espaco";
  return null;
}

function tamanhosDosTokens(ds: DsCompleto): Record<GrupoTamanho, MedidaDoToken[]> {
  const porNome = new Map(ds.vars.map((v) => [v.nome, v]));
  const out: Record<GrupoTamanho, MedidaDoToken[]> = { fonte: [], espaco: [], raio: [] };
  for (const v of ds.vars) {
    const grupo = grupoDoCaminho(v.caminho);
    if (!grupo) continue;
    const valor = resolver(v, porNome).trim();
    const px = emPx(valor);
    if (px !== null) out[grupo].push({ nome: v.nome, valor, px });
  }
  return out;
}

/** Propriedade CSS (ou camelCase em style de JSX) → grupo de token que vale nela. */
const PROP_RE =
  /(?:^|[\s;{("'])(font-size|fontSize|padding(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|padding(?:Top|Right|Bottom|Left|Inline|Block)?|margin(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|margin(?:Top|Right|Bottom|Left|Inline|Block)?|gap|row-gap|column-gap|rowGap|columnGap|border-radius|borderRadius|border-(?:top|bottom)-(?:left|right)-radius)["']?\s*:\s*([^;{}\n]+)/g;
const MEDIDA_RE = /(?<![\w.#-])(\d*\.?\d+)(px|rem)\b/g;
/** Tolerância pra "perto": 1px (13 vs 14 é digitado à mão; 13 vs 16 já é outro tamanho). */
const PERTO_PX = 1;

function grupoDaProp(prop: string): GrupoTamanho {
  if (/font/i.test(prop)) return "fonte";
  if (/radius/i.test(prop)) return "raio";
  return "espaco";
}

function tamanhosSoltos(linha: string, medidas: Record<GrupoTamanho, MedidaDoToken[]>): Omit<Achado, "arquivo" | "linha">[] {
  if (/^\s*(\/\/|\*|<!--)/.test(linha)) return [];
  const out: Omit<Achado, "arquivo" | "linha">[] = [];
  for (const p of linha.matchAll(PROP_RE)) {
    const idx = p.index! + p[0].length - p[2]!.length;
    const antes = linha.slice(0, idx);
    if (antes.lastIndexOf("/*") > antes.lastIndexOf("*/")) continue;
    const grupo = grupoDaProp(p[1]!);
    const tokens = medidas[grupo];
    for (const m of p[2]!.matchAll(MEDIDA_RE)) {
      const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
      // 0 e hairline (1px) não são escala; sem token no grupo não há o que sugerir
      if (px < 2 || !tokens.length) continue;
      let melhor = tokens[0]!;
      for (const t of tokens) if (Math.abs(t.px - px) < Math.abs(melhor.px - px)) melhor = t;
      const d = Math.abs(melhor.px - px);
      const a: Omit<Achado, "arquivo" | "linha"> = { tipo: "tamanho", grupo, valor: m[0], classe: "fora" };
      if (d === 0) {
        a.classe = "exato";
        a.exato = melhor.nome;
      } else {
        a.sugestao = { token: melhor.nome, valor: melhor.valor, distancia: Math.round(d * 100) / 100 };
        if (d <= PERTO_PX) a.classe = "perto";
      }
      out.push(a);
    }
  }
  return out;
}

export function conformidade(projectPath: string, home: string): Conformidade {
  const ds = estadoDs(projectPath, home).ds;
  if (!ds) throw Object.assign(new Error("este projeto não tem design system"), { status: 404 });
  const cores = coresDosTokens(ds);
  const exatoPorHex = new Map<string, string>();
  for (const c of cores) if (!exatoPorHex.has(c.hex)) exatoPorHex.set(c.hex, c.nome);

  const medidas = tamanhosDosTokens(ds);

  const achados: Achado[] = [];
  const contagem = new Map<string, number>();
  const conta = { cor: 0, tamanho: 0, exato: 0, perto: 0, fora: 0 };
  const registrar = (a: Achado): void => {
    conta[a.tipo] += 1;
    conta[a.classe] += 1;
    contagem.set(a.arquivo, (contagem.get(a.arquivo) ?? 0) + 1);
    if (achados.length < MAX_ACHADOS) achados.push(a);
  };
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
        const exato = exatoPorHex.get(hex);
        const achado: Achado = { arquivo: rel, linha: i + 1, tipo: "cor", valor: m[0], classe: "fora" };
        if (exato) {
          achado.classe = "exato";
          achado.exato = exato;
        } else {
          const t = tokenMaisPerto(hex, cores);
          if (t) {
            achado.sugestao = { token: t.token.nome, valor: t.token.hex, distancia: t.distancia };
            if (t.distancia <= PERTO) achado.classe = "perto";
          }
        }
        registrar(achado);
      }
      for (const a of tamanhosSoltos(linha, medidas)) registrar({ arquivo: rel, linha: i + 1, ...a });
    }
  }
  return {
    arquivosLidos: arquivos.length,
    total: conta.cor + conta.tamanho,
    cores: conta.cor,
    tamanhos: conta.tamanho,
    exatos: conta.exato,
    perto: conta.perto,
    foraDaPaleta: conta.fora,
    porArquivo: [...contagem].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([arquivo, n]) => ({ arquivo, n })),
    achados,
  };
}

/* ---------------------------------------------------------------------------
 * Ressincronizar (código → DS)
 * ------------------------------------------------------------------------- */

export type Ressincronia = {
  /** Hash do tokens.json lido — volta no `aplicar` pra não gravar por cima de edição feita no meio. */
  base: string;
  /** Cores que o código usa bastante e nenhum token cobre (nem de perto). */
  coresNovas: { hex: string; usos: number; nomeSugerido: string; maisPerto?: { token: string; distancia: number } }[];
  /** Tokens de cor cujo valor não aparece no código (pode ser que o código use outra coisa). */
  coresSemUso: { token: string; hex: string; usadoEmCards: boolean }[];
  /** Fontes declaradas no código que não estão em nenhum token de fonte. */
  fontesNovas: { familia: string; usos: number; nomeSugerido: string }[];
  /** O código declara `--token: valor` com o mesmo nome de um token do DS, mas outro valor. */
  valoresAlterados: { token: string; noDs: string; noCodigo: string }[];
};

/** Nome curto pela matiz — "green", "blue-2"… — pra pessoa não ter que inventar na hora. */
function nomePelaCor(hex: string): string {
  const [r, g, b] = rgbDe(hex)!.map((n) => n / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (sat < 0.15) return l > 0.85 ? "white" : l < 0.12 ? "black" : "gray";
  const d = max - min;
  const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const hue = (h + 360) % 360;
  const faixas: [number, string][] = [[15, "red"], [40, "orange"], [65, "yellow"], [160, "green"], [195, "teal"], [250, "blue"], [290, "purple"], [340, "pink"], [360, "red"]];
  return faixas.find(([limite]) => hue < limite)![1];
}

function semColisao(base: string, usados: Set<string>): string {
  let nome = base;
  for (let i = 2; usados.has(nome); i++) nome = `${base}-${i}`;
  usados.add(nome);
  return nome;
}

function mesmoValor(a: string, b: string): boolean {
  const ha = normalizarHex(a.trim());
  const hb = normalizarHex(b.trim());
  if (ha && hb) return ha === hb;
  const n = (x: string) => x.trim().toLowerCase().replace(/\s+/g, " ").replace(/["']/g, "");
  return n(a) === n(b);
}

/** Onde entram tokens novos de cor: o grupo em que as cores do DS já estão (`color`, `colors`…). */
function grupoDasCores(ds: DsCompleto): string {
  const primeira = ds.vars.find((v) => (v.tipo === "color" || (!v.tipo && normalizarHex(v.valor))) && v.caminho.includes("."));
  return primeira ? primeira.caminho.slice(0, primeira.caminho.lastIndexOf(".")) : "color";
}

function grupoDasFontes(ds: DsCompleto): string {
  const primeira = ds.vars.find((v) => v.tipo === "fontFamily" && v.caminho.includes("."));
  return primeira ? primeira.caminho.slice(0, primeira.caminho.lastIndexOf(".")) : "font.family";
}

export function ressincronizar(projectPath: string, home: string): Ressincronia {
  const est = estadoDs(projectPath, home);
  const ds = est.ds;
  if (!ds) throw Object.assign(new Error("este projeto não tem design system"), { status: 404 });
  const coleta = coletarDoCodigo(projectPath);
  const cores = coresDosTokens(ds);
  const usadas = new Set<string>();
  const coresNovas: Ressincronia["coresNovas"] = [];
  const grupoCor = grupoDasCores(ds);
  const nomesCor = new Set(ds.vars.filter((v) => v.caminho.startsWith(`${grupoCor}.`)).map((v) => v.caminho.slice(grupoCor.length + 1)));
  for (const [hexBruto, usos] of coleta.cores) {
    const hex = normalizarHex(hexBruto);
    if (!hex) continue;
    usadas.add(hex);
    const t = tokenMaisPerto(hex, cores);
    if (usos >= 3 && (!t || t.distancia > PERTO) && !coresNovas.some((c) => c.hex === hex)) {
      coresNovas.push({
        hex,
        usos,
        nomeSugerido: semColisao(nomePelaCor(hex), nomesCor),
        ...(t ? { maisPerto: { token: t.token.nome, distancia: t.distancia } } : {}),
      });
    }
  }
  // token que outro token ou um card usa não pode sumir (quebraria o card / a referência)
  const textoDosCards = ds.cards.map((c) => c.html).join("\n");
  const referenciado = (nome: string) =>
    textoDosCards.includes(`var(${nome}`) || ds.vars.some((v) => v.nome !== nome && v.valor.includes(`var(${nome})`));
  const coresSemUso = cores
    .filter((c) => !usadas.has(c.hex))
    .map((c) => ({ token: c.nome, hex: c.hex, usadoEmCards: referenciado(c.nome) }));
  const familiasDoDs = ds.vars
    .filter((v) => v.tipo === "fontFamily" || /family/i.test(v.caminho))
    .flatMap((v) => v.valor.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase()));
  const grupoFonte = grupoDasFontes(ds);
  const nomesFonte = new Set(ds.vars.filter((v) => v.caminho.startsWith(`${grupoFonte}.`)).map((v) => v.caminho.slice(grupoFonte.length + 1)));
  const fontesNovas = coleta.fontes
    .map(([f, usos]) => ({ familia: f.split(",")[0]!.trim().replace(/^["']|["']$/g, ""), usos }))
    .filter((f) => f.familia && !familiasDoDs.includes(f.familia.toLowerCase()))
    .slice(0, 10)
    .map((f) => ({
      ...f,
      nomeSugerido: semColisao(f.familia.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "fonte", nomesFonte),
    }));
  const porNome = new Map(ds.vars.map((v) => [v.nome, v]));
  const valoresAlterados: Ressincronia["valoresAlterados"] = [];
  for (const [nome, valor] of coleta.variaveis) {
    const v = porNome.get(nome);
    if (!v || /^var\(/.test(valor.trim()) || mesmoValor(resolver(v, porNome), valor)) continue;
    valoresAlterados.push({ token: nome, noDs: v.valor, noCodigo: valor.trim() });
  }
  return {
    base: ds.tokensHash,
    coresNovas: coresNovas.slice(0, 20),
    coresSemUso: coresSemUso.slice(0, 30),
    fontesNovas,
    valoresAlterados: valoresAlterados.slice(0, 30),
  };
}

export type ItemRessincronia =
  | { acao: "adicionar-cor"; hex: string; nome: string }
  | { acao: "adicionar-fonte"; familia: string; nome: string }
  | { acao: "atualizar"; token: string; valor: string }
  | { acao: "remover"; token: string };

const NOME_TOKEN_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function noDoCaminho(raiz: Record<string, unknown>, caminho: string[], criar: boolean): Record<string, unknown> | null {
  let no = raiz;
  for (const parte of caminho) {
    const prox = no[parte];
    if (prox && typeof prox === "object" && !Array.isArray(prox)) no = prox as Record<string, unknown>;
    else if (criar && prox === undefined) no = no[parte] = {} as Record<string, unknown>;
    else return null;
  }
  return no;
}

/**
 * Aplica o que a pessoa aprovou na ressincronia, direto no tokens.json (sem LLM). Os cards não
 * precisam ser regerados: eles leem os tokens por CSS var, então um valor novo já aparece neles.
 */
export function aplicarRessincronia(projectPath: string, home: string, base: string, itens: ItemRessincronia[]): DsCompleto {
  const ds = estadoDs(projectPath, home).ds;
  if (!ds) throw Object.assign(new Error("este projeto não tem design system"), { status: 404 });
  if (!Array.isArray(itens) || !itens.length) throw Object.assign(new Error("nenhum item pra aplicar"), { status: 400 });
  const tokens = structuredClone(ds.tokens) as Record<string, unknown>;
  const porNome = new Map(ds.vars.map((v) => [v.nome, v]));
  const falha = (msg: string) => Object.assign(new Error(msg), { status: 400 });
  for (const it of itens) {
    if (it.acao === "adicionar-cor" || it.acao === "adicionar-fonte") {
      if (!NOME_TOKEN_RE.test(it.nome ?? "")) throw falha(`nome inválido: "${it.nome}" (use a-z, 0-9 e hífen)`);
      const grupo = (it.acao === "adicionar-cor" ? grupoDasCores(ds) : grupoDasFontes(ds)).split(".");
      const no = noDoCaminho(tokens, grupo, true);
      if (!no) throw falha(`não dá pra criar o grupo ${grupo.join(".")} no tokens.json`);
      if (it.nome in no) throw falha(`já existe ${grupo.join(".")}.${it.nome}`);
      if (it.acao === "adicionar-cor") {
        const hex = normalizarHex(it.hex ?? "");
        if (!hex) throw falha(`cor inválida: ${it.hex}`);
        no[it.nome] = no.$type === "color" ? { $value: hex } : { $type: "color", $value: hex };
      } else {
        const familia = String(it.familia ?? "").trim();
        if (!familia || /[;{}<>]/.test(familia)) throw falha("família de fonte inválida");
        const valor = [familia, "system-ui", "sans-serif"];
        no[it.nome] = no.$type === "fontFamily" ? { $value: valor } : { $type: "fontFamily", $value: valor };
      }
    } else if (it.acao === "atualizar" || it.acao === "remover") {
      const v = porNome.get(it.token);
      if (!v) throw falha(`token não existe: ${it.token}`);
      const partes = v.caminho.split(".");
      const pai = noDoCaminho(tokens, partes.slice(0, -1), false);
      const folha = pai?.[partes.at(-1)!];
      if (!pai || !folha || typeof folha !== "object" || !("$value" in folha)) {
        throw falha(`${it.token} não é um token editável (é campo de um composto?)`);
      }
      if (it.acao === "remover") delete pai[partes.at(-1)!];
      else {
        const valor = String(it.valor ?? "").trim();
        if (!valor || /[;{}<>]/.test(valor)) throw falha(`valor inválido pra ${it.token}`);
        (folha as Record<string, unknown>).$value = valor;
      }
    } else throw falha("ação desconhecida");
  }
  return salvarTokens(projectPath, home, tokens, base);
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
