/**
 * Replay da escolha de MODELO de uma mensagem real, montando o mesmo `state`
 * que o daemon montaria. Serve pra saber se o fallback veio de falha ou só de
 * confiança abaixo do piso — e quanto foi essa confiança.
 *
 * Uso: npx tsx apps/daemon/scripts/typesafe-replay-modelo.ts <threadId>
 */
import { readThread } from "../src/threads.ts";
import { escolherModelo } from "../src/typesafe.ts";
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
  const [threadId] = process.argv.slice(2);
  const home = nexoHome();
  const todos = readThread(threadId, home);
  const idx = todos.map((e, i) => (e.type === "user" ? i : -1)).filter((i) => i >= 0).pop();
  const ev = todos[idx!];
  if (!ev || ev.type !== "user") throw new Error("sem mensagem de usuário");

  const antes = todos.slice(0, idx!);
  console.log(`mensagem: "${ev.text.slice(0, 90)}"`);
  const r = await escolherModelo({ mensagem: ev.text, historico: historico(antes) }, home, "claude");
  if (!r) {
    console.log("→ SEM ESCOLHA (falha de verdade: sem key, sem candidatos ou erro)");
    return;
  }
  console.log(`→ ${r.model} (confiança ${r.confianca.toFixed(2)}) — piso é 0.60`);
  console.log("  probabilidades:", r.probabilidades);
  console.log(`  ${r.confianca >= 0.6 ? "USA a escolha" : "cai no fallback (sonnet)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
