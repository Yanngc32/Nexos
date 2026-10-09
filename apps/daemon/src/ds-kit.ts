import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DsVar } from "./design-system.ts";

/**
 * Kit do Canvas: as classes que todo card já tem carregadas (o Canvas injeta `KIT_CSS` no iframe),
 * os modelos por tipo de card e os cards de Fundamentos. Uma fonte só pro Canvas, pros pedidos de
 * geração e pro `KIT.md` que o agente do chat lê — card criado à mão, pela IA ou gerado dos tokens
 * sai com o mesmo visual.
 */

/*
 * Molduras de aparelho pra mock de tela (`.k-celular`, `.k-notebook`). Portadas pra CSS puro de
 * Opensource UI (https://opensourceui.in) — Copyright (c) 2026 Bidyut Kundu, licença MIT
 * (phone-mockup-card e laptop-mockup-card; ver THIRD_PARTY_NOTICES.md). Cores da moldura são do
 * aparelho, não do design system: ficam fixas, só trocam por `data-cor`.
 */
const KIT_APARELHOS_CSS = `.k-celular{--k-w:var(--k-celular-w,256px);--k-moldura:#4a4254;--k-botao:#423d4d;position:relative;box-sizing:border-box;flex:none;width:var(--k-w);aspect-ratio:70.6/146.6;padding:2px;border-radius:calc(var(--k-w)*.1625);background:var(--k-moldura)}
.k-celular[data-cor=laranja]{--k-moldura:#d4845a;--k-botao:#cc7a50}
.k-celular[data-cor=branco]{--k-moldura:#e4e4e8;--k-botao:#d8d8de}
.k-celular[data-cor=titanio]{--k-moldura:#9a9590;--k-botao:#8f8a85}
.k-celular[data-cor=cereja]{--k-moldura:#d49aa8;--k-botao:#ca90a0}
.k-celular::before{content:"";position:absolute;right:-2px;top:23%;width:2px;height:11.5%;border-radius:0 2px 2px 0;background:var(--k-botao)}
.k-celular::after{content:"";position:absolute;left:-2px;top:15.5%;width:2px;height:22.2%;border-radius:2px 0 0 2px;background:linear-gradient(to bottom,var(--k-botao) 0 14.4%,transparent 14.4% 24.8%,var(--k-botao) 24.8% 57.2%,transparent 57.2% 67.6%,var(--k-botao) 67.6% 100%)}
.k-celular>.k-tela{position:relative;box-sizing:border-box;height:100%;overflow:hidden;border:3.5px solid #000;border-radius:calc(var(--k-w)*.15);background:var(--color-bg,#fff)}
.k-celular>.k-tela::before{content:"";position:absolute;z-index:2;top:9px;left:50%;width:66px;height:20px;transform:translateX(-50%);border-radius:999px;background:#000}
.k-celular[data-ilha=nao]>.k-tela::before{display:none}
.k-celular>.k-tela::after{content:"";position:absolute;z-index:2;bottom:5.5px;left:50%;width:32%;height:3px;transform:translateX(-50%);border-radius:999px;background:color-mix(in srgb,currentColor 35%,transparent)}
.k-notebook{--k-borda:#d4d4d4;--k-base-a:#d4d4d4;--k-base-b:#a3a3a3;--k-entalhe:#737373;display:inline-flex;flex-direction:column;align-items:center;flex:none;width:var(--k-notebook-w,384px)}
.k-notebook[data-cor=titanio]{--k-borda:#7a7671;--k-base-a:#8a8580;--k-base-b:#6a6560;--k-entalhe:#5c5854}
.k-notebook[data-cor=branco]{--k-borda:#e5e5e5;--k-base-a:#f5f5f5;--k-base-b:#d4d4d4;--k-entalhe:#a3a3a3}
.k-notebook[data-cor=meia-noite]{--k-borda:#26262c;--k-base-a:#34343c;--k-base-b:#1c1c22;--k-entalhe:#131318}
.k-notebook[data-cor=estelar]{--k-borda:#d8cdb8;--k-base-a:#f0e6d4;--k-base-b:#dcd0b8;--k-entalhe:#c9bc9e}
.k-notebook>.k-tela{position:relative;box-sizing:border-box;width:100%;aspect-ratio:16/10.5;overflow:hidden;border:6px solid #262626;border-bottom:0;border-radius:12px 12px 0 0;box-shadow:0 0 0 2px var(--k-borda);background:var(--color-bg,#171717)}
.k-notebook::after{content:"";display:block;width:112.5%;height:12px;border-radius:0 0 12px 12px;background:linear-gradient(var(--k-entalhe),var(--k-entalhe)) 50% 0/64px 4px no-repeat,linear-gradient(var(--k-base-a),var(--k-base-b))}
.k-escala{width:calc(100% / var(--k-escala,1));height:calc(100% / var(--k-escala,1));transform:scale(var(--k-escala,1));transform-origin:0 0}`;

