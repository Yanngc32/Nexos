#!/usr/bin/env node
/*
 * `codex exec --json` de mentira.
 *
 * As linhas abaixo são CÓPIA da saída do codex de verdade (codex-cli 0.153.4),
 * dirigido contra um provedor OpenAI-compatível local — inclusive o aviso de
 * "Model metadata not found", que chega como `error` e não derruba o turno. Esse
 * detalhe é o motivo de o fixture existir: se um dia o parser voltar a tratar
 * `error` como fatal, o teste que usa isto quebra.
 */
import { createInterface } from "node:readline";

// o motor tem de invocar `exec --json`; `codex` puro abre a TUI e morre com stdin em pipe
const argv = process.argv.slice(2);
if (argv[0] !== "exec" || !argv.includes("--json")) {
  process.stderr.write("Error: stdin is not a terminal\n");
  process.exit(1);
}
// o que o teste inspeciona pra saber que o token do MCP foi pelo ambiente, não por argv
process.stdout.write(
  JSON.stringify({
    type: "item.completed",
    item: { id: "meta", type: "command_execution", command: `NEXO_MCP_TOKEN=${process.env.NEXO_MCP_TOKEN ?? ""}`, exit_code: 0, status: "completed" },
  }) + "\n",
);

const linhas = (texto) => [
  { type: "thread.started", thread_id: "01a080ab-5677-7af0-8e63-60b7b4f88859" },
  {
    type: "item.completed",
    item: { id: "item_0", type: "error", message: "Model metadata for `fake-1` not found. Defaulting to fallback metadata; this can degrade performance and cause issues." },
  },
  { type: "turn.started" },
  {
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'echo alo'", aggregated_output: "", exit_code: null, status: "in_progress" },
  },
  {
    type: "item.completed",
    item: { id: "item_1", type: "command_execution", command: "/bin/bash -lc 'echo alo'", aggregated_output: "alo\n", exit_code: 0, status: "completed" },
  },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: `echo:${texto}` } },
  {
    type: "turn.completed",
    usage: { input_tokens: 30, cached_input_tokens: 3, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 },
  },
];

const rl = createInterface({ input: process.stdin });
let visto = false;
rl.on("line", (line) => {
  if (visto) return;
  visto = true;
  if (/^FALHA/.test(line)) {
    process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "o modelo recusou" } }) + "\n");
    process.exit(0);
  }
  // o codex escreve log solto que não é JSON; o parser não pode virar isso em texto
  process.stderr.write("Reading prompt from stdin...\n");
  for (const ev of linhas(line.trim())) process.stdout.write(JSON.stringify(ev) + "\n");
  process.exit(0);
});
