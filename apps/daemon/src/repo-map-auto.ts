import { saveAgent } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { apagarRegra, listarRegras, saveRegra } from "./hooks.ts";
import { getProfile } from "./profiles.ts";
import { criarRun, executarRun } from "./runs.ts";
import { upsertTimeDeHook } from "./teams.ts";
import { arquivosParaResumir } from "./repo-map-enriquecimento.ts";

/**
 * Módulo "Resumos por IA" (`NexoConfig.modulos.repoMapResumos`) — substitui `grafo-auto.ts`.
 *
 * Só o ENRIQUECIMENTO (resumo de 1 linha por arquivo) passa pelo mecanismo de agente + Nexo
 * Hooks: a Camada 1 (índice) não precisa de LLM nenhum, então é recalculada por chamada direta de
 * função nos pontos onde os eventos já nascem (`POST /v1/threads`, `POST /v1/hooks/fire` — ver
 * `http.ts`), sem regra nem agente. Toda `RegraHook` exige `agentId`/`teamId` e sempre sobe um run
 * de verdade (LLM) — incompatível com "sem custo" da Camada 1, por isso ela fica de fora disto.
 *
 * Mesmo padrão de `grafo-auto.ts`: agente com id FIXO e regra GLOBAL reconhecida por
 * `agentId === AGENT_ID` — estado inteiro derivável de `agents.json`/`hooks.json`. Só 1 evento
 * (`git.post-commit`) — sem `nexo.projeto-novo`, porque não há o que resumir num projeto que
 * ainda não rodou "Gerar resumos" nenhuma vez.
 */

export const AGENT_ID = "repo-map-resumos";

const AGENT_NAME = "Resumos do repo map";

const INSTRUCOES = `Gere um resumo de UMA LINHA por arquivo tocado no último commit (leia \`git diff --name-only
HEAD~1..HEAD\` pra saber quais), chamando \`nexo_repomap_resumo_salvar({ caminho, resumo })\` uma
vez por arquivo — nada de Bash externo, nada além disso. Resumo é sobre PROPÓSITO ("cuida de
autenticação"), não um resumo do diff linha a linha. Pule arquivo que não existe mais (foi
apagado no commit) e binário/gerado (lockfile, imagem, etc.).`;

const EVENTOS = ["git.post-commit"] as const;

/** As regras (globais, agentId=repo-map-resumos) que este módulo já garantiu existirem. */
function regrasGerenciadas(home: string) {
  return listarRegras(home).filter((r) => r.agentId === AGENT_ID && r.escopo.tipo === "global");
}

/**
 * Liga (ou reconfere) o módulo: agente + a regra. Idempotente. Chamada no boot do daemon (se já
 * estava ligado) e no `PUT /v1/config` que liga o módulo ou troca a conta.
 */
export function sincronizarRepoMapResumos(home: string): { ok: boolean; motivo?: string } {
  const cfg = loadConfig(home);
  const { repoMapResumos, repoMapProfileId } = cfg.modulos;
  if (!repoMapResumos) return { ok: true };
  if (!repoMapProfileId || !getProfile(repoMapProfileId, home)) {
    return { ok: false, motivo: `conta configurada não existe: ${repoMapProfileId || "(nenhuma)"}` };
  }
  saveAgent({ id: AGENT_ID, name: AGENT_NAME, profileId: repoMapProfileId, instructions: INSTRUCOES }, home);
  const existentes = regrasGerenciadas(home);
  for (const evento of EVENTOS) {
    if (!existentes.some((r) => r.evento === evento)) {
      saveRegra({ nome: "Resumos do repo map", escopo: { tipo: "global" }, evento, agentId: AGENT_ID }, home);
    }
  }
  return { ok: true };
}

/** Desliga: apaga só a regra gerenciada. O agente fica — apagar definição não é ação automática. */
export function desligarRepoMapResumos(home: string): void {
  for (const r of regrasGerenciadas(home)) {
    if ((EVENTOS as readonly string[]).includes(r.evento)) apagarRegra(r.id, home);
  }
}

/**
 * "Gerar resumos" (botão manual) — funciona mesmo com o módulo desligado (`repoMapResumos:
 * false`): só precisa de `repoMapProfileId` configurado, a mesma conta que a manutenção
 * automática usaria se estivesse ligada. Garante o agente existir (idempotente) mesmo que o
 * módulo nunca tenha sido sincronizado.
 */
export async function gerarResumosSobDemanda(projectPath: string, home: string): Promise<{ ok: boolean; texto: string }> {
  const { repoMapProfileId } = loadConfig(home).modulos;
  if (!repoMapProfileId || !getProfile(repoMapProfileId, home)) {
    return { ok: false, texto: `conta configurada não existe: ${repoMapProfileId || "(nenhuma)"} — configure em Memória do Projeto` };
  }
  const pendentes = arquivosParaResumir(projectPath, home);
  if (!pendentes.length) return { ok: true, texto: "nada pra resumir — todo arquivo já está com resumo em dia" };
  saveAgent({ id: AGENT_ID, name: AGENT_NAME, profileId: repoMapProfileId, instructions: INSTRUCOES }, home);
  const time = upsertTimeDeHook(AGENT_ID, home);
  const goal = `Gere um resumo de 1 linha por arquivo abaixo (chame \`nexo_repomap_resumo_salvar\` pra cada um):\n\n${pendentes
    .map((p) => `- ${p}`)
    .join("\n")}`;
  const run = criarRun({ teamId: time.id, projectPath, goal }, home);
  await executarRun(run, home);
  return { ok: true, texto: `resumo disparado pra ${pendentes.length} arquivo(s)` };
}
