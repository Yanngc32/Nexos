#!/usr/bin/env node
import { createInterface } from "node:readline";

process.stdout.write(`meta cwd=${process.cwd()} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? ""} CODEX_HOME=${process.env.CODEX_HOME ?? ""}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
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
