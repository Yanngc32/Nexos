import { EventEmitter } from "node:events";
import type { NavegadorModo } from "@nexos/shared";
import type { Conjunto, Ferramenta, Saida } from "./mcp.ts";
import { perguntar } from "./perguntas.ts";

/**
 * `nexo_chrome_*`: dá ao LLM o Chrome DA PESSOA (com os logins dela), via a extensão em
 * `apps/chrome-extension`. Mesma ponte de `navegador.ts` (pendente por thread + resposta por
 * HTTP), com três diferenças deliberadas:
 *
 * 1. **Canal próprio** (`chromeBus` + `GET /v1/chrome/events`), não o `"*"` do `sessionBus`. O
 *    stream global leva TODA a conversa de todo agente; a extensão só precisa dos comandos dela, e
 *    não tem por que receber o resto.
 * 2. **Falha na hora sem extensão** — conta os streams abertos. Sem nenhum, o agente ouve "a
 *    extensão não está conectada" em vez de esperar o timeout.
 * 3. **Escopo é da extensão**: ela só age em abas do grupo "Nexos" que o próprio agente abriu.
 *    Isso é trava do lado dela (é ela que enxerga as abas), não daqui.
 */

export type AcaoChrome = "abas" | "abrir" | "ler" | "markdown" | "screenshot" | "clicar" | "digitar" | "rolar" | "tecla";

export type ArgsChrome = { acao: AcaoChrome; aba?: number } & Record<string, unknown>;

type Pendente = { id: string; resolve: (r: Saida) => void; timeoutId: ReturnType<typeof setTimeout> };

/** Só a extensão escuta: `GET /v1/chrome/events`. */
export const chromeBus = new EventEmitter();
chromeBus.setMaxListeners(20);

const pendentes = new Map<string, Pendente>();

/** Página lenta pra carregar (abrir espera o `complete`) — mais folga que o painel Browser. */
const COMANDO_TIMEOUT_MS = 30_000;

/**
 * O service worker da extensão (MV3) morre e renasce sozinho; entre um e outro não há stream
 * aberto. As ferramentas continuam listadas por esse tempo depois da queda, pra conversa não
 * perder e ganhar ferramenta a cada reinício dele.
 */
const JANELA_RECENTE_MS = 10 * 60_000;

let conexoes = 0;
let conectadaDesde = 0;
let ultimaQueda = 0;
let versaoExtensao = "";

let seq = 0;
function novoId(): string {
  seq += 1;
  return `cc-${Date.now().toString(36)}-${seq}`;
}

/** Stream da extensão abriu. Devolve quem fecha — chamar uma vez só, no abort do stream. */
export function extensaoConectou(versao = "", agora = Date.now()): () => void {
  if (conexoes === 0) conectadaDesde = agora;
  conexoes += 1;
  if (versao) versaoExtensao = versao;
  let fechado = false;
  return () => {
    if (fechado) return;
    fechado = true;
    conexoes -= 1;
    if (conexoes === 0) ultimaQueda = Date.now();
  };
}

export function extensaoConectada(): boolean {
  return conexoes > 0;
}

/** Conectada agora ou caiu há pouco (service worker reiniciando) — critério pra listar as ferramentas. */
export function extensaoRecente(agora = Date.now()): boolean {
  return conexoes > 0 || (ultimaQueda > 0 && agora - ultimaQueda < JANELA_RECENTE_MS);
}

export function statusDaExtensao() {
  return {
    conectada: conexoes > 0,
    desde: conexoes > 0 ? conectadaDesde : null,
    ultimaQueda: ultimaQueda || null,
    versao: versaoExtensao || null,
  };
}

/** Pede à extensão pra executar `args` e espera o resultado (ou o timeout). Um comando por thread. */
export function comandoChrome(threadId: string, args: ArgsChrome): Promise<Saida> {
  if (!extensaoConectada()) {
    return Promise.resolve({
      ok: false,
      texto:
        "a extensão Nexos do Chrome não está conectada — peça pra pessoa abrir o Chrome com a extensão " +
        "pareada (Configurações › Extensão do Chrome)",
    });
  }
  if (pendentes.has(threadId)) {
    return Promise.resolve({ ok: false, texto: "já existe um comando do Chrome pendente nesta conversa" });
  }
  const id = novoId();
  return new Promise<Saida>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendentes.delete(threadId);
      resolve({ ok: false, texto: "a extensão do Chrome não respondeu a tempo" });
    }, COMANDO_TIMEOUT_MS);
    pendentes.set(threadId, { id, resolve, timeoutId });
    chromeBus.emit("comando", { type: "chrome_comando", id, threadId, ...args });
  });
}