export const KIT_CSS = `.k-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--k-min,130px),1fr));gap:12px}
.k-amostra{height:64px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 25%,transparent)}
.k-nome{font:600 12px/1.3 system-ui,sans-serif;opacity:.9;margin-top:8px;word-break:break-all}
.k-val{font:11px/1.3 ui-monospace,monospace;opacity:.6;margin-top:2px;word-break:break-all}
.k-lista{display:flex;flex-direction:column}
.k-linha{display:flex;align-items:center;gap:16px;padding:8px 0;border-bottom:1px solid color-mix(in srgb,currentColor 18%,transparent)}
.k-linha:last-child{border-bottom:0}
.k-linha>.k-nome,.k-linha>.k-val{margin:0;min-width:150px}
.k-barra{height:12px;background:currentColor;opacity:.55;border-radius:2px}
.k-forma{height:64px;background:color-mix(in srgb,currentColor 12%,transparent)}
.k-rotulo{font:600 10px/1.2 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;opacity:.55;margin:0 0 8px}
.k-demo{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.k-bloco+.k-bloco{margin-top:20px}
${KIT_APARELHOS_CSS}`;

export const LARGURAS = ["1/3", "1/2", "2/3", "1"] as const;
export type Largura = (typeof LARGURAS)[number];
export const ALINHAMENTOS = ["topo", "esticar", "alvenaria"] as const;
export type Alinhamento = (typeof ALINHAMENTOS)[number];

/** Tipos de card. Os de token saem prontos do modelo (sem IA); componente e livre a IA desenha. */
export const TIPOS = [
  { id: "cores", titulo: "Cores", grupo: "cor", daIa: false },
  { id: "tipografia", titulo: "Tipografia", grupo: "tipo", daIa: false },
  { id: "espacamento", titulo: "Espaçamento", grupo: "espaco", daIa: false },
  { id: "forma", titulo: "Raio & sombra", grupo: "forma", daIa: false },
  { id: "componente", titulo: "Componente", grupo: null, daIa: true },
  { id: "livre", titulo: "Livre", grupo: null, daIa: true },
] as const;
export type TipoCard = (typeof TIPOS)[number]["id"];
export type TipoDeToken = "cores" | "tipografia" | "espacamento" | "forma";

const GRUPOS: { id: string; teste: (v: DsVar) => boolean }[] = [
  { id: "cor", teste: (v) => v.tipo === "color" || /^colou?rs?\./.test(v.caminho) },
  { id: "tipo", teste: (v) => /^(font|typography|type|text)\b/.test(v.caminho) || /^font/.test(v.tipo || "") },
  { id: "espaco", teste: (v) => /^(space|spacing|gap|size)\b/.test(v.caminho) },
  { id: "forma", teste: (v) => /radius|radii|shadow|elevation/.test(v.caminho) || v.tipo === "shadow" },
  { id: "motion", teste: (v) => /^(motion|duration|ease|easing|transition)\b/.test(v.caminho) || v.tipo === "duration" || v.tipo === "cubicBezier" },
];

