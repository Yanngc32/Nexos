/**
 * Dump do payload EXATO que `escolherExecucao` (typesafe.ts) manda pro typesafe.ai
 * na escolha de modelo/esforço — pra uma thread real, sem gastar nenhuma chamada
 * de API. Reaproveita as mesmas funções/constantes que a produção usa
 * (`historicoPraRoteamento`, `modelosCandidatos`, `esforcosCandidatos`,
 * `DESCRICAO_MODELO`, `DESCRICAO_ESFORCO`, `INSTRUCAO_MODELO`, `INSTRUCAO_ESFORCO`),
 * então o dump nunca diverge da lógica real por estar duplicado.
 *
 * Uso:
 *   npx tsx apps/daemon/scripts/typesafe-dump-contexto.ts                  # lista threads recentes
 *   npx tsx apps/daemon/scripts/typesafe-dump-contexto.ts <threadId>       # dump da thread
 *   npx tsx apps/daemon/scripts/typesafe-dump-contexto.ts <threadId> > out.json
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { readThread, threadHead, activeAgentId } from "../src/threads.ts";
import { getProfile } from "../src/profiles.ts";
import { agentOverrides } from "../src/agents.ts";
import { nexoHome, threadPath } from "../src/home.ts";
import {
  historicoPraRoteamento,
} from "../src/session.ts";
import {
  modelosCandidatos,
  esforcosCandidatos,
  DESCRICAO_MODELO,
  DESCRICAO_ESFORCO,
  INSTRUCAO_MODELO,
  INSTRUCAO_ESFORCO,
} from "../src/typesafe.ts";
import { MODELO_AUTO, ESFORCO_AUTO } from "@nexo/shared";

function listarThreadsRecentes(home: string, limite = 20) {
  const dir = dirname(threadPath("placeholder", home));
  if (!existsSync(dir)) return [];
  const heads = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => threadHead(f.slice(0, -".jsonl".length), home))
    .filter((h): h is NonNullable<typeof h> => Boolean(h));
  heads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return heads.slice(0, limite);
}

async function main() {
  const [threadId] = process.argv.slice(2);
  const home = nexoHome();

  if (!threadId) {
    const recentes = listarThreadsRecentes(home);
    if (recentes.length === 0) {
      console.error("Nenhuma thread encontrada em", home);
      process.exit(1);
    }
    console.error("Threads recentes (use o id como argumento):\n");
    for (const t of recentes) {
      console.error(`${t.id}  [${t.profileId}${t.agentId ? `/${t.agentId}` : ""}]  ${t.preview}`);
    }
    return;
  }

  const eventos = readThread(threadId, home);
  const agenteAtual = activeAgentId(eventos);
  const perfil = getProfile(
    eventos.find((e): e is Extract<typeof e, { type: "thread_meta" }> => e.type === "thread_meta")?.profileId ?? "",
    home,
  );
  if (!perfil) {
    console.error("Perfil da thread não encontrado — não dá pra saber o engine/modelo/esforço configurados.");
    process.exit(1);
  }

  const doAgente = agentOverrides(agenteAtual, home);
  const modeloQueValeria = doAgente.model ?? perfil.model;
  const esforcoQueValeria = doAgente.effort ?? perfil.effort;
  const querModelo = modeloQueValeria === MODELO_AUTO;
  const querEsforco = esforcoQueValeria === ESFORCO_AUTO;

  const ultimaMensagemUsuario = [...eventos].reverse().find((e) => e.type === "user");
  const mensagem = ultimaMensagemUsuario && ultimaMensagemUsuario.type === "user" ? ultimaMensagemUsuario.text : "";

  const historico = historicoPraRoteamento(eventos);
  const state = { conversa: historico, mensagem_nova: mensagem };

  const modelos = querModelo ? modelosCandidatos(home, perfil.engine) : [];
  const esforcos = querEsforco ? esforcosCandidatos(perfil.engine) : [];

  const questions: Record<string, unknown> = {};
  if (modelos.length >= 2) {
    const criterios: Record<string, string | null> = {};
    for (const m of modelos) criterios[m] = DESCRICAO_MODELO[m] ?? null;
    questions.which_model = { instrucao: INSTRUCAO_MODELO, criterios };
  }
  if (esforcos.length >= 2) {
    questions.which_effort = {
      instrucao: INSTRUCAO_ESFORCO,
      criterios_em_ordem: esforcos.map((e) => `${e}: ${DESCRICAO_ESFORCO[e] ?? e}`),
    };
  }

  console.log(
    JSON.stringify(
      {
        threadId,
        perfil: perfil.id,
        engine: perfil.engine,
        agenteAtual: agenteAtual ?? null,
        modeloConfigurado: modeloQueValeria ?? null,
        esforcoConfigurado: esforcoQueValeria ?? null,
        querModelo,
        querEsforco,
        state,
        questions,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
