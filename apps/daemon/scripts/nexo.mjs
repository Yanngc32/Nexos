#!/usr/bin/env node
import { spawnNexoProcess } from "./resolve-tsx.mjs";

// O motor roda com cwd na pasta do daemon (é de lá que o tsx acha o tsconfig), então a pasta de
// quem chamou vai por variável — sem isso `nexos hook fire` do post-commit gravava a conversa com
// o projeto `apps/daemon` em vez do repo do commit.
const child = spawnNexoProcess(process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, NEXO_CWD: process.cwd() },
});
child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
