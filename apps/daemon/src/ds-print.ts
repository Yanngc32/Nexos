import { sessionBus } from "./bus.ts";
import { estadoDs } from "./design-system.ts";
import type { Conjunto, Saida } from "./mcp.ts";

/**
 * `nexo_ds_print`: o agente VÊ o card renderizado. O daemon não desenha HTML — quem desenha é o
 * app: o renderer monta o mesmo documento do Canvas (tokens, kit, fontes, card) e o processo
 * principal do Electron renderiza numa janela invisível e tira o print. Funciona com o Canvas
 * fechado. Mesma ponte de `navegador.ts` (evento no bus "*" + rota que resolve a Promise), com
 * id por pedido em vez de por thread: dois agentes podem pedir print ao mesmo tempo.
 */

/** Liberada no `--allowed-tools` do claude (session.ts) — a ferramenta some sozinha se não houver DS. */
export const MCP_TOOLS_DS_PRINT = ["mcp__nexo__nexo_ds_print"];

export type ResultadoPrint = { ok: boolean; texto: string; imagem?: { dataBase64: string; mimeType: string } };

type Pendente = { resolve: (r: ResultadoPrint) => void; timeoutId: ReturnType<typeof setTimeout> };
const pendentes = new Map<string, Pendente>();

/** Renderizar + esperar fonte leva alguns segundos; sem app aberto não vem resposta nunca. */
const PRINT_TIMEOUT_MS = 30_000;
let seq = 0;

export function pedirPrint(threadId: string, projectPath: string, card: string, tema: string): Promise<ResultadoPrint> {
  seq += 1;
  const id = `dp-${Date.now().toString(36)}-${seq}`;
  return new Promise<ResultadoPrint>((resolve) => {
    const timeoutId = setTimeout(() => {
      pendentes.delete(id);
      resolve({ ok: false, texto: "o app não respondeu a tempo — a janela do Nexos está aberta?" });
    }, PRINT_TIMEOUT_MS);
    pendentes.set(id, { resolve, timeoutId });
    // threadId no evento: o stream global do app descarta evento sem conversa
    sessionBus.emit("*", { type: "ds_print", threadId, id, projectPath, card, tema });
  });
}

export function responderPrint(id: string, resultado: ResultadoPrint): boolean {
  const p = pendentes.get(id);
  if (!p) return false;
  clearTimeout(p.timeoutId);
  pendentes.delete(id);
  p.resolve(resultado);
  return true;
}

export function resetPrintForTest(): void {
  for (const p of pendentes.values()) clearTimeout(p.timeoutId);
  pendentes.clear();
}

/** Só aparece em conversa de projeto que TEM design system ativo. */
export function ferramentaDePrintDoDs(threadId: string, projectPath: string, home: string): Conjunto {
  return () => {
    let ds;
    try {
      ds = estadoDs(projectPath, home).ds;
    } catch {
      return [];
    }
    if (!ds) return [];
    return [
      {
        name: "nexo_ds_print",
        description:
          "Print do card do design system RENDERIZADO (como aparece no Canvas: tokens, fontes e classes do kit aplicados). " +
          "Use depois de criar ou editar um card pra conferir o visual antes de dizer que ficou pronto. " +
          "Sem `card`, devolve a lista de cards (id, seção, largura, avisos do lint). `tema` opcional (tema de tokens.json).",
        inputSchema: {
          type: "object",
          properties: {
            card: { type: "string", description: "id do card (nome do arquivo em cards/, sem .html) ou de um Fundamento (fund-cores…)" },
            tema: { type: "string", description: "tema declarado em tokens.json ($extensions.nexos.temas); vazio = padrão" },
          },
        },
        executar: async (args): Promise<Saida> => {
          const atual = estadoDs(projectPath, home).ds;
          if (!atual) return { ok: false, texto: "este projeto não tem design system" };
          const todos = [
            ...atual.fundamentos.map((f) => ({ id: f.id, secao: "fundamentos", largura: f.largura ?? "1/2", avisos: 0 })),
            ...atual.cards.map((c) => ({ id: c.id, secao: c.secao, largura: c.largura ?? "1/2", avisos: c.lint.length })),
          ];
          const card = typeof args.card === "string" ? args.card.trim() : "";
          if (!card) {
            return {
              ok: true,
              texto: `Cards do DS "${atual.nome}":\n${todos.map((c) => `- ${c.id} · ${c.secao} · ${c.largura}${c.avisos ? ` · ${c.avisos} aviso(s)` : ""}`).join("\n")}`,
            };
          }
          if (!todos.some((c) => c.id === card)) return { ok: false, texto: `card "${card}" não existe. Chame sem \`card\` pra ver a lista.` };
          const tema = typeof args.tema === "string" ? args.tema.trim() : "";
          return pedirPrint(threadId, projectPath, card, tema);
        },
      },
    ];
  };
}
