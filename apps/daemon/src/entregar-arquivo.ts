import { isAbsolute, resolve } from "node:path";
import type { ThreadEvent } from "@nexos/shared";
import { entregarArquivo } from "./attachments.ts";
import { sessionBus } from "./bus.ts";
import type { Conjunto, Saida } from "./mcp.ts";
import { appendEvent, readThread } from "./threads.ts";

/**
 * `nexo_arquivo_entregar`: o agente põe um arquivo NA CONVERSA — relatório, planilha, export, zip,
 * imagem gerada. O chat mostra um cartão com Baixar e Abrir no preview; sem isso a pessoa tinha
 * que ir caçar o caminho que o agente citou no texto.
 */

export const MCP_TOOLS_ENTREGAR = ["mcp__nexo__nexo_arquivo_entregar"];

const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Caminho relativo vale a partir de onde o agente trabalha: a worktree da conversa, senão o projeto. */
function pastaDaConversa(threadId: string, home: string): string {
  const meta = readThread(threadId, home).find((e) => e.type === "thread_meta");
  if (meta?.type !== "thread_meta") return "";
  return meta.worktreeDir || meta.projectPath || "";
}

export function entregar(threadId: string, args: Record<string, unknown>, home: string): Saida {
  const caminho = texto(args.caminho);
  if (!caminho) return { ok: false, texto: 'faltou "caminho" (absoluto ou relativo à pasta do projeto)' };
  let origem = caminho;
  if (!isAbsolute(caminho)) {
    const base = pastaDaConversa(threadId, home);
    if (!base) return { ok: false, texto: "conversa sem pasta de projeto: passe o caminho absoluto" };
    origem = resolve(base, caminho);
  }
  try {
    const arquivo = entregarArquivo(threadId, origem, home, texto(args.nome) || undefined);
    const descricao = texto(args.descricao).slice(0, 300);
    const ev: ThreadEvent = { ts: new Date().toISOString(), type: "arquivo_entregue", threadId, arquivo, ...(descricao ? { descricao } : {}) };
    appendEvent(ev, home);
    sessionBus.emit(threadId, ev);
    return {
      ok: true,
      texto: `"${arquivo.name}" (${kb(arquivo.bytes)}) está no chat: a pessoa baixa ou abre no preview dali. Não precisa repetir o caminho na resposta.`,
    };
  } catch (e) {
    return { ok: false, texto: (e as Error).message };
  }
}

export function ferramentaDeEntregar(threadId: string, home: string): Conjunto {
  return () => [
    {
      name: "nexo_arquivo_entregar",
      description:
        "Coloca um arquivo NESTA conversa pra pessoa baixar ou abrir no preview (cartão com botões no chat). " +
        "Use sempre que gerar ou achar um arquivo que é a entrega pra ela: relatório, PDF, planilha/CSV, export, " +
        "zip, imagem, página HTML — ou quando ela pedir \"me manda o arquivo\". O Nexos guarda uma cópia, então pode " +
        "apagar o temporário depois. Até 100 MB.",
      inputSchema: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "caminho do arquivo: absoluto, ou relativo à pasta do projeto" },
          nome: { type: "string", description: "nome que a pessoa vê e com que o arquivo baixa (padrão: o nome do arquivo)" },
          descricao: { type: "string", description: "uma linha dizendo o que é o arquivo" },
        },
        required: ["caminho"],
        additionalProperties: false,
      },
      executar: (args) => entregar(threadId, args, home),
    },
  ];
}