/** Cada variável cai no PRIMEIRO grupo que casa; o que não casa vai pra "outros". */
export function agruparVars(vars: DsVar[]): Map<string, DsVar[]> {
  const out = new Map<string, DsVar[]>([...GRUPOS.map((g) => [g.id, []] as [string, DsVar[]]), ["outros", []]]);
  for (const v of vars) out.get(GRUPOS.find((g) => g.teste(v))?.id ?? "outros")!.push(v);
  return out;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const rotulo = (v: DsVar) => `<div class="k-nome">${esc(v.caminho)}</div><div class="k-val">${esc(v.valor)}</div>`;

function linhaDeTipo(v: DsVar): string {
  let amostra = "";
  if (/family/i.test(v.caminho) || v.tipo === "fontFamily") amostra = `<span style="font-family:var(${v.nome});font-size:22px">Aa Bb Cc 0123</span>`;
  else if (/weight/i.test(v.caminho) || v.tipo === "fontWeight") amostra = `<span style="font-weight:var(${v.nome});font-size:18px">Peso</span>`;
  else if (/size/i.test(v.caminho) || v.tipo === "dimension") amostra = `<span style="font-size:var(${v.nome})">O rato roeu</span>`;
  else if (/line|leading/i.test(v.caminho)) amostra = `<span style="line-height:var(${v.nome})">Linha</span>`;
  return `<div class="k-linha">${rotulo(v)}${amostra}</div>`;
}

function itemDeForma(v: DsVar): string {
  const sombra = v.tipo === "shadow" || /shadow|elevation/.test(v.caminho);
  const estilo = sombra ? `box-shadow:var(${v.nome});border-radius:8px` : `border-radius:var(${v.nome});border:2px solid currentColor;opacity:.8`;
  return `<div><div class="k-forma" style="${estilo}"></div>${rotulo(v)}</div>`;
}

/** HTML do card de um tipo de token, só com `var()` — trocar o token atualiza o card na hora. */
export function htmlDoTipo(tipo: TipoDeToken | "outros", vars: DsVar[]): string {
  if (tipo === "cores") {
    return `<div class="k-grade">${vars.map((v) => `<div><div class="k-amostra" style="background:var(${v.nome})"></div>${rotulo(v)}</div>`).join("")}</div>\n`;
  }
  if (tipo === "tipografia") return `<div class="k-lista">${vars.map(linhaDeTipo).join("")}</div>\n`;
  if (tipo === "espacamento") {
    return `<div class="k-lista">${vars.map((v) => `<div class="k-linha">${rotulo(v)}<div class="k-barra" style="width:var(${v.nome})"></div></div>`).join("")}</div>\n`;
  }
  if (tipo === "forma") return `<div class="k-grade">${vars.map(itemDeForma).join("")}</div>\n`;
  return `<div class="k-lista">${vars.map((v) => `<div class="k-linha">${rotulo(v)}</div>`).join("")}</div>\n`;
}

/** Tokens que servem pra um tipo de card (a lista que o Canvas oferece pra marcar). */
export function varsDoTipo(tipo: TipoDeToken, vars: DsVar[]): DsVar[] {
  const grupo = TIPOS.find((t) => t.id === tipo)!.grupo!;
  return agruparVars(vars).get(grupo) ?? [];
}

export type ConfigFundamento = { id: string; largura?: Largura; oculto?: boolean };

export type CardFundamento = {
  id: string;
  titulo: string;
  subtitulo: string;
  secao: "fundamentos";
  tipo: TipoDeToken | "outros";
  html: string;
  /** Nomes dos tokens do card (a aba Tokens do Canvas edita estes). */
  tokens: string[];
  largura?: Largura;
  oculto?: boolean;
};

const FUNDAMENTOS: { id: string; titulo: string; subtitulo: string; tipo: TipoDeToken | "outros"; grupos: string[] }[] = [
  { id: "fund-cores", titulo: "Cores", subtitulo: "Superfícies, marca e semânticas", tipo: "cores", grupos: ["cor"] },
  { id: "fund-tipografia", titulo: "Tipografia", subtitulo: "Famílias, escala e pesos", tipo: "tipografia", grupos: ["tipo"] },
  { id: "fund-espaco", titulo: "Espaçamento", subtitulo: "Escala de espaço", tipo: "espacamento", grupos: ["espaco"] },
  { id: "fund-forma", titulo: "Raio & sombra", subtitulo: "Cantos e elevação", tipo: "forma", grupos: ["forma"] },
  { id: "fund-outros", titulo: "Motion & outros", subtitulo: "Duração, curva e demais tokens", tipo: "outros", grupos: ["motion", "outros"] },
];

export const IDS_FUNDAMENTOS = FUNDAMENTOS.map((f) => f.id);

/**
 * Cards de Fundamentos (gerados dos tokens, sem arquivo), na ordem de `meta.fundamentos` — quem não
 * está lá vem depois, na ordem padrão. Oculto volta junto (marcado) pro Canvas oferecer "mostrar".
 */
export function cardsDeFundamentos(vars: DsVar[], config: ConfigFundamento[] = []): CardFundamento[] {
  const g = agruparVars(vars);
  const porId = new Map(config.map((c) => [c.id, c]));
  const ordem = [...config.map((c) => c.id).filter((id) => IDS_FUNDAMENTOS.includes(id)), ...IDS_FUNDAMENTOS.filter((id) => !porId.has(id))];
  const out: CardFundamento[] = [];
  for (const id of ordem) {
    const f = FUNDAMENTOS.find((x) => x.id === id)!;
    const doCard = f.grupos.flatMap((gr) => g.get(gr) ?? []);
    if (!doCard.length) continue;
    const c = porId.get(id);
    out.push({
      id: f.id,
      titulo: f.titulo,
      subtitulo: f.subtitulo,
      secao: "fundamentos",
      tipo: f.tipo,
      html: htmlDoTipo(f.tipo, doCard),
      tokens: doCard.map((v) => v.nome),
      ...(c?.largura ? { largura: c.largura } : {}),
      ...(c?.oculto ? { oculto: true } : {}),
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * KIT.md — o que o agente do chat lê pra criar card no estilo certo e mexer no layout
 * ------------------------------------------------------------------------- */

export const KIT_MD = `# Kit do Canvas e layout do board

> Arquivo gerado pelo Nexos (é sobrescrito). Descreve o que o Canvas já carrega em todo card e como o
> board é montado a partir do \`meta.json\`.

## Classes prontas (já carregadas em todo card — não redeclare)
Card de token (cores, tipografia, espaçamento, raio/sombra) usa SÓ estas classes: é o mesmo visual dos
Fundamentos. Card de componente usa pros rótulos e a vitrine, e o resto com \`<style>\` próprio.
- \`.k-grade\` — grade de amostras (~130px por item; mude com \`style="--k-min:200px"\`)
- \`.k-amostra\` — bloco de 64px pra cor: \`<div class="k-amostra" style="background:var(--color-primary)"></div>\`
- \`.k-nome\` / \`.k-val\` — nome do token (negrito) e valor (mono), logo abaixo da amostra
- \`.k-lista\` + \`.k-linha\` — tabela com divisória: nome, valor e exemplo na mesma linha
- \`.k-barra\` — barra de espaçamento: \`<div class="k-barra" style="width:var(--space-4)"></div>\`
- \`.k-forma\` — caixa pra raio/sombra: \`<div class="k-forma" style="border-radius:var(--radius-md);border:2px solid currentColor"></div>\`
- \`.k-rotulo\` — rótulo pequeno em caixa alta (estado, variação)
- \`.k-demo\` — linha que quebra, com espaço, pra vitrine de variações lado a lado
- \`.k-bloco\` — grupo; espaço entre um grupo e o próximo

### Molduras de aparelho (mock de tela)
Tela dentro de um iPhone ou MacBook: a moldura vem pronta, você só põe a tela dentro de \`.k-tela\`.
- \`.k-celular\` — iPhone (256px de largura; mude com \`style="--k-celular-w:300px"\`). \`data-cor\`: roxo (padrão),
  laranja, branco, titanio, cereja. \`data-ilha="nao"\` tira a Dynamic Island. Desenhe a tela pra ~250px de largura.
- \`.k-notebook\` — MacBook (384px; \`style="--k-notebook-w:560px"\`). \`data-cor\`: cinza (padrão), titanio, branco,
  meia-noite, estelar.
- \`.k-escala\` — dentro da \`.k-tela\`, desenha a tela no tamanho real e reduz: \`style="--k-escala:.3"\` mostra uma
  tela de 1280px num notebook de 384px.
- Fundo da tela é \`--color-bg\` do DS; cor e fonte da tela seguem os tokens como em qualquer card.
\`\`\`html
<div class="k-demo">
  <div class="k-celular"><div class="k-tela"><!-- tela do app no celular --></div></div>
  <div class="k-notebook" data-cor="meia-noite"><div class="k-tela"><div class="k-escala" style="--k-escala:.3"><!-- tela de 1280px --></div></div></div>
</div>
\`\`\`

### Modelos
Cores (só as da marca, por exemplo):
\`\`\`html
<div class="k-grade">
  <div><div class="k-amostra" style="background:var(--color-primary)"></div><div class="k-nome">color.primary</div><div class="k-val">#c81e2c</div></div>
</div>
\`\`\`
Tipografia:
\`\`\`html
<div class="k-lista">
  <div class="k-linha"><div class="k-nome">font.size.lg</div><div class="k-val">18px</div><span style="font-size:var(--font-size-lg)">O rato roeu</span></div>
</div>
\`\`\`
Componente (estados lado a lado):
\`\`\`html
<style>.btn{padding:var(--space-2) var(--space-4);border-radius:var(--radius-sm);background:var(--color-primary);color:var(--color-on-primary);border:0}</style>
<div class="k-bloco"><p class="k-rotulo">Primário</p><div class="k-demo"><button class="btn">Salvar</button><button class="btn" disabled>Desabilitado</button></div></div>
\`\`\`

## Layout do board (\`meta.json\`)
- \`cards\`: a ORDEM da lista é a ordem no board. Campos: \`id\`, \`titulo\`, \`subtitulo\`, \`secao\`, \`tipo\`
  (cores | tipografia | espacamento | forma | componente | livre) e \`largura\` ("1/3" | "1/2" | "2/3" | "1"; padrão "1/2").
- \`secoes\`: \`id\`, \`titulo\` e \`alinhamento\`: "topo" (padrão; cada card com a própria altura), "esticar"
  (mesma altura na linha) ou "alvenaria" (empilha em colunas, sem buraco).
- \`fundamentos\`: ordem, \`largura\` e \`oculto\` dos cards gerados dos tokens (ids: ${IDS_FUNDAMENTOS.join(", ")}).
  A seção deles é \`fundamentos\` (pode ter entrada em \`secoes\` pra mudar título/alinhamento).
- Card novo = arquivo \`cards/<id>.html\` + entrada em \`cards\`. Apagar = tirar os dois.
- Conferir o visual: a ferramenta \`nexo_ds_print\` devolve o print do card renderizado (sem \`card\`, lista os ids).
- Ferramentas: \`nexo_ds_card_salvar\` grava card (valida o lint na hora), \`nexo_ds_criar\` cria outro DS (ex.: "Mocks"
  pra testar uma tela sem mexer no oficial; base "ativo" copia o visual), \`nexo_ds_listar\` e \`nexo_ds_ativar\` trocam de DS.
- "Alinhar os cards": feche as linhas combinando largura e ordem (dois "1/2", "1/3" + "2/3", três "1/3"),
  deixe card alto sozinho em "1" ou use \`alinhamento: "alvenaria"\` na seção.
`;

/** Garante o KIT.md atualizado na pasta do DS (é do Nexos: sobrescreve se mudou). */
export function garantirKit(pasta: string): void {
  const caminho = join(pasta, "KIT.md");
  let atual: string | null = null;
  try {
    atual = readFileSync(caminho, "utf8");
  } catch {
    atual = null;
  }
  if (atual !== KIT_MD) {
    try {
      writeFileSync(caminho, KIT_MD, "utf8");
    } catch {
      // pasta sumiu no meio: o próximo turno tenta de novo
    }
  }
}

/** Resumo curto do kit pros pedidos de geração (o KIT.md inteiro é pro agente do chat). */
export const KIT_NO_PEDIDO = `## Classes prontas no card (mesmo visual dos Fundamentos — não redeclare)
\`.k-grade\` grade de amostras · \`.k-amostra\` bloco 64px (\`style="background:var(--token)"\`) · \`.k-nome\`/\`.k-val\` nome e valor do token ·
\`.k-lista\` + \`.k-linha\` tabela com divisória · \`.k-barra\` barra de espaço (\`style="width:var(--space-4)"\`) · \`.k-forma\` caixa de raio/sombra ·
\`.k-rotulo\` rótulo pequeno em caixa alta · \`.k-demo\` vitrine de variações lado a lado · \`.k-bloco\` grupo com espaço.
Mock de tela num aparelho: \`<div class="k-celular"><div class="k-tela">…</div></div>\` (iPhone, ~250px) ou \`.k-notebook\` (MacBook, 384px);
\`data-cor\` troca o acabamento e \`<div class="k-escala" style="--k-escala:.3">\` reduz uma tela desenhada em tamanho real.
Use \`.k-rotulo\` + \`.k-demo\` pra mostrar estados/variações; em card de token use só as classes do kit.`;
