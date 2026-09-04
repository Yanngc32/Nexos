#!/usr/bin/env node
// Imita `claude auth login`: imprime a URL, espera o código no stdin.
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? "";
  const logged = dir ? existsSyncSafe(join(dir, ".credentials.json")) : false;
  process.stdout.write(`${JSON.stringify({ loggedIn: logged, authMethod: logged ? "claude.ai" : "none" })}\n`);
  process.exit(0);
}

function existsSyncSafe(p) {
  try {
    return require("node:fs").existsSync(p);
  } catch {
    return false;
  }
}

if (process.env.FAKE_LOGIN_NO_URL === "1") {
  process.stdout.write("nada de url aqui\n");
  process.exit(0);
}

process.stdout.write("Opening browser to sign in…\n");
process.stdout.write(
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=xyz\n",
);
process.stdout.write("Paste code here if prompted > ");

// Imita o callback automático: grava a credencial e fica pendurado no prompt.
if (process.env.FAKE_LOGIN_CALLBACK === "1") {
  setTimeout(() => {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({
          accessToken: "at-live",
          refreshToken: "rt-live",
          expiresAt: Date.now() + 3_600_000,
          refreshTokenExpiresAt: Date.now() + 30 * 24 * 3_600_000,
        }),
        "utf8",
      );
    }
  }, 150);
  setInterval(() => {}, 1000);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const code = line.trim();
  if (code.includes("ruim")) {
    process.stderr.write("invalid code\n");
    process.exit(1);
  }
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        accessToken: "at-live",
        refreshToken: "rt-live",
        expiresAt: Date.now() + 3_600_000,
        refreshTokenExpiresAt: Date.now() + 30 * 24 * 3_600_000,
      }),
      "utf8",
    );
  }
  process.stdout.write("Login successful\n");
  process.exit(0);
});
