#!/usr/bin/env node
import { spawnNexoProcess } from "./resolve-tsx.mjs";

const child = spawnNexoProcess(process.argv.slice(2), { stdio: "inherit" });
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
