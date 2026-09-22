import { EventEmitter } from "node:events";
import { sessionBus } from "./bus.ts";
import {
  estadoDs,
  prepararMeta,
  lintCard,
  salvarCard,
  salvarDesignMd,
  salvarTokens,
  tokensParaCss,
  type DsCompleto,
  type LintItem,
} from "./design-system.ts";
import { coletaVazia, coletarDaUrl, coletarDoCodigo, resumoDaColeta } from "./ds-coleta.ts";
import { criarLeitor, lerBlocos, semCerca, type Bloco, type OuvintesLeitor } from "./ds-stream.ts";
import { ATTACH_MAX_BYTES } from "@nexos/shared";
import type { IncomingImage } from "./attachments.ts";
import { projectKey } from "./home.ts";
import { getProfile } from "./profiles.ts";
import { abortThread, getLive, postMessage } from "./session.ts";
import { createThread, readThread } from "./threads.ts";

/**
 * Geração do design system por IA (spec §3, Fase 2).
 *
 *   1. coleta de contexto (sem LLM: código do projeto + URL de referência)
 *   2. "Diretor": uma conversa que devolve `<ds-tokens>` + `<ds-design-md>`
 *   3. fan-out: uma conversa por seção, em paralelo (com teto), cada uma devolvendo `<ds-card>`s
 *   4. verificação: card com erro de lint (ou que não veio) volta pro MESMO agente corrigir, até
 *      `TENTATIVAS` vezes — só aí a etapa é dada como pronta
 *
 * A saída é TEXTO no protocolo de `ds-stream.ts`, e quem grava é o daemon. Isso vale pra todo
 * motor (inclusive `api`, que não tem ferramenta de arquivo) e evita duas partes escrevendo o
 * mesmo arquivo ao mesmo tempo. Cada conversa é uma thread normal (aparece na lista, dá pra abrir
 * e ver o que o agente fez), criada com `semRoteamento`.
 */

export type EtapaStatus = "pendente" | "rodando" | "corrigindo" | "ok" | "erro" | "cancelado";

export type Etapa = {
  id: string;
  titulo: string;
  status: EtapaStatus;
  threadId?: string;
  cards: string[];
  prontos: string[];
  erro?: string;
};

export type Geracao = {
  id: string;
  projectPath: string;
  status: "rodando" | "concluida" | "erro" | "cancelada";
  inicio: string;
  fim?: string;
  etapas: Etapa[];
  /** Cards previstos (id, título, seção) — o Canvas mostra o esqueleto deles antes de chegarem. */
  plano: PlanoCard[];
  erro?: string;
};

export type PlanoCard = { id: string; titulo: string; subtitulo?: string; secao: string };
type PlanoSecao = { id: string; titulo: string; cards: PlanoCard[] };

export type GerarInput = {
  profileId?: unknown;
  brief?: unknown;
  usarCodigo?: unknown;
  url?: unknown;
  gerarTokens?: unknown;
  secoes?: unknown;
  paralelo?: unknown;
  /** Página capturada no painel Browser (`ds-extrator.js` do desktop): dados computados + print. */
  referencia?: unknown;
};

type Referencia = { url: string; titulo: string; dados: Record<string, unknown>; screenshot?: IncomingImage };

const REFERENCIA_MAX_DADOS = 200_000;

/** Valida o que veio do desktop. Dado grande demais ou print que não é imagem é descartado, não aceito pela metade. */
function lerReferencia(bruto: unknown): Referencia | null {
  if (!bruto || typeof bruto !== "object") return null;
  const r = bruto as { url?: unknown; titulo?: unknown; dados?: unknown; screenshot?: unknown };
  if (!r.dados || typeof r.dados !== "object" || JSON.stringify(r.dados).length > REFERENCIA_MAX_DADOS) return null;
  const url = typeof r.url === "string" ? r.url.slice(0, 2000) : "";
  const titulo = typeof r.titulo === "string" ? r.titulo.slice(0, 200) : "";
  let screenshot: IncomingImage | undefined;
  const s = r.screenshot as { mime?: unknown; data?: unknown } | null | undefined;
  if (s && (s.mime === "image/jpeg" || s.mime === "image/png") && typeof s.data === "string" && s.data.length < ATTACH_MAX_BYTES * 1.4) {
    screenshot = { name: "referencia", mime: s.mime, data: s.data };
  }
  return { url, titulo, dados: r.dados as Record<string, unknown>, ...(screenshot ? { screenshot } : {}) };
}