/**
 * Resolve o comando pendente desta thread. Com `id`, só resolve se for o mesmo comando — resposta
 * atrasada de um comando que já expirou não pode fechar o seguinte.
 */
export function responderChrome(threadId: string, resultado: Saida, id?: string): boolean {
  const p = pendentes.get(threadId);
  if (!p) return false;
  if (id && id !== p.id) return false;
  clearTimeout(p.timeoutId);
  pendentes.delete(threadId);
  p.resolve(resultado);
  return true;
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetChromeForTest(): void {
  for (const p of pendentes.values()) clearTimeout(p.timeoutId);
  pendentes.clear();
  conexoes = 0;
  conectadaDesde = 0;
  ultimaQueda = 0;
  versaoExtensao = "";
  chromeBus.removeAllListeners();
}

export const MCP_TOOLS_CHROME = [
  "mcp__nexo__nexo_chrome_abas_listar",
  "mcp__nexo__nexo_chrome_abrir",
  "mcp__nexo__nexo_chrome_ler",
  "mcp__nexo__nexo_chrome_markdown",
  "mcp__nexo__nexo_chrome_screenshot",
  "mcp__nexo__nexo_chrome_clicar",
  "mcp__nexo__nexo_chrome_digitar",
  "mcp__nexo__nexo_chrome_rolar",
  "mcp__nexo__nexo_chrome_tecla",
];

const ABA = {
  type: "integer",
  description: "id da aba (de nexo_chrome_abas_listar). Sem ele, vale a última aba que você usou nesta conversa.",
};

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function aba(args: Record<string, unknown>): { aba?: number } {
  return typeof args.aba === "number" && Number.isInteger(args.aba) ? { aba: args.aba } : {};
}

/**
 * As 9 ferramentas `nexo_chrome_*`, presas a ESTE thread e ao `modo` da conta (o mesmo
 * `navegadorModo` do painel Browser). Quem monta o conjunto decide se entram.
 */
export function ferramentasDoChrome(threadId: string, home: string, modo: NavegadorModo): Conjunto {
  /** No modo "questionar", confirma ação que muda estado — ler, print, listar e rolar nunca perguntam. */
  async function confirmar(descricao: string): Promise<Saida | null> {
    if (modo !== "questionar") return null;
    const r = await perguntar(threadId, home, `${descricao} (responda "sim" pra confirmar)`, ["sim", "não"]);
    if (!r.ok || r.texto.trim().toLowerCase() !== "sim") return { ok: false, texto: 'cancelado — resposta não foi "sim"' };
    return null;
  }

  const semArgs = (name: string, description: string, acao: AcaoChrome): Ferramenta => ({
    name,
    description,
    inputSchema: { type: "object", properties: { aba: ABA }, additionalProperties: false },
    executar: (args) => comandoChrome(threadId, { acao, ...aba(args) }),
  });

  return () => [
    {
      name: "nexo_chrome_abas_listar",
      description:
        "Lista as abas do grupo \"Nexos\" no Chrome da pessoa (id, título, URL, qual está ativa). Você só " +
        "enxerga e mexe nessas abas — as outras abas da pessoa ficam fora de alcance.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: () => comandoChrome(threadId, { acao: "abas" }),
    },
    {
      name: "nexo_chrome_abrir",
      description:
        "Abre uma URL no Chrome REAL da pessoa (com os logins dela), dentro do grupo de abas \"Nexos\". " +
        "Sem `nova_aba`, reaproveita a aba que você usou por último; espera a página carregar.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL completa (http/https)" },
          nova_aba: { type: "boolean", description: "true abre numa aba nova do grupo" },
          aba: ABA,
        },
        required: ["url"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const url = texto(args.url);
        if (!url) return { ok: false, texto: 'faltou "url"' };
        const bloqueio = await confirmar(`Abrir "${url}" no seu Chrome?`);
        if (bloqueio) return bloqueio;
        return comandoChrome(threadId, { acao: "abrir", url, nova: args.nova_aba === true, ...aba(args) });
      },
    },
    semArgs(
      "nexo_chrome_ler",
      "Lê a aba como árvore simplificada: cada elemento (link, botão, campo, título, texto relevante) ganha " +
        "um ref curto (ref_1, ref_2...) com papel e texto. Use os refs em clicar/digitar/rolar. Uma leitura " +
        "nova invalida os refs anteriores.",
      "ler",
    ),
    semArgs(
      "nexo_chrome_markdown",
      "Lê o CONTEÚDO da aba como markdown (títulos, listas, tabelas, links, código), sem menu/rodapé. Pra " +
        "clicar/digitar use nexo_chrome_ler, que dá os refs.",
      "markdown",
    ),
    semArgs("nexo_chrome_screenshot", "Print (JPEG) da aba, mesmo que ela não esteja na frente.", "screenshot"),
    {
      name: "nexo_chrome_clicar",
      description:
        "Clica no elemento do ref (de uma leitura recente). Por padrão é um clique de página (eventos DOM); " +
        "`real: true` usa um clique de mouse de verdade (pro site que ignora o outro — o Chrome mostra a " +
        "faixa de depuração enquanto isso).",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'o "ref" de uma leitura recente' },
          real: { type: "boolean", description: "clique de mouse de verdade (CDP)" },
          aba: ABA,
        },
        required: ["ref"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const ref = texto(args.ref);
        if (!ref) return { ok: false, texto: 'faltou "ref"' };
        const bloqueio = await confirmar(`Clicar em "${ref}" no seu Chrome?`);
        if (bloqueio) return bloqueio;
        return comandoChrome(threadId, { acao: "clicar", ref, real: args.real === true, ...aba(args) });
      },
    },
    {
      name: "nexo_chrome_digitar",
      description:
        'Digita "texto" no campo do ref (substitui o que tinha). `enter: true` aperta Enter no fim. `real: ' +
        "true` digita como teclado de verdade (CDP), pro editor que não aceita o valor direto.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'o "ref" de uma leitura recente' },
          texto: { type: "string", description: "o texto a digitar" },
          enter: { type: "boolean", description: "aperta Enter depois" },
          real: { type: "boolean", description: "digitação de teclado de verdade (CDP)" },
          aba: ABA,
        },
        required: ["ref", "texto"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const ref = texto(args.ref);
        if (!ref) return { ok: false, texto: 'faltou "ref"' };
        const t = typeof args.texto === "string" ? args.texto : "";
        const bloqueio = await confirmar(`Digitar em "${ref}" no seu Chrome?`);
        if (bloqueio) return bloqueio;
        return comandoChrome(threadId, {
          acao: "digitar",
          ref,
          texto: t,
          enter: args.enter === true,
          real: args.real === true,
          ...aba(args),
        });
      },
    },
    {
      name: "nexo_chrome_rolar",
      description: 'Rola a aba: "direcao" (baixo/cima/topo/fim) ou até o elemento de um "ref".',
      inputSchema: {
        type: "object",
        properties: {
          direcao: { type: "string", enum: ["baixo", "cima", "topo", "fim"] },
          ref: { type: "string", description: "rola até este elemento (ignora direcao)" },
          aba: ABA,
        },
        additionalProperties: false,
      },
      executar: (args) => {
        const ref = texto(args.ref);
        const direcao = texto(args.direcao) || "baixo";
        return comandoChrome(threadId, { acao: "rolar", ...(ref ? { ref } : { direcao }), ...aba(args) });
      },
    },
    {
      name: "nexo_chrome_tecla",
      description:
        'Aperta uma tecla de verdade na aba (CDP): "Enter", "Tab", "Escape", "ArrowDown", "Backspace"... ' +
        'Com modificador: "Control+a", "Shift+Tab".',
      inputSchema: {
        type: "object",
        properties: { tecla: { type: "string" }, aba: ABA },
        required: ["tecla"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const tecla = texto(args.tecla);
        if (!tecla) return { ok: false, texto: 'faltou "tecla"' };
        const bloqueio = await confirmar(`Apertar "${tecla}" no seu Chrome?`);
        if (bloqueio) return bloqueio;
        return comandoChrome(threadId, { acao: "tecla", tecla, ...aba(args) });
      },
    },
  ];
}
