/**
 * Experimento isolado: usa a Choice do TypeSafe (Jev) pra decidir, dado o texto
 * de uma tarefa, se deve usar um agente já criado pelo usuário ou "automático"
 * (deixar escolher o modelo). Não é chamado por nenhum caminho de produção —
 * roda manualmente pra avaliar se a decisão faz sentido antes de plugar em
 * algum lugar real (thread/http.ts).
 *
 * Uso:
 *   TYPESAFE_API_KEY=... npx tsx apps/daemon/scripts/typesafe-route-experiment.ts "texto da tarefa"
 */
import { pathToFileURL } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { AUTOMATICO, PREFIXO_TIME, montarCandidatos, perguntas } from "../src/typesafe.ts";
import { nexoHome } from "../src/home.ts";

export { AUTOMATICO, PREFIXO_TIME, montarCandidatos, perguntas };

async function main() {
  const argv = process.argv.slice(2);
  const raw = argv.includes("--raw");
  const tarefa = argv.filter((a) => a !== "--raw").join(" ").trim();
  if (!tarefa) {
    console.error('Uso: npx tsx typesafe-route-experiment.ts [--raw] "texto da tarefa"');
    process.exit(1);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY não definida no ambiente.");
    process.exit(1);
  }

  const home = nexoHome();
  const { agentes, times, modelos, criteriosAgente, criteriosModelo } = montarCandidatos(home);

  if (agentes.length === 0) {
    console.error(`Nenhum agente encontrado em ${home}. Crie ao menos um agente antes de testar.`);
    process.exit(1);
  }
  if (modelos.length === 0) {
    console.error(`Nenhum modelo configurado em perfis (${home}/profiles). Configure ao menos uma conta.`);
    process.exit(1);
  }

  const client = new TypeSafeClient();
  const request = { state: tarefa, questions: perguntas(criteriosAgente, criteriosModelo) };

  if (raw) {
    console.log("=== REQUEST (POST https://api.typesafe.ai/v1/systemone) ===");
    console.log(JSON.stringify({ model: client.defaultModel, ...request }, null, 2));
  }

  const result = await client.systemOne(request);
  const { answers, model, usage } = result;

  if (raw) {
    console.log("\n=== RESPONSE ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("\n=== INTERPRETADO ===");
  }

  const escolhaAgente = answers.which_agent;
  const escolhaModelo = answers.which_model;

  const rotulo = escolhaAgente.choice.startsWith(PREFIXO_TIME)
    ? `time '${escolhaAgente.choice.slice(PREFIXO_TIME.length)}'`
    : escolhaAgente.choice === AUTOMATICO
      ? "automático"
      : `agente '${escolhaAgente.choice}'`;

  console.log(`Modelo de roteamento: ${model} (input ${usage.input_tokens} / output ${usage.output_tokens} tokens)`);
  console.log(`Times candidatos: ${times.map((t) => t.id).join(", ") || "(nenhum time real com >1 membro)"}`);
  console.log(`\nEscolha: ${rotulo} (confiança ${escolhaAgente.confidence.toFixed(2)})`);
  console.log("Probabilidades:", escolhaAgente.probabilities);

  if (escolhaAgente.choice === AUTOMATICO) {
    console.log(`\nModo automático → modelo: ${escolhaModelo.choice} (confiança ${escolhaModelo.confidence.toFixed(2)})`);
    console.log("Probabilidades:", escolhaModelo.probabilities);
  } else {
    console.log(`\n(which_model ignorado — agente '${escolhaAgente.choice}' já resolve a tarefa)`);
  }
}

// Só roda como CLI direto; o runner em lote importa as funções acima sem disparar isso.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