/** Os dados computados da página em texto, pro pedido do Diretor. */
export function resumoDaReferencia(ref: Referencia): string {
  const d = ref.dados as Record<string, any>;
  const par = (xs: unknown, fmt: (x: any) => string, n = 12) =>
    Array.isArray(xs) && xs.length ? xs.slice(0, n).map(fmt).join("\n") : "(nada)";
  const cont = ([v, n]: [string, number]) => `- ${v} · ${n}`;
  const partes = [
    `Página: ${ref.titulo || d.titulo || ""} — ${ref.url || d.url || ""}`,
    d.descricao ? `Descrição: ${String(d.descricao).slice(0, 300)}` : "",
    d.themeColor ? `theme-color: ${d.themeColor}` : "",
    `Elementos amostrados: ${d.amostrados ?? "?"} de ${d.totalElementos ?? "?"} visíveis (viewport ${d.viewport ?? "?"}).${d.tailwind ? " Usa classes utilitárias (Tailwind ou parecido)." : ""}`,
    `Cores de FUNDO (hex · peso por área):\n${par(d.cores?.fundo, cont)}`,
    `Cores de TEXTO:\n${par(d.cores?.texto, cont)}`,
    `Cores de BORDA:\n${par(d.cores?.borda, cont, 8)}`,
    `Fontes:\n${par(d.fontes, cont, 6)}`,
    `Tamanhos de fonte:\n${par(d.tamanhos, cont)}`,
    `Pesos:\n${par(d.pesos, cont, 6)}`,
    `Raios:\n${par(d.raios, cont, 8)}`,
    `Sombras:\n${par(d.sombras, cont, 5)}`,
    `Espaçamentos (padding/gap):\n${par(d.espacos, cont, 14)}`,
    `Transições:\n${par(d.transicoes, cont, 4)}`,
    `Botões vistos:\n${par(d.botoes, (b) => `- "${b.texto}" fundo ${b.fundo} texto ${b.cor} raio ${b.raio} padding ${b.padding} fonte ${b.fonte}`, 8)}`,
    `Variáveis CSS de :root:\n${par(d.variaveis, ([k, v]) => `- ${k}: ${v}`, 80)}`,
    `Títulos da página: ${Array.isArray(d.titulos) ? d.titulos.join(" | ").slice(0, 600) : ""}`,
    `Navegação: ${Array.isArray(d.navegacao) ? d.navegacao.join(" | ").slice(0, 300) : ""}`,
    `Logos encontrados: ${Array.isArray(d.logos) ? d.logos.join(" · ").slice(0, 600) : ""}`,
    `Componentes: ${d.componentes ? JSON.stringify(d.componentes) : ""}`,
  ];
  return partes.filter(Boolean).join("\n\n");
}

const TENTATIVAS = 2;
const PARALELO_PADRAO = 3;

function card(id: string, titulo: string, subtitulo: string, secao: string): PlanoCard {
  return { id, titulo, subtitulo, secao };
}

