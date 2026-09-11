import type { NavegadorModo } from "@nexo/shared";
import type { Conjunto } from "./mcp.ts";
import { sessionBus } from "./bus.ts";
import { perguntar } from "./perguntas.ts";
import { activeProfileId, readThread } from "./threads.ts";
import { getProfile } from "./profiles.ts";

/**
 * `nexo_navegador_*`: dá ao LLM controle real do painel Browser do desktop (abrir URL, ler
 * página, screenshot, clicar, digitar). Ver
 * `docs/superpowers/specs/2026-09-10-repo-map-design.md` (Parte 2).
 *
 * Mesma ponte que `perguntas.ts` já resolveu pra "daemon precisa de algo que só o processo
 * RENDERER da janela Electron consegue fazer" (`Map<threadId, resolver>` + evento de bus + endpoint
 * HTTP que resolve a Promise) — com duas diferenças deliberadas:
 *
 * 1. **Timeout próprio, curto** (`COMANDO_TIMEOUT_MS`). `nexo_perguntar` não tem timeout interno
 *    porque confia no teto de turno (~15min) e há uma PESSOA decidindo do outro lado. Aqui é um
 *    round-trip TÉCNICO (renderer rodando `capturePage`/`executeJavaScript`) — travar o turno
 *    inteiro esperando 15min porque o painel Browser está fechado é a UX errada; falhar rápido com
 *    mensagem clara é melhor que parecer travado.
 * 2. **Não persiste via `appendEvent`** — `pergunta`/`pergunta_resposta` são conteúdo de conversa
 *    que a PESSOA precisa ler no histórico; `browser_comando` é sinalização técnica interna entre
 *    daemon e renderer (podendo carregar HTML/base64 de screenshot), sem valor de leitura humana.
 *    Só `sessionBus.emit(threadId, ev)`, sem gravar no JSONL e sem `emit("*")` (não precisa de
 *    badge global — é sub-segundo, não uma decisão pendente).
 */

export type AcaoNavegador = "abrir" | "ler" | "screenshot" | "clicar" | "digitar";

export type ArgsNavegador =
  | { acao: "abrir"; url: string }
  | { acao: "ler" }
  | { acao: "screenshot" }
  | { acao: "clicar"; ref: string }
  | { acao: "digitar"; ref: string; texto: string };

/** Resultado que o renderer devolve. `imagem` só em screenshot (ver extensão de `Saida` em mcp.ts). */
export type ResultadoNavegador = { ok: boolean; texto: string; imagem?: { dataBase64: string; mimeType: string } };

type Pendente = { resolve: (r: ResultadoNavegador) => void; timeoutId: ReturnType<typeof setTimeout> };

/** Comando de navegador em voo, por thread — no máximo um de cada vez, mesma regra de perguntas.ts. */
const pendentes = new Map<string, Pendente>();

/** É round-trip técnico, não decisão humana — deveria responder em segundos; 20s dá folga generosa. */
const COMANDO_TIMEOUT_MS = 20_000;

let seq = 0;
function newComandoId(): string {
  seq += 1;
  return `bc-${Date.now().toString(36)}-${seq}`;
}

/**
 * Baixo nível, sem casca de ferramenta MCP — pede ao renderer da janela pra executar `args` no
 * painel Browser e espera o resultado (ou o timeout). Só UM comando pendente por thread.
 */
export function comandoNavegador(threadId: string, args: ArgsNavegador): Promise<ResultadoNavegador> {
  if (pendentes.has(threadId)) {
    return Promise.resolve({ ok: false, texto: "já existe um comando de navegador pendente nesta conversa" });
  }
  const id = newComandoId();
  return new Promise<ResultadoNavegador>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendentes.delete(threadId);
      resolve({ ok: false, texto: "painel Browser não respondeu a tempo — está aberto e nesta conversa?" });
    }, COMANDO_TIMEOUT_MS);
    pendentes.set(threadId, { resolve, timeoutId });
    sessionBus.emit(threadId, { type: "browser_comando", threadId, id, ...args });
  });
}

/** Resolve o comando pendente desta thread. `false` se não havia nenhum (já respondido, ou nunca existiu). */
export function responderNavegador(threadId: string, resultado: ResultadoNavegador): boolean {
  const p = pendentes.get(threadId);
  if (!p) return false;
  clearTimeout(p.timeoutId);
  pendentes.delete(threadId);
  p.resolve(resultado);
  return true;
}

