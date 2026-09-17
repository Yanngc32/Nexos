/**
 * Reproduz um caso real que falhou: conversa tocada pelo `explorador` (que roda
 * em modo plano e não edita), diagnóstico pronto, e a pessoa pede pra aplicar a
 * correção. O roteamento deveria trocar pro `implementador` e não trocou.
 *
 * Experimento isolado: não é chamado por produção.
 */
import { decidirRoteamento } from "../src/typesafe.ts";
import { nexoHome } from "../src/home.ts";

const HISTORICO = [
  { quem: "usuario" as const, texto: "O card 'Saldo da carteira' está maior que os outros, quebra o alinhamento do bloco" },
  {
    quem: "agente" as const,
    texto:
      "Causa do tamanho: `.vendedores-kpis` (index.css:7660) usa `align-items: stretch` — o card 'Saldo da carteira' estica pra igualar a altura do bloco ao lado (3 StatCards), que quebra em 2 linhas. Fix: trocar pra `align-items: start`, card fica do tamanho do próprio conteúdo.",
  },
];

const VARIACOES = [
  "Vamos resolver isso ai",
  "Aplica o fix",
  "Faz essa correção então",
  "Beleza, pode aplicar",
  "Troca pra align-items: start no index.css",
];

async function main() {
  const home = nexoHome();
  console.log("agente atual: explorador (modo plano, não edita)\n");
  for (const mensagem of VARIACOES) {
    const d = await decidirRoteamento({ mensagem, historico: HISTORICO, agenteAtual: "explorador" }, home);
    const alvo = !d ? "—" : d.tipo === "agente" ? d.agentId : d.tipo === "time" ? `time:${d.teamId}` : "automatico";
    const troca = d && d.tipo === "agente" && d.agentId !== "explorador" && d.confianca >= 0.7;
    console.log(`"${mensagem}"`);
    console.log(`  → ${alvo} (confiança ${d ? d.confianca.toFixed(2) : "—"}) ${troca ? "TROCA" : "não troca"}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