/** Plano padrão (tabela de seções do spec). Fundamentos não entram: saem dos tokens. */
export const PLANO_PADRAO: PlanoSecao[] = [
  {
    id: "core",
    titulo: "Core",
    cards: [
      card("core-logo", "Logo", "Marca em tamanhos e fundos", "core"),
      card("core-botoes", "Botões", "Primário, secundário, contorno, fantasma e estados", "core"),
      card("core-pills", "Pills & status", "Etiquetas de estado", "core"),
      card("core-avatares", "Avatares", "Iniciais, grupo e status", "core"),
      card("core-barras", "Barras", "Progresso e nível", "core"),
      card("core-icones", "Ícones", "Conjunto base em SVG", "core"),
    ],
  },
  {
    id: "layout",
    titulo: "Layout",
    cards: [
      card("layout-casca", "Casca do app", "Sidebar, topbar e área de conteúdo", "layout"),
      card("layout-cards", "Cards", "Container, cabeçalho e ações", "layout"),
      card("layout-kpis", "KPIs", "Indicadores com variação", "layout"),
      card("layout-grid", "Grid responsivo", "Colunas e respiros", "layout"),
    ],
  },
  {
    id: "dados",
    titulo: "Dados & formulários",
    cards: [
      card("dados-tabela", "Tabela", "Densa, com status e linha em destaque", "dados"),
      card("dados-campos", "Campos", "Texto, validação e ajuda", "dados"),
      card("dados-selects", "Seleção", "Select, checkbox, radio e switch", "dados"),
      card("dados-alertas", "Alertas", "Aviso, erro e informação", "dados"),
    ],
  },
  {
    id: "navegacao",
    titulo: "Navegação",
    cards: [
      card("nav-tabs", "Abas", "Abas e segmentado", "navegacao"),
      card("nav-breadcrumb", "Breadcrumb", "Trilha de navegação", "navegacao"),
      card("nav-paginacao", "Paginação", "Páginas e contagem", "navegacao"),
      card("nav-menu", "Menu", "Dropdown e itens", "navegacao"),
    ],
  },
  {
    id: "feedback",
    titulo: "Feedback & overlays",
    cards: [
      card("fb-toast", "Toast", "Notificações rápidas", "feedback"),
      card("fb-modal", "Modal", "Diálogo de confirmação", "feedback"),
      card("fb-drawer", "Drawer", "Painel lateral", "feedback"),
      card("fb-vazio", "Estado vazio", "Sem dados, com ação", "feedback"),
      card("fb-carregando", "Carregando", "Skeleton e spinner", "feedback"),
    ],
  },
  {
    id: "graficos",
    titulo: "Gráficos",
    cards: [
      card("graf-paleta", "Paleta de dados", "Cores de série", "graficos"),
      card("graf-barras", "Barras e linha", "Gráficos simples em SVG", "graficos"),
      card("graf-legendas", "Legendas", "Legenda e tooltip", "graficos"),
    ],
  },
  {
    id: "telas",
    titulo: "Telas-exemplo",
    cards: [
      card("tela-painel", "Painel", "Tela completa só com o design system", "telas"),
      card("tela-lista", "Lista com filtros", "Tela completa só com o design system", "telas"),
      card("tela-formulario", "Formulário", "Tela completa só com o design system", "telas"),
    ],
  },
];

export const geracaoBus = new EventEmitter();
geracaoBus.setMaxListeners(0);

const porProjeto = new Map<string, Geracao>();
const canceladas = new Set<string>();

export function canalGeracao(projectPath: string): string {
  return `ds-geracao:${projectKey(projectPath)}`;
}

/**
 * O HTML de um card enquanto ele é escrito, pro Canvas desenhar ao vivo. Pedaço de `text_delta`
 * é do tamanho de um token: junta o que chegar em ~40ms num evento só, senão seriam centenas de
 * eventos por card no SSE.
 */
function criarTransmissor(g: Geracao) {
  const canal = canalGeracao(g.projectPath);
  const buffers = new Map<string, { html: string; timer: NodeJS.Timeout | null }>();
  const enviar = (card: string) => {
    const b = buffers.get(card);
    if (!b || !b.html) return;
    geracaoBus.emit(canal, { type: "ds_stream", fase: "pedaco", card, html: b.html });
    b.html = "";
    b.timer = null;
  };
  return {
    abriu(card: string, titulo: string) {
      buffers.set(card, { html: "", timer: null });
      geracaoBus.emit(canal, { type: "ds_stream", fase: "abriu", card, titulo });
    },
    pedaco(card: string, html: string) {
      const b = buffers.get(card);
      if (!b) return;
      b.html += html;
      if (!b.timer) b.timer = setTimeout(() => enviar(card), 40);
    },
    /** Descarrega o que sobrou antes do card ir pro disco. */
    fechar(card: string) {
      const b = buffers.get(card);
      if (b?.timer) clearTimeout(b.timer);
      enviar(card);
      buffers.delete(card);
    },
  };
}

function publicar(g: Geracao): void {
  geracaoBus.emit(canalGeracao(g.projectPath), { type: "geracao", geracao: g });
}

export function geracaoAtual(projectPath: string): Geracao | null {
  return porProjeto.get(projectKey(projectPath)) ?? null;
}

function erro(msg: string, status = 400): Error {
  return Object.assign(new Error(msg), { status });
}

/* ---------------------------------------------------------------------------
 * Motor: como uma etapa conversa com o agente. Injetável pra teste.
 * ------------------------------------------------------------------------- */

export type Motor = {
  criarConversa(projectPath: string, profileId: string, titulo: string): string;
  /** Manda o pedido, repassa o texto ao vivo e resolve quando o turno fecha. */
  turno(
    threadId: string,
    pedido: string,
    aoTexto: (t: string) => void,
    imagens?: IncomingImage[],
  ): Promise<{ ok: boolean; motivo?: string; textoFinal: string }>;
  abortar(threadId: string): Promise<void>;
};

