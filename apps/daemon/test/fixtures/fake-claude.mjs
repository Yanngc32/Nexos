#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const resumeIdx = process.argv.indexOf("--resume");
const sessionArg = resumeIdx >= 0 ? process.argv[resumeIdx + 1] : "";
if (sessionArg === "dead-session") {
  process.stderr.write("No conversation found with session ID\n");
  process.exit(1);
}

process.stdout.write(`meta cwd=${process.cwd()} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? ""} CODEX_HOME=${process.env.CODEX_HOME ?? ""}\n`);

const streamInput = process.argv.includes("--input-format");
/** `--input-format stream-json`: cada linha é `{type:"user",message:{content}}`. */
const conteudo = (raw) => {
  if (!streamInput) return raw;
  try {
    return JSON.parse(raw).message.content;
  } catch {
    return raw;
  }
};

let esperando = false;
let emBackground = false;
const rl = createInterface({ input: process.stdin });
rl.on("close", () => {
  // como o CLI real: stdin fechado com tarefa em background de pé mata a tarefa
  if (emBackground) {
    process.stdout.write("tarefa-morta\n");
    process.exit(0);
  }
  // stdin fechado sem a segunda mensagem: o turno "ESPERA" acaba mesmo assim
  if (esperando) {
    process.stdout.write("sem-injetada\n");
    process.exit(0);
  }
});
rl.on("line", (raw) => {
  const line = conteudo(raw);
  // turno que só termina quando a segunda mensagem chega pelo stdin (testa `inject`)
  if (esperando) {
    esperando = false;
    process.stdout.write(`injetada:${line}\n`);
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fim" })}\n`);
    return;
  }
  // `result` com tarefa em background de pé; ela termina depois e o "modelo" retoma sozinho
  if (line === "BACKGROUND") {
    const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
    emBackground = true;
    out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1" }] });
    out({ type: "result", subtype: "success", is_error: false, result: "armado" });
    setTimeout(() => {
      emBackground = false;
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      process.stdout.write("tarefa-terminou\n");
      out({ type: "result", subtype: "success", is_error: false, result: "fim" });
    }, 400);
    return;
  }
  // neto destacado herda o stdout e segura o pipe depois que este processo sai (`Start-Process`)
  if (line === "NETO") {
    const neto = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit", detached: true });
    neto.unref();
    process.stdout.write("neto-solto\n");
    process.exit(0);
  }
  if (line === "ESPERA") {
    esperando = true;
    process.stdout.write("esperando\n");
    return;
  }
  if (/auth/i.test(line)) {
    process.stderr.write("Failed to authenticate: OAuth session expired and could not be refreshed\n");
    process.exit(1);
  }
  if (/quota/i.test(line)) {
    process.stderr.write("rate_limit exceeded\n");
    process.exit(0);
  }
  process.stdout.write(`echo:${line}\n`);
  process.exit(0);
});
