import { PAINEIS_DO_AGENTE, type NavegadorModo, type PaineisDoAgente, type PainelDoAgente } from "@nexos/shared";
import { sessionBus } from "./bus.ts";
import { loadConfig } from "./config.ts";
import type { Conjunto, Saida } from "./mcp.ts";
import { perguntar } from "./perguntas.ts";

/**
 * `nexo_abrir_painel`: o agente abre, na área de trabalho da conversa dele, o painel que o
 * trabalho pede — o navegador pra testar uma tela, o Design System pra criar design, o Quadro, o
 * plano, um arquivo, o terminal. A pessoa vê o que ele está fazendo sem ir procurar.
 *
 * Mesma ponte de `ds-print.ts`: evento no bus "*" com id por pedido, o renderer abre e responde
 * em `POST /v1/paineis/:id/responder`. O painel abre na sessão de trabalho DESTA conversa; se a
 * pessoa está olhando outra, ele fica pronto pra quando ela voltar (e a resposta diz isso).
 */

export const PAINEIS = PAINEIS_DO_AGENTE;
export type Painel = PainelDoAgente;

export const MCP_TOOLS_PAINEL = ["mcp__nexo__nexo_abrir_painel"];

export type PedidoDePainel = {
  painel: Painel;
  url?: string;
  sistema?: string;
  card?: string;
  tarefa?: string;
  caminho?: string;
  /** Config `trazerPraFrente`: troca a aba visível (senão a aba só fica aberta). */
  frente?: boolean;
};

type Pendente = { resolve: (r: Saida) => void; timeoutId: ReturnType<typeof setTimeout> };
const pendentes = new Map<string, Pendente>();

/** Abrir aba é instantâneo; sem app aberto nunca vem resposta. */
const PAINEL_TIMEOUT_MS = 10_000;
let seq = 0;

export function pedirPainel(threadId: string, pedido: PedidoDePainel): Promise<Saida> {
  seq += 1;
  const id = `pn-${Date.now().toString(36)}-${seq}`;
  return new Promise<Saida>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendentes.delete(id);
      resolve({ ok: false, texto: "o app não respondeu — a janela do Nexos está aberta?" });
    }, PAINEL_TIMEOUT_MS);
    pendentes.set(id, { resolve, timeoutId });
    sessionBus.emit("*", { type: "abrir_painel", threadId, id, ...pedido });
  });
}

export function responderPainel(id: string, r: Saida): boolean {
  const p = pendentes.get(id);
  if (!p) return false;
  clearTimeout(p.timeoutId);
  pendentes.delete(id);
  p.resolve(r);
  return true;
}

export function resetPaineisForTest(): void {
  for (const p of pendentes.values()) clearTimeout(p.timeoutId);
  pendentes.clear();
}

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Valida o pedido do modelo. URL só http(s)/file e só com o navegador liberado pra conta — sem
 * isso o painel abre vazio (abrir a aba não é controlar o navegador; navegar é). Caminho de
 * arquivo é relativo ao projeto, sem `..`.
 */
export function montarPedido(
  args: Record<string, unknown>,
  modoNavegador: NavegadorModo,
  cfg: PaineisDoAgente,
): PedidoDePainel | string {
  const painel = args.painel as Painel;
  if (!PAINEIS.includes(painel)) return `painel inválido: use ${PAINEIS.join(", ")}`;
  if (!cfg.paineis.includes(painel)) {
    return `a pessoa não deixa o agente abrir o painel "${painel}" (Configurações → Painéis do agente). Liberados: ${cfg.paineis.join(", ") || "nenhum"}`;
  }
  const pedido: PedidoDePainel = { painel, frente: cfg.trazerPraFrente };
  if (painel === "navegador") {
    const url = texto(args.url);
    if (url) {
      if (!/^(https?|file):\/\//i.test(url) && !/^localhost(:\d+)?(\/|$)/i.test(url)) return "url precisa ser http(s)://, file:// ou localhost:porta";
      if (modoNavegador === "negado") return "o controle do navegador está desligado pra esta conta: abra sem url, ou peça pra pessoa ligar em Configurações";
      pedido.url = url;
    }
  }
  if (painel === "design") {
    const card = texto(args.card);
    const sistema = texto(args.sistema);
    if (card) pedido.card = card;
    if (sistema) pedido.sistema = sistema;
  }
  if (painel === "tarefas" && texto(args.tarefa)) pedido.tarefa = texto(args.tarefa);
  if (painel === "arquivo") {
    const caminho = texto(args.caminho).replace(/\\/g, "/");
    if (!caminho) return 'faltou "caminho" (relativo à raiz do projeto)';
    if (/^([a-z]:)?\//i.test(caminho) || caminho.split("/").includes("..")) return "caminho precisa ser relativo ao projeto, sem ..";
    pedido.caminho = caminho;
  }
  return pedido;
}

/**
 * Some quando a config está em `nunca` (ou sem painel liberado). Em `perguntar`, cada abertura
 * passa por `nexo_perguntar` antes.
 */
export function ferramentaDePainel(threadId: string, modoNavegador: NavegadorModo, home: string): Conjunto {
  return () => {
    const cfg = loadConfig(home).paineisDoAgente;
    if (cfg.modo === "nunca" || !cfg.paineis.length) return [];
    return [
      {
        name: "nexo_abrir_painel",
        description:
          "Abre na área de trabalho desta conversa o painel que o trabalho pede, pra pessoa acompanhar: " +
          "`navegador` (preview/teste de uma tela — passe `url`, ex.: http://localhost:5173/login), " +
          "`design` (Canvas do Design System — pra criar/ver mock; `card` foca uma tela, `sistema` escolhe o DS), " +
          "`planejamento` (plano desta conversa), `tarefas` (Quadro; `tarefa` abre uma), " +
          "`arquivo` (`caminho` relativo ao projeto) ou `terminal`. Use ao começar a trabalhar numa dessas coisas. " +
          `Liberados pela pessoa: ${cfg.paineis.join(", ")}.`,
        inputSchema: {
          type: "object",
          properties: {
            painel: { type: "string", enum: [...cfg.paineis] },
            url: { type: "string", description: "navegador: URL a abrir" },
            sistema: { type: "string", description: "design: id do design system (troca o ativo, com confirmação da pessoa)" },
            card: { type: "string", description: "design: id da tela/card a focar" },
            tarefa: { type: "string", description: "tarefas: id da tarefa a abrir" },
            caminho: { type: "string", description: "arquivo: caminho relativo à raiz do projeto" },
          },
          required: ["painel"],
          additionalProperties: false,
        },
        executar: async (args) => {
          const pedido = montarPedido(args, modoNavegador, cfg);
          if (typeof pedido === "string") return { ok: false, texto: pedido };
          if (cfg.modo === "perguntar") {
            const alvo = pedido.url || pedido.card || pedido.tarefa || pedido.caminho;
            const r = await perguntar(threadId, home, `Abrir o painel ${pedido.painel}${alvo ? ` (${alvo})` : ""}?`, ["sim", "não"]);
            if (!r.ok || r.texto.trim().toLowerCase() !== "sim") return { ok: false, texto: "a pessoa não quis abrir o painel agora" };
          }
          return pedirPainel(threadId, pedido);
        },
      },
    ];
  };
}
