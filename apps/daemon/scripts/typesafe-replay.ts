/**
 * Replay: refaz a decisão de roteamento de uma mensagem REAL de uma thread
 * gravada, montando exatamente o mesmo `state` que o daemon montaria (mesmas
 * últimas falas, mesmo corte de caracteres, mesmo agente atual).
 *
 * Serve pra separar "a decisão foi ruim" de "o código não rodou".
 *
 * Uso: npx tsx apps/daemon/scripts/typesafe-replay.ts <threadId> [índice da msg, default = última]
 */
import { readThread, activeAgentId } from "../src/threads.ts";
import { decidirRoteamento } from "../src/typesafe.ts";
import { nexoHome } from "../src/home.ts";
import type { ThreadEvent } from "@nexo/shared";

const FALAS = 6;

function historico(events: ThreadEvent[]) {
  const falas: { quem: "usuario" | "agente"; texto: string }[] = [];
  for (const e of events) {
    if (e.type === "user") falas.push({ quem: "usuario", texto: e.text });
    else if (e.type === "assistant") falas.push({ quem: "agente", texto: e.text });
  }
  return falas.slice(-FALAS).map((f) => ({ ...f, texto: f.texto.slice(0, 600) }));
}

async function main() {
  const [threadId, idxArg] = process.argv.slice(2);
  if (!threadId) {
    console.error("uso: typesafe-replay.ts <threadId> [índice]");
    process.exit(1);
  }
  const home = nexoHome();
  const todos = readThread(threadId, home);
  const indicesUser = todos.map((e, i) => (e.type === "user" ? i : -1)).filter((i) => i >= 0);
  const alvo = idxArg ? Number(idxArg) : indicesUser[indicesUser.length - 1];
  const ev = todos[alvo];
  if (!ev || ev.type !== "user") {
    console.error(`índice ${alvo} não é uma mensagem do usuário`);
    process.exit(1);
  }
  // Estado do daemon NAQUELE instante: só o que existia antes da mensagem.
  const antes = todos.slice(0, alvo);
  const agenteAtual = activeAgentId(antes);
  const hist = historico(antes);

  console.log(`mensagem: "${ev.text.slice(0, 90)}"`);
  console.log(`agente atual naquele ponto: ${agenteAtual ?? "(nenhum)"}`);
  console.log(`falas de contexto: ${hist.length}`);
  const d = await decidirRoteamento({ mensagem: ev.text, historico: hist, agenteAtual }, home);
  if (!d) {
    console.log("→ sem decisão (modo desligado, sem key ou erro)");
    return;
  }
  const alvoNome = d.tipo === "agente" ? d.agentId : d.tipo === "time" ? `time:${d.teamId}` : "automatico";
  console.log(`→ ${alvoNome} (confiança ${d.confianca.toFixed(2)})`);
  const top = Object.entries(d.probabilidades)
    .filter(([, p]) => p > 0.01)
    .sort((a, b) => b[1] - a[1]);
  console.log("  top:", Object.fromEntries(top));
  // Mesma regra do session.ts: sair de agente só-leitura pede menos confiança.
  const { agentOverrides } = await import("../src/agents.ts");
  const soLe = agentOverrides(agenteAtual, home).permissionMode === "plan";
  const limiar = soLe ? 0.4 : 0.7;
  const trocaria = d.tipo !== "automatico" && alvoNome !== agenteAtual && d.confianca >= limiar;
  console.log(`  agente atual só lê? ${soLe ? "sim" : "não"} · limiar ${limiar}`);
  console.log(`  ${trocaria ? "TROCARIA" : "não trocaria"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
