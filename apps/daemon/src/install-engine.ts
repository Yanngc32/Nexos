import type { EngineKind } from "@nexos/shared";
import { spawn } from "node:child_process";
import { spawnBin } from "./spawn-bin.ts";

/** Pacote npm por motor — só os dois que `addProfile` verifica com `which()` têm instalação automática. */
export const ENGINE_NPM_PACKAGE: Partial<Record<EngineKind, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

export type InstallResult = { ok: boolean; log: string };

/**
 * Comando de instalar/atualizar. Claude JÁ instalado usa o atualizador dele (`claude update`):
 * a instalação nativa (`~/.local/bin/claude.exe`, a que vem antes no PATH) não é do npm, e o
 * `npm install -g` atualizava outra cópia (ou falhava) enquanto o motor seguia na versão velha.
 * O `claude update` resolve sozinho tanto a instalação nativa quanto a do npm.
 */
export function comandoDeInstalacao(engine: EngineKind, jaInstalado: boolean): { bin: string; args: string[] } | null {
  const pacote = ENGINE_NPM_PACKAGE[engine];
  if (!pacote) return null;
  if (engine === "claude" && jaInstalado) return { bin: "claude", args: ["update"] };
  return { bin: "npm", args: ["install", "-g", `${pacote}@latest`] };
}

/** `where`/`which` assíncrono: clique na tela não pode parar o motor. */
function estaNoPath(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Roda o comando de `comandoDeInstalacao`, capturando a saída pra mostrar se falhar.
 *
 * Usa `spawnBin` (não `spawn` direto) porque `npm`/`claude` no Windows podem ser shim `.cmd`
 * do Node — o mesmo motivo que quebrava o motor `codex` com `exit 1` (ver spawn-bin.ts).
 */
export async function installEngine(engine: EngineKind): Promise<InstallResult> {
  if (!ENGINE_NPM_PACKAGE[engine]) return { ok: false, log: `sem instalação automática pro motor ${engine}` };
  const cmd = comandoDeInstalacao(engine, engine === "claude" && (await estaNoPath("claude")));
  if (!cmd) return { ok: false, log: `sem instalação automática pro motor ${engine}` };
  return new Promise((resolve) => {
    let log = "";
    let child: ReturnType<typeof spawnBin>;
    try {
      child = spawnBin(cmd.bin, cmd.args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, log: (e as Error).message });
      return;
    }
    child.stdout?.on("data", (b: Buffer) => (log += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (log += b.toString("utf8")));
    child.on("error", (e) => resolve({ ok: false, log: log + e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, log }));
  });
}