/** O modo de navegador da conta que está tocando esta conversa agora. `"negado"` se não der pra saber. */
export function modoDeNavegadorDaThread(threadId: string, home: string): NavegadorModo {
  try {
    const events = readThread(threadId, home);
    const profileId = activeProfileId(events);
    return getProfile(profileId, home)?.navegadorModo ?? "negado";
  } catch {
    return "negado";
  }
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetNavegadorForTest(): void {
  for (const p of pendentes.values()) clearTimeout(p.timeoutId);
  pendentes.clear();
}

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS_NAVEGADOR = [
  "mcp__nexo__nexo_navegador_abrir",
  "mcp__nexo__nexo_navegador_ler",
  "mcp__nexo__nexo_navegador_screenshot",
  "mcp__nexo__nexo_navegador_clicar",
  "mcp__nexo__nexo_navegador_digitar",
];

/**
 * As 5 ferramentas `nexo_navegador_*`, presas a ESTE thread e ao `modo` da conta. Só deve entrar
 * no `Conjunto` quando `modo !== "negado"` — quem decide isso é quem monta o conjunto (http.ts),
 * não esta função (mesmo critério de `ferramentaDeDelegar`).
 */
export function ferramentasDeNavegador(threadId: string, home: string, modo: NavegadorModo): Conjunto {
  /** No modo "questionar", confirma AÇÕES QUE MUDAM ESTADO antes de rodar — ler/screenshot nunca perguntam. */
  async function confirmar(acaoDescricao: string): Promise<{ ok: boolean; texto: string } | null> {
    if (modo !== "questionar") return null;
    const r = await perguntar(threadId, home, `${acaoDescricao} (responda "sim" pra confirmar)`, ["sim", "não"]);
    if (!r.ok || r.texto.trim().toLowerCase() !== "sim") return { ok: false, texto: 'cancelado — resposta não foi "sim"' };
    return null;
  }

  return () => [
    {
      name: "nexo_navegador_abrir",
      description: "Navega o painel Browser do desktop pra uma URL. Funciona mesmo com o painel vazio/em branco.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "URL completa a abrir" } },
        required: ["url"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) return { ok: false, texto: 'faltou "url"' };
        const bloqueio = await confirmar(`Abrir "${url}" no painel Browser?`);
        if (bloqueio) return bloqueio;
        return comandoNavegador(threadId, { acao: "abrir", url });
      },
    },
    {
      name: "nexo_navegador_ler",
      description:
        "Lê a página aberta no painel Browser agora, como árvore simplificada (tipo accessibility tree): " +
        "cada elemento (link, botão, campo, cabeçalho, widget custom sem acessibilidade, texto solto " +
        "relevante) ganha uma referência curta (ref_1, ref_2...), papel e texto. Papel \"texto\" é só " +
        "leitura (valor exibido na tela, ex.: \"R$ 1.234,56\") — clicar/digitar só faz sentido nos demais " +
        "papéis. Use os refs em `nexo_navegador_clicar`/`digitar`. Uma nova leitura invalida os refs da " +
        "leitura anterior.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: () => comandoNavegador(threadId, { acao: "ler" }),
    },
    {
      name: "nexo_navegador_screenshot",
      description: "Tira um print (PNG) do que está no painel Browser agora.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      executar: () => comandoNavegador(threadId, { acao: "screenshot" }),
    },
    {
      name: "nexo_navegador_clicar",
      description:
        'Clica no elemento apontado por "ref" (de uma leitura de `nexo_navegador_ler` recente). Ref ' +
        "inválido ou de antes de uma navegação é erro — releia a página antes de tentar de novo.",
      inputSchema: {
        type: "object",
        properties: { ref: { type: "string", description: 'o "ref" de uma leitura recente' } },
        required: ["ref"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const ref = typeof args.ref === "string" ? args.ref.trim() : "";
        if (!ref) return { ok: false, texto: 'faltou "ref"' };
        const bloqueio = await confirmar(`Clicar em "${ref}" no painel Browser?`);
        if (bloqueio) return bloqueio;
        return comandoNavegador(threadId, { acao: "clicar", ref });
      },
    },
    {
      name: "nexo_navegador_digitar",
      description:
        'Digita "texto" no campo apontado por "ref". Ref inválido ou de antes de uma navegação é erro — ' +
        "releia a página antes de tentar de novo.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'o "ref" de uma leitura recente' },
          texto: { type: "string", description: "o texto a digitar" },
        },
        required: ["ref", "texto"],
        additionalProperties: false,
      },
      executar: async (args) => {
        const ref = typeof args.ref === "string" ? args.ref.trim() : "";
        const texto = typeof args.texto === "string" ? args.texto : "";
        if (!ref) return { ok: false, texto: 'faltou "ref"' };
        const bloqueio = await confirmar(`Digitar em "${ref}" no painel Browser?`);
        if (bloqueio) return bloqueio;
        return comandoNavegador(threadId, { acao: "digitar", ref, texto });
      },
    },
  ];
}