function ultimaFala(threadId: string, home: string): string {
  const eventos = readThread(threadId, home);
  for (let i = eventos.length - 1; i >= 0; i--) {
    const e = eventos[i];
    if (e?.type === "assistant") return e.text;
  }
  return "";
}

export function motorPadrao(home: string): Motor {
  return {
    criarConversa(projectPath, profileId, titulo) {
      // `oculta`: é conversa de trabalho da tela do DS, não da pessoa — fora da barra lateral
      return createThread({ projectPath, profileId, title: titulo, semRoteamento: true, oculta: true }, home).id;
    },
    async turno(threadId, pedido, aoTexto, imagens = []) {
      // Streaming real (Fase 3): o `claude` manda a resposta em pedaços (`text_parcial`) enquanto
      // escreve. Chegou pedaço, o `text` inteiro do fim é ignorado — senão cada card viria duas
      // vezes. Motor sem pedaço (codex, api) segue pelo `text`, que é o replay de sempre.
      let aoVivo = false;
      const ouvirParcial = (ev: { type?: string; text?: string }) => {
        if (ev?.type !== "text_parcial" || typeof ev.text !== "string") return;
        aoVivo = true;
        aoTexto(ev.text);
      };
      const ouvir = (ev: { type?: string; text?: string }) => {
        if (!aoVivo && ev?.type === "text" && typeof ev.text === "string") aoTexto(ev.text);
      };
      sessionBus.on(`parcial:${threadId}`, ouvirParcial);
      sessionBus.on(threadId, ouvir);
      try {
        await postMessage(threadId, pedido, home, imagens, { automatico: true });
      } finally {
        sessionBus.off(`parcial:${threadId}`, ouvirParcial);
        sessionBus.off(threadId, ouvir);
      }
      const terminal = getLive(threadId)?.lastTerminal;
      if (terminal !== "done") {
        const motivo =
          terminal === "quota" ? "a quota da conta acabou" : terminal === "auth" ? "a conta precisa de login" : "o turno não terminou";
        return { ok: false, motivo, textoFinal: ultimaFala(threadId, home) };
      }
      return { ok: true, textoFinal: ultimaFala(threadId, home) };
    },
    abortar: (threadId) => abortThread(threadId),
  };
}

/** Um turno lido pelo protocolo. Se nada veio ao vivo, lê o texto final (motor sem texto ao vivo). */
async function turnoComBlocos(
  motor: Motor,
  threadId: string,
  pedido: string,
  aoFechar: (b: Bloco) => void,
  imagens: IncomingImage[] = [],
  aoVivo: Pick<OuvintesLeitor, "abriu" | "pedaco"> = {},
) {
  const leitor = criarLeitor({ fechou: aoFechar, ...aoVivo });
  const r = await motor.turno(threadId, pedido, (t) => leitor.alimentar(t), imagens);
  leitor.terminar();
  if (leitor.fechados() === 0 && r.textoFinal) for (const b of lerBlocos(r.textoFinal)) aoFechar(b);
  return r;
}

/* ---------------------------------------------------------------------------
 * Pedidos
 * ------------------------------------------------------------------------- */

const REGRAS_GERAIS = `Regras de saída (obrigatórias):
- Responda SÓ com os blocos pedidos, no formato exato. Texto fora dos blocos é ignorado.
- NÃO edite nem crie arquivos: quem grava é o Nexos, a partir da sua resposta.
- Tudo em português do Brasil.`;

function pedidoDoDiretor(ctx: { nome: string; brief: string; coleta: string; tokensAtuais: string; usados: string[] }): string {
  return `Você é o diretor de arte do design system "${ctx.nome}". Defina os tokens e as regras de uso.

## Pedido da pessoa
${ctx.brief || "(sem briefing: baseie-se no que o projeto já usa)"}

## O que o projeto já usa (coletado automaticamente)
${ctx.coleta}

## Tokens atuais (ponto de partida; pode reescrever)
\`\`\`json
${ctx.tokensAtuais}
\`\`\`

${ctx.usados.length ? `## Tokens já usados pelos cards existentes (MANTENHA estes nomes, pode mudar o valor)
${ctx.usados.join(", ")}

` : ""}## O que entregar
1. \`<ds-tokens>\` com um JSON no formato W3C DTCG (\`$type\`, \`$value\`, grupos aninhados). Nomes OBRIGATÓRIOS (o Canvas depende deles):
   - color.bg, color.surface, color.surface-2, color.border, color.text, color.muted, color.primary, color.on-primary, color.secondary, color.success, color.warning, color.danger (pode adicionar mais)
   - font.family.display, font.family.body, font.family.mono (listas; prefira fontes do Google Fonts), font.size.* (xs…2xl), font.weight.*
   - space.1…space.6, radius.sm/md/lg/pill, shadow.1/2, motion.duration.base, motion.ease.base
   - Tema claro/escuro opcional: \`"$extensions": { "nexos.temas": { "claro": "#…" } }\` no token.
   - Referência a outro token: \`"{color.primary}"\`.
   - Cores com contraste AA entre texto e fundo.
2. \`<ds-design-md>\` com as regras de uso em markdown (quando usar cada cor, hierarquia tipográfica, espaçamento, tom visual). Curto e prescritivo: é o que os outros agentes vão seguir.

Formato:
<ds-tokens>
{ ... }
</ds-tokens>
<ds-design-md>
# ...
</ds-design-md>

${REGRAS_GERAIS}`;
}

