import { saveAgent } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { apagarRegra, listarRegras, saveRegra } from "./hooks.ts";
import { getProfile } from "./profiles.ts";

/**
 * Módulo "Grafo automático" (`NexoConfig.modulos.grafoAuto`): liga um agente + duas regras de
 * Nexo Hook que constroem e mantêm o `graphify` sozinhas, sem botão manual — ver a tela "Memória
 * do Projeto" no desktop, que é onde isso é ligado/desligado.
 *
 * Um agente com id FIXO (`AGENT_ID`) e duas regras GLOBAIS reconhecidas por
 * `agentId === AGENT_ID` — não por um id de regra guardado à parte — porque isso deixa o estado
 * inteiro derivável de `agents.json`/`hooks.json` (a mesma fonte de verdade que a UI já lê), em
 * vez de mais um campo de config que pode dessincronizar. Ligar de novo depois de a pessoa apagar
 * uma regra à mão recria só a que falta; nunca duplica.
 */

const AGENT_ID = "grafo";

const AGENT_NAME = "Grafo";

const INSTRUCOES = `Garanta o grafo do graphify (\`graphify-out/\`) atualizado nesta pasta — e SÓ isso, sem
analisar código, sem comentar nada além do resultado do comando:

1. Se \`graphify-out/graph.json\` NÃO existir: rode \`graphify extract .\` (constrói do zero — isso
   chama LLM pra rotular comunidades, é esperado gastar quota aqui).
2. Se JÁ existir: rode \`graphify update .\` (só re-extrai o AST, sem custo de LLM) — mantém
   fresco sem reconstruir do zero.`;

const EVENTOS = ["nexo.projeto-novo", "git.post-commit"] as const;

/** As regras (globais, agentId=grafo) que este módulo já garantiu existirem — não as que a pessoa criou à mão. */
function regrasGerenciadas(home: string) {
  return listarRegras(home).filter((r) => r.agentId === AGENT_ID && r.escopo.tipo === "global");
}

/**
 * Liga (ou reconfere) o módulo: agente + as duas regras. Idempotente — chamar de novo sem nada
 * ter mudado não recria nada. Chamada no boot do daemon (se já estava ligado) e no `PUT
 * /v1/config` que liga o módulo ou troca a conta.
 */
export function sincronizarGrafoAutomatico(home: string): { ok: boolean; motivo?: string } {
  const cfg = loadConfig(home);
  const { grafoAuto, grafoAutoProfileId } = cfg.modulos;
  if (!grafoAuto) return { ok: true };
  if (!grafoAutoProfileId || !getProfile(grafoAutoProfileId, home)) {
    return { ok: false, motivo: `conta configurada não existe: ${grafoAutoProfileId || "(nenhuma)"}` };
  }
  saveAgent({ id: AGENT_ID, name: AGENT_NAME, profileId: grafoAutoProfileId, instructions: INSTRUCOES }, home);
  const existentes = regrasGerenciadas(home);
  for (const evento of EVENTOS) {
    if (!existentes.some((r) => r.evento === evento)) {
      saveRegra({ nome: "Grafo automático", escopo: { tipo: "global" }, evento, agentId: AGENT_ID }, home);
    }
  }
  return { ok: true };
}

/** Desliga: apaga só as duas regras gerenciadas. O agente `grafo` fica — apagar definição não é ação automática (ver autoria.ts). */
export function desligarGrafoAutomatico(home: string): void {
  for (const r of regrasGerenciadas(home)) {
    if ((EVENTOS as readonly string[]).includes(r.evento)) apagarRegra(r.id, home);
  }
}
