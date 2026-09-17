/**
 * Compara a decisão de roteamento COM e SEM o histórico da conversa, pra medir
 * se o contexto resolve o caso que motivou o roteamento por prompt: mensagem
 * curta de meio de conversa ("não funcionou", "agora implementa"), que sozinha
 * não tem sinal nenhum.
 *
 * Experimento isolado, como os outros typesafe-*.ts: não é chamado por produção.
 *
 * Uso: TYPESAFE_API_KEY=... npx tsx apps/daemon/scripts/typesafe-contexto-experiment.ts
 */
import { decidirRoteamento, type FalaDoHistorico } from "../src/typesafe.ts";
import { nexoHome } from "../src/home.ts";

const HISTORICO: FalaDoHistorico[] = [
  { quem: "usuario", texto: "Mapeia como funciona hoje o fluxo de arrastar cartão entre colunas do quadro de tarefas" },
  { quem: "agente", texto: "O arquivo é tarefas-board.js. O cartão já é draggable e a coluna ouve dragover/drop chamando moverTarefa." },
];

const CASOS: { titulo: string; mensagem: string; agenteAtual?: string }[] = [
  { titulo: "curta e vaga, sem contexto", mensagem: "não funcionou" },
  { titulo: "curta e vaga, COM contexto (mapeamento em curso)", mensagem: "não funcionou", agenteAtual: "explorador" },
  { titulo: "pede mudança de fase, sem contexto", mensagem: "agora implementa a correção" },
  { titulo: "pede mudança de fase, COM contexto", mensagem: "agora implementa a correção", agenteAtual: "explorador" },
  { titulo: "pede revisão no fim, COM contexto", mensagem: "revisa o diff antes de eu subir", agenteAtual: "implementador" },
];

async function main() {
  const home = nexoHome();
  for (const caso of CASOS) {
    const comContexto = caso.titulo.includes("COM contexto");
    const d = await decidirRoteamento(
      {
        mensagem: caso.mensagem,
        ...(comContexto ? { historico: HISTORICO } : {}),
        ...(caso.agenteAtual ? { agenteAtual: caso.agenteAtual } : {}),
      },
      home,
    );
    const alvo = !d ? "—" : d.tipo === "agente" ? d.agentId : d.tipo === "time" ? `time:${d.teamId}` : "automatico";
    console.log(`\n${caso.titulo}`);
    console.log(`  mensagem: "${caso.mensagem}"${caso.agenteAtual ? ` | atual: ${caso.agenteAtual}` : ""}`);
    console.log(`  → ${alvo}${d ? ` (confiança ${d.confianca.toFixed(2)})` : " (sem decisão)"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