function listaDeVars(ds: DsCompleto): string {
  return ds.vars.map((v) => `${v.nome}: ${v.valor}`).join("\n");
}

function pedidoDaSecao(ctx: { ds: DsCompleto; secao: PlanoSecao; brief: string; logos: string[]; temPrint: boolean }): string {
  const cards = ctx.secao.cards.map((c) => `- id="${c.id}" titulo="${c.titulo}" — ${c.subtitulo}`).join("\n");
  const logos = ctx.logos.length
    ? `\nLogo do projeto (use o arquivo real, NUNCA invente um logo): caminhos relativos à raiz do projeto, use exatamente assim no src:\n${ctx.logos.map((l) => `- ${l}`).join("\n")}\n`
    : "";
  return `Você desenha a seção "${ctx.secao.titulo}" do design system "${ctx.ds.nome}". Cada card é uma prancha de referência com exemplos reais do componente, variações e estados.

${ctx.temPrint ? "A imagem anexada é o print da página de referência: siga o tom visual dela (densidade, forma, hierarquia), mas sempre com os tokens abaixo.\n\n" : ""}## Contexto do produto
${ctx.brief || "(sem briefing: use exemplos plausíveis pro domínio do projeto)"}

## Regras de uso (DESIGN.md)
${ctx.ds.designMd.slice(0, 6000)}

## Tokens disponíveis (variáveis CSS já carregadas no card)
${listaDeVars(ctx.ds)}
${logos}
## Cards desta seção
${cards}

## Como escrever cada card
- Um fragmento HTML: \`<style>\` + marcação. Sem \`<html>\`, \`<head>\` ou \`<body>\`. Largura útil ~720px.
- Cor, fonte, espaço, raio e sombra SEMPRE por \`var(--token)\` da lista acima. Nunca hex, rgb(), hsl() nem cor nomeada.
- Variável local é permitida se derivar de token (\`--pad: var(--space-3)\`).
- Sem \`<script>\`, sem \`on*=\`, sem imagem/fonte/CSS externo. Ícone é SVG inline com \`stroke="currentColor"\`/\`fill="currentColor"\`.
- Conteúdo realista em pt-BR, coerente com o produto (nada de "Lorem ipsum" nem "Button 1").
- Mostre estados relevantes (hover/foco/desabilitado/erro) lado a lado, com rótulos pequenos.

Formato (um bloco por card, na ordem):
<ds-card id="${ctx.secao.cards[0]?.id ?? "id"}" titulo="..." subtitulo="..." secao="${ctx.secao.id}">
<style>...</style>
...
</ds-card>

${REGRAS_GERAIS}`;
}

function pedidoDeCorrecao(itens: { id: string; problemas: string[] }[]): string {
  const lista = itens.map((i) => `### ${i.id}\n${i.problemas.map((p) => `- ${p}`).join("\n")}`).join("\n\n");
  return `Alguns blocos não passaram na verificação. Reenvie CADA um deles inteiro, corrigido, no mesmo formato (os que não estão aqui ficam como estão).

${lista}

${REGRAS_GERAIS}`;
}

function problemasDoLint(itens: LintItem[]): string[] {
  return itens.slice(0, 12).map((i) => (i.trecho ? `${i.msg}: \`${i.trecho}\`` : i.msg));
}

/* ---------------------------------------------------------------------------
 * Etapas
 * ------------------------------------------------------------------------- */

const OBRIGATORIAS = ["--color-bg", "--color-text", "--color-primary", "--font-family-body"];

