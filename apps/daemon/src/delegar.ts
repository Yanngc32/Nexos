import { existsSync, readFileSync } from "node:fs";
import type { DelegacaoModo, Run } from "@nexo/shared";
import type { Conjunto } from "./mcp.ts";
import { getAgent, listAgents } from "./agents.ts";
import { getTeam, listTeams, upsertTimeDeMencao } from "./teams.ts";
import { criarRun, executarRun } from "./runs.ts";
import { perguntar } from "./perguntas.ts";
import { activeProfileId, readThread } from "./threads.ts";
import { getProfile } from "./profiles.ts";
import { sessionBus } from "./bus.ts";

/**
 * `nexo_delegar`: generaliza o `nexo_chamar` do supervisor (mcp.ts) pra conversa NORMAL — chama um
 * agente/time JÁ EXISTENTE e ESPERA o resultado. Ver design em
 * `docs/superpowers/specs/2026-09-09-delegacao-e-pergunta-design.md`.
 *
 * Sem recursão por construção, não por flag: só existe em conversa normal (`!meta.runId` em
 * `mcpDaConversa`/session.ts, e mesma checagem em http.ts pra esta ferramenta). O que
 * `nexo_delegar` dispara é sempre um passo de RUN (`criarRun`+`executarRun`), que nasce com
 * `runId` — e conversa com `runId` nunca ganha `nexo_delegar` de volta. A cadeia morre sozinha.
 */

/** Nomes das ferramentas como o CLI as enxerga — é isso que entra no --allowed-tools. */
export const MCP_TOOLS_DELEGAR = ["mcp__nexo__nexo_delegar"];

const DELEGACOES_POR_TURNO = 3;

/** Quantas vezes esta thread já chamou `nexo_delegar` NESTE turno. Reseta a cada mensagem nova. */
const contagemPorThread = new Map<string, number>();

/** Chamado por `session.ts` ao abrir um turno novo — sem isso o teto nunca voltaria a zero. */
export function resetContadorDeDelegacao(threadId: string): void {
  contagemPorThread.delete(threadId);
}

/** Só pra teste: o estado é de módulo e vaza entre casos. */
export function resetDelegarForTest(): void {
  contagemPorThread.clear();
}

/** O modo de delegação da conta que está tocando esta conversa agora. `"negado"` se não der pra saber. */
export function modoDeDelegacaoDaThread(threadId: string, home: string): DelegacaoModo {
  try {
    const events = readThread(threadId, home);
    const profileId = activeProfileId(events);
    return getProfile(profileId, home)?.delegacaoModo ?? "negado";
  } catch {
    return "negado";
  }
}

/** Texto que o passo final produziu, lido do artefato gravado por `runs.ts`. */
function saidaDoRun(run: Run): { ok: boolean; texto: string } {
  const passo = [...run.steps].reverse().find((s) => s.status === "done" && s.artifact);
  if (!passo?.artifact || !existsSync(passo.artifact)) {
    return { ok: false, texto: `delegação terminou (${run.status}) sem saída — ${run.error ?? "sem detalhe"}` };
  }
  return { ok: true, texto: readFileSync(passo.artifact, "utf8") };
}

/**
 * Ferramenta MCP `nexo_delegar`, presa a ESTE thread (teto de chamadas) e a ESTE projeto (onde o
 * run roda). Só deve entrar no `Conjunto` quando `modo !== "negado"` — quem decide isso é quem
 * monta o conjunto (http.ts), não esta função.
 */
export function ferramentaDeDelegar(threadId: string, projectPath: string, modo: DelegacaoModo, home: string): Conjunto {
  return () => {
    const agentes = listAgents(home);
    const times = listTeams(home);
    return [
      {
        name: "nexo_delegar",
        description:
          "Delega uma tarefa pra um agente ou time JÁ EXISTENTE e ESPERA o resultado antes de você " +
          "continuar — use em vez de fazer o trabalho você mesmo quando um agente/time já " +
          "configurado está mais preparado pra isso (ferramentas, instruções ou conta próprias). " +
          "Não cria agente nem time — só aponta pra um que já existe (veja `nexo_contexto`). " +
          "Rodar custa quota de verdade: no máximo 3 chamadas por turno.",
        inputSchema: {
          type: "object",
          properties: {
            agentId: {
              type: "string",
              description: "id do agente a chamar",
              ...(agentes.length ? { enum: agentes.map((a) => a.id) } : {}),
            },
            teamId: {
              type: "string",
              description: "id do time a chamar",
              ...(times.length ? { enum: times.map((t) => t.id) } : {}),
            },
            pedido: { type: "string", description: "o que ele deve fazer, com o contexto necessário" },
          },
          required: ["pedido"],
          additionalProperties: false,
        },
        executar: async (args) => {
          const agentId = typeof args.agentId === "string" ? args.agentId.trim() : "";
          const teamId = typeof args.teamId === "string" ? args.teamId.trim() : "";
          const pedido = typeof args.pedido === "string" ? args.pedido.trim() : "";
          if (!pedido) return { ok: false, texto: 'faltou "pedido"' };
          if (!agentId && !teamId) return { ok: false, texto: 'informe "agentId" ou "teamId"' };
          if (agentId && teamId) return { ok: false, texto: 'só um de "agentId"/"teamId", não os dois' };

          let resolvedTeamId: string;
          let alvoNome: string;
          if (teamId) {
            const time = getTeam(teamId, home);
            if (!time) return { ok: false, texto: `time não existe: ${teamId}` };
            resolvedTeamId = teamId;
            alvoNome = time.name;
          } else {
            const agente = getAgent(agentId, home);
            if (!agente) return { ok: false, texto: `agente não existe: ${agentId}` };
            resolvedTeamId = upsertTimeDeMencao(agentId, home).id;
            alvoNome = agente.name;
          }

          const n = contagemPorThread.get(threadId) ?? 0;
          if (n >= DELEGACOES_POR_TURNO) {
            return { ok: false, texto: `teto de ${DELEGACOES_POR_TURNO} delegações por turno já atingido nesta conversa` };
          }

          if (modo === "questionar") {
            const r = await perguntar(
              threadId,
              home,
              `Delegar pra "${alvoNome}": ${pedido}\n\nPode rodar? (responda "sim" pra confirmar)`,
              ["sim", "não"],
            );
            if (!r.ok || r.texto.trim().toLowerCase() !== "sim") {
              return { ok: false, texto: "delegação cancelada — resposta não foi \"sim\"" };
            }
          }

          contagemPorThread.set(threadId, n + 1);
          const run = criarRun({ teamId: resolvedTeamId, projectPath, goal: pedido }, home);
          // Pra tela abrir o subchat ao vivo (GET /v1/runs/:id/events) antes de o run terminar —
          // sem esperar o `tool_result`, que só chega no fim.
          const delegacaoEv = { type: "delegacao_run" as const, threadId, runId: run.id };
          sessionBus.emit(threadId, delegacaoEv);
          sessionBus.emit("*", delegacaoEv);
          const feito = await executarRun(run, home);
          if (feito.status !== "done") {
            return { ok: false, texto: `delegação falhou (${feito.status}): ${feito.error ?? "sem detalhe"}` };
          }
          return saidaDoRun(feito);
        },
      },
    ];
  };
}
