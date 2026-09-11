import type { Conjunto } from "./mcp.ts";

/**
 * Registro do veredito que um run de `git.pre-push` BLOQUEANTE declara (ver `dispararPrePush`,
 * em hooks.ts) — em arquivo à parte, sem depender de `runs.ts`/`teams.ts`, porque `session.ts`
 * precisa do nome da ferramenta (`MCP_TOOLS_VEREDITO`) pra montar o `--allowed-tools` do motor, e
 * `hooks.ts` importa `runs.ts`, que importa `session.ts` — um `hooks.ts` → `session.ts` fecharia
 * ciclo de módulo.
 */

/** Veredito que um run de pre-push declarou, por `runId`. */
const vereditos = new Map<string, { aprovado: boolean; motivo: string }>();

export function registrarVeredito(runId: string, aprovado: boolean, motivo: string): void {
  vereditos.set(runId, { aprovado, motivo: motivo.slice(0, 2000) });
}

/** Consome (lê e apaga) o veredito de um run — chamado uma vez, logo depois do run terminar. */
export function consumirVeredito(runId: string): { aprovado: boolean; motivo: string } {
  const v = vereditos.get(runId);
  vereditos.delete(runId);
  return v ?? { aprovado: false, motivo: "agente não declarou veredito" };
}

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS_VEREDITO = ["mcp__nexo__nexo_veredito"];

/**
 * Ferramenta MCP `nexo_veredito`, presa a UM run — mesmo padrão de `ferramentasDeRepoMap`. Não
 * usa `/v1/mcp/:id` (a boca do SUPERVISOR): um passo de PIPELINE roda como conversa normal
 * (`executarPasso` em runs.ts chama `createThread`/`postMessage`, sem o mecanismo de supervisor),
 * então esta ferramenta entra pela boca de autoria (`/v1/mcp`) quando a conversa carrega um
 * `runId` — ver `caminhoDaAutoria` (mcp.ts) e o handler em http.ts.
 *
 * Chamável só nesse runId específico: um token vazado desta conversa não alcança o veredito de
 * OUTRO run, porque o `runId` já vem embutido na URL que só esta conversa recebeu.
 */
export function ferramentaDeVeredito(runId: string): Conjunto {
  return () => [
    {
      name: "nexo_veredito",
      description:
        "Declara o veredito deste hook de pre-push: aprova ou reprova o `git push`. Chame isto " +
        "OBRIGATORIAMENTE ao terminar sua análise — sem esta chamada o push é reprovado por padrão.",
      inputSchema: {
        type: "object",
        properties: {
          aprovado: { type: "boolean", description: "true libera o push, false barra" },
          motivo: { type: "string", description: "por quê — é isso que aparece no terminal de quem deu o push" },
        },
        required: ["aprovado", "motivo"],
        additionalProperties: false,
      },
      executar: (args) => {
        const aprovado = Boolean(args.aprovado);
        const motivo = typeof args.motivo === "string" ? args.motivo.trim() : "";
        if (!motivo) return { ok: false, texto: 'faltou "motivo"' };
        registrarVeredito(runId, aprovado, motivo);
        return { ok: true, texto: `veredito registrado: ${aprovado ? "aprovado" : "reprovado"}` };
      },
    },
  ];
}

/** Só pra teste: o veredito é estado de módulo e vaza entre casos. */
export function resetVereditoForTest(): void {
  vereditos.clear();
}