function validarTokens(bruto: string): { tokens?: unknown; problemas: string[] } {
  let tokens: unknown;
  try {
    tokens = JSON.parse(semCerca(bruto));
  } catch (e) {
    return { problemas: [`JSON inválido: ${(e as Error).message}`] };
  }
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return { problemas: ["o JSON precisa ser um objeto DTCG"] };
  const { vars } = tokensParaCss(tokens);
  const nomes = new Set(vars.map((v) => v.nome));
  const problemas = OBRIGATORIAS.filter((n) => !nomes.has(n)).map((n) => `falta o token ${n}`);
  for (const v of vars) {
    for (const m of v.valor.matchAll(/var\((--[a-zA-Z0-9_-]+)\)/g)) {
      if (!nomes.has(m[1]!)) problemas.push(`${v.caminho} referencia ${m[1]} que não existe`);
    }
  }
  return { tokens, problemas };
}

type Ctx = {
  g: Geracao;
  home: string;
  motor: Motor;
  profileId: string;
  brief: string;
  logos: string[];
  /** Print da referência: vai no PRIMEIRO turno de cada conversa (correção não precisa de novo). */
  imagens: IncomingImage[];
  salvar: () => void;
};

function cancelada(g: Geracao): boolean {
  return canceladas.has(g.id);
}

async function rodarDiretor(ctx: Ctx, etapa: Etapa, coleta: string): Promise<void> {
  const { g, home, motor } = ctx;
  const ds = estadoDs(g.projectPath, home).ds!;
  etapa.threadId = motor.criarConversa(g.projectPath, ctx.profileId, `Design System · Diretor · ${ds.nome}`);
  etapa.status = "rodando";
  ctx.salvar();

  const usados = [...new Set(ds.cards.flatMap((c) => [...c.html.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]!)))].sort();
  let pedido = pedidoDoDiretor({
    nome: ds.nome,
    brief: ctx.brief,
    coleta,
    tokensAtuais: JSON.stringify(ds.tokens, null, 2).slice(0, 8000),
    usados: usados.filter((n) => ds.vars.some((v) => v.nome === n)),
  });
  let tokensOk = false;
  let mdOk = false;
  for (let tentativa = 0; tentativa <= TENTATIVAS; tentativa++) {
    if (cancelada(g)) return;
    const problemas: { id: string; problemas: string[] }[] = [];
    const r = await turnoComBlocos(motor, etapa.threadId, pedido, (b) => {
      if (b.tipo === "tokens" && !tokensOk) {
        const v = validarTokens(b.conteudo);
        if (v.problemas.length) problemas.push({ id: "ds-tokens", problemas: v.problemas });
        else {
          salvarTokens(g.projectPath, home, v.tokens);
          tokensOk = true;
          etapa.prontos.push("tokens");
          ctx.salvar();
        }
      } else if (b.tipo === "design-md" && !mdOk) {
        const texto = semCerca(b.conteudo);
        if (texto.length < 40) problemas.push({ id: "ds-design-md", problemas: ["regras de uso vazias"] });
        else {
          salvarDesignMd(g.projectPath, home, texto);
          mdOk = true;
          etapa.prontos.push("DESIGN.md");
          ctx.salvar();
        }
      }
    }, tentativa === 0 ? ctx.imagens : []);
    if (!r.ok) throw new Error(`Diretor: ${r.motivo}`);
    if (!tokensOk && !problemas.some((p) => p.id === "ds-tokens")) problemas.push({ id: "ds-tokens", problemas: ["o bloco <ds-tokens> não veio"] });
    if (!mdOk && !problemas.some((p) => p.id === "ds-design-md")) problemas.push({ id: "ds-design-md", problemas: ["o bloco <ds-design-md> não veio"] });
    if (!problemas.length) break;
    if (tentativa === TENTATIVAS) {
      if (!tokensOk) throw new Error(`Diretor: ${problemas.flatMap((p) => p.problemas).join("; ")}`);
      break; // tokens valem; DESIGN.md faltando não derruba a geração
    }
    etapa.status = "corrigindo";
    ctx.salvar();
    pedido = pedidoDeCorrecao(problemas);
  }
  etapa.status = "ok";
  ctx.salvar();
}

