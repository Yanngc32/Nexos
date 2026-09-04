#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || "";
if (!dir) {
  process.stderr.write("missing isolated config dir\n");
  process.exit(2);
}
writeFileSync(join(dir, "logged-in"), `${process.argv.slice(2).join(" ")}\n`);
process.exit(0);
