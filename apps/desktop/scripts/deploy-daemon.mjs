#!/usr/bin/env node
// Empacota o daemon em `daemon-dist`, pronto pra virar `extraResources` do electron-builder.
//
// `--config.node-linker=hoisted`: sem isto, o pnpm monta o node_modules com NTFS junctions
// (Windows) apontando pra `.pnpm/<pacote>/node_modules/<pacote>` — o electron-builder descarta
// essa árvore inteira em silêncio ao copiar pra `extraResources` (sem erro nenhum), e o app
// empacotado sobe sem `tsx`/`esbuild`: o motor nunca liga. `hoisted` gera um node_modules
// PLANO, sem junction nenhuma.
//
// A criação dos shims em `node_modules/.bin` é flaky nesse modo no Windows (ENOENT/EPERM
// esporádico do próprio pnpm ao gravar `.ps1`/`.cmd`) — vira WARN, às vezes vira erro fatal.
// Não usamos NENHUM `.bin` (o daemon chama `tsx/dist/cli.mjs` pelo caminho do arquivo, nunca
// pelo shim), então o critério de sucesso aqui é o conteúdo de verdade existir, não o exit
// code do pnpm.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktopDir = join(here, "..");
const daemonDistDir = join(desktopDir, "daemon-dist");

/** Presença disto = deploy utilizável, independente do que o pnpm achou do resto. */
const MARCADORES = [
  join(daemonDistDir, "package.json"),
  join(daemonDistDir, "node_modules", "tsx", "dist", "cli.mjs"),
  join(daemonDistDir, "node_modules", "@nexos", "shared"),
];

function tentativa() {
  try {
    execFileSync(
      "pnpm",
      ["--config.node-linker=hoisted", "--filter", "@nexos/daemon", "deploy", "--prod", "./daemon-dist"],
      { cwd: desktopDir, stdio: "inherit", shell: process.platform === "win32" },
    );
    return true;
  } catch {
    // Segue pra checagem dos marcadores — a falha pode ser só o shim de .bin (ver acima).
    return false;
  }
}

function completo() {
  return MARCADORES.every((m) => existsSync(m));
}

const MAX_TENTATIVAS = 3;
for (let i = 1; i <= MAX_TENTATIVAS; i++) {
  console.log(`[deploy-daemon] tentativa ${i}/${MAX_TENTATIVAS}`);
  // `pnpm deploy` recusa escrever num diretório não-vazio — precisa estar limpo antes
  // de cada tentativa nova (a anterior pode ter deixado um deploy incompleto pra trás).
  if (existsSync(daemonDistDir)) rmSync(daemonDistDir, { recursive: true, force: true });
  tentativa();
  if (completo()) {
    console.log("[deploy-daemon] ok — marcadores presentes.");
    process.exit(0);
  }
  console.error(`[deploy-daemon] deploy incompleto na tentativa ${i} — faltou algum dos marcadores.`);
}

console.error("[deploy-daemon] falhou depois de todas as tentativas. Marcadores ausentes:");
for (const m of MARCADORES) if (!existsSync(m)) console.error("  -", m);
process.exit(1);