async function rodarSecao(ctx: Ctx, etapa: Etapa, secao: PlanoSecao): Promise<void> {
  const { g, home, motor } = ctx;
  if (cancelada(g)) return;
  const ds = estadoDs(g.projectPath, home).ds!;
  const conhecidas = new Set(ds.vars.map((v) => v.nome));
  const porId = new Map(secao.cards.map((c) => [c.id, c]));
  etapa.threadId = motor.criarConversa(g.projectPath, ctx.profileId, `Design System · ${secao.titulo}`);
  etapa.status = "rodando";
  ctx.salvar();

  let pedido = pedidoDaSecao({ ds, secao, brief: ctx.brief, logos: ctx.logos, temPrint: ctx.imagens.length > 0 });
  const pendentes = new Set(secao.cards.map((c) => c.id));
  const tx = criarTransmissor(g);
  const aoVivo = {
    abriu: (b: Bloco) => {
      const id = b.attrs.id ?? "";
      if (b.tipo === "card" && porId.has(id) && pendentes.has(id)) tx.abriu(id, b.attrs.titulo || porId.get(id)!.titulo);
    },
    pedaco: (b: Bloco, t: string) => {
      if (b.tipo === "card") tx.pedaco(b.attrs.id ?? "", t);
    },
  };
  for (let tentativa = 0; tentativa <= TENTATIVAS; tentativa++) {
    if (cancelada(g)) return;
    const problemas = new Map<string, string[]>();
    const r = await turnoComBlocos(motor, etapa.threadId, pedido, (b) => {
      if (b.tipo !== "card") return;
      const id = b.attrs.id ?? "";
      const plano = porId.get(id);
      if (!plano || !pendentes.has(id)) return; // card fora do plano desta seção, ou já aceito
      tx.fechar(id);
      const html = semCerca(b.conteudo);
      const lint = lintCard(html, conhecidas);
      // grava mesmo com erro: a pessoa vê o card (com o badge) enquanto o agente corrige
      salvarCard(
        g.projectPath,
        home,
        id,
        { html: `${html}\n`, titulo: b.attrs.titulo || plano.titulo, subtitulo: b.attrs.subtitulo || plano.subtitulo || "", secao: secao.id },
        { versionar: true },
      );
      if (lint.length) problemas.set(id, problemasDoLint(lint));
      else {
        pendentes.delete(id);
        if (!etapa.prontos.includes(id)) etapa.prontos.push(id);
        problemas.delete(id);
      }
      ctx.salvar();
    }, tentativa === 0 ? ctx.imagens : [], aoVivo);
    if (!r.ok) throw new Error(`${secao.titulo}: ${r.motivo}`);
    for (const id of pendentes) if (!problemas.has(id)) problemas.set(id, ["o card não veio na resposta"]);
    if (!problemas.size) break;
    if (tentativa === TENTATIVAS) {
      etapa.erro = `${problemas.size} card(s) ainda com problema: ${[...problemas.keys()].join(", ")}`;
      etapa.status = "erro";
      ctx.salvar();
      return;
    }
    etapa.status = "corrigindo";
    ctx.salvar();
    pedido = pedidoDeCorrecao([...problemas].map(([id, p]) => ({ id, problemas: p })));
  }
  etapa.status = "ok";
  ctx.salvar();
}

/** Roda `tarefas` com no máximo `n` ao mesmo tempo. */
async function comTeto(tarefas: (() => Promise<void>)[], n: number): Promise<void> {
  let i = 0;
  const trabalhador = async () => {
    while (i < tarefas.length) {
      const t = tarefas[i++]!;
      await t();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trabalhador));
}

/* ---------------------------------------------------------------------------
 * API
 * ------------------------------------------------------------------------- */

/** Estimativa pro Canvas mostrar antes de gerar: conversas e cards. */
export function estimar(input: { gerarTokens?: unknown; secoes?: unknown }): { conversas: number; cards: number } {
  const secoes = secoesPedidas(input.secoes);
  return { conversas: secoes.length + (input.gerarTokens === false ? 0 : 1), cards: secoes.reduce((n, s) => n + s.cards.length, 0) };
}

function secoesPedidas(bruto: unknown): PlanoSecao[] {
  if (!Array.isArray(bruto)) return PLANO_PADRAO;
  const ids = new Set(bruto.filter((x): x is string => typeof x === "string"));
  return PLANO_PADRAO.filter((s) => ids.has(s.id));
}

export function iniciarGeracao(projectPath: string, home: string, input: GerarInput, motor: Motor = motorPadrao(home)): Geracao {
  const atual = geracaoAtual(projectPath);
  if (atual?.status === "rodando") throw erro("já tem uma geração rodando neste projeto", 409);
  const est = estadoDs(projectPath, home);
  if (!est.ds) throw erro("crie o design system antes de gerar", 404);
  const profileId = typeof input.profileId === "string" ? input.profileId : "";
  const perfil = getProfile(profileId, home);
  // status do perfil em disco pode estar velho (login feito por fora): conta sem login de verdade
  // falha no primeiro turno com "a conta precisa de login", que é a mensagem certa de qualquer jeito
  if (!perfil) throw erro("escolha uma conta pra gerar");
  const secoes = secoesPedidas(input.secoes);
  const gerarTokens = input.gerarTokens !== false;
  if (!secoes.length && !gerarTokens) throw erro("nada pra gerar: escolha ao menos uma seção");
  const paralelo = Math.max(1, Math.min(6, Math.floor(Number(input.paralelo) || PARALELO_PADRAO)));
  const brief = typeof input.brief === "string" ? input.brief.trim().slice(0, 4000) : "";
  const url = typeof input.url === "string" ? input.url.trim() : "";

  const g: Geracao = {
    id: `gen-${Date.now().toString(36)}`,
    projectPath,
    status: "rodando",
    inicio: new Date().toISOString(),
    etapas: [
      ...(gerarTokens ? [{ id: "diretor", titulo: "Tokens e regras", status: "pendente" as const, cards: [], prontos: [] }] : []),
      ...secoes.map((s) => ({ id: s.id, titulo: s.titulo, status: "pendente" as const, cards: s.cards.map((c) => c.id), prontos: [] })),
    ],
    plano: secoes.flatMap((s) => s.cards),
  };
  porProjeto.set(projectKey(projectPath), g);
  prepararMeta(projectPath, home, secoes.map((s) => ({ id: s.id, titulo: s.titulo })), g.plano);
  publicar(g);

  const referencia = lerReferencia(input.referencia);
  const ctx: Ctx = {
    g,
    home,
    motor,
    profileId,
    brief,
    logos: [],
    imagens: referencia?.screenshot ? [referencia.screenshot] : [],
    salvar: () => publicar(g),
  };

  void (async () => {
    try {
      let coleta = input.usarCodigo === false ? coletaVazia() : coletarDoCodigo(projectPath);
      // a página capturada no Browser já é a leitura boa (estilo computado); baixar o HTML da
      // mesma URL em texto só repetiria, pior
      if (url && url !== referencia?.url) coleta = await coletarDaUrl(url, coleta);
      // logo: caminho relativo à raiz do projeto, que é a base das imagens no Canvas
      ctx.logos = coleta.logos;

      const diretor = g.etapas.find((e) => e.id === "diretor");
      const textoColeta = [
        referencia
          ? `### Página de referência (estilo computado, capturada no Browser${referencia.screenshot ? "; o print dela vai anexado" : ""})\n${resumoDaReferencia(referencia)}`
          : "",
        `### Código do projeto\n${resumoDaColeta(coleta)}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (diretor) await rodarDiretor(ctx, diretor, textoColeta);
      if (cancelada(g)) return;
      await comTeto(
        secoes.map((s) => async () => {
          const etapa = g.etapas.find((e) => e.id === s.id)!;
          try {
            await rodarSecao(ctx, etapa, s);
          } catch (e) {
            etapa.status = "erro";
            etapa.erro = (e as Error).message;
            ctx.salvar();
          }
        }),
        paralelo,
      );
      if (cancelada(g)) return;
      const falhas = g.etapas.filter((e) => e.status === "erro");
      g.status = falhas.length === g.etapas.length ? "erro" : "concluida";
      if (falhas.length) g.erro = falhas.map((e) => `${e.titulo}: ${e.erro}`).join(" · ");
    } catch (e) {
      g.status = "erro";
      g.erro = (e as Error).message;
      for (const et of g.etapas) if (et.status === "pendente" || et.status === "rodando" || et.status === "corrigindo") et.status = "erro";
    } finally {
      if (cancelada(g)) {
        g.status = "cancelada";
        for (const et of g.etapas) if (et.status !== "ok" && et.status !== "erro") et.status = "cancelado";
        canceladas.delete(g.id);
      }
      g.fim = new Date().toISOString();
      publicar(g);
    }
  })();

  return g;
}

export async function cancelarGeracao(projectPath: string, motor: Pick<Motor, "abortar">): Promise<Geracao | null> {
  const g = geracaoAtual(projectPath);
  if (!g || g.status !== "rodando") return g;
  canceladas.add(g.id);
  await Promise.allSettled(
    g.etapas.filter((e) => e.threadId && (e.status === "rodando" || e.status === "corrigindo")).map((e) => motor.abortar(e.threadId!)),
  );
  return g;
}

/** Só pra teste. */
export function resetGeracaoForTest(): void {
  porProjeto.clear();
  canceladas.clear();
}
