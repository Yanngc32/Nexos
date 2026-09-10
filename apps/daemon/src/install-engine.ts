import type { EngineKind } from "@nexo/shared";
import { spawnBin } from "./spawn-bin.ts";

/** Pacote npm por motor — só os dois que `addProfile` verifica com `which()` têm instalação automática. */
export const ENGINE_NPM_PACKAGE: Partial<Record<EngineKind, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

export type InstallResult = { ok: boolean; log: string };

/**
 * `npm install -g <pacote>@latest`, capturando a saída pra mostrar se falhar.
 *
 * Usa `spawnBin` (não `spawn` direto) porque `npm` no Windows TAMBÉM é um shim
 * `.cmd` do próprio Node — o mesmo motivo que quebrava o motor `codex` com
 * `exit 1` (ver spawn-bin.ts) vale aqui se algum dia este comando ganhar
 * argumento com metacaractere de cmd.exe. Hoje não tem (nome de pacote fixo),
 * mas está pronto pra continuar seguro se isso mudar.
 */
export function installEngine(engine: EngineKind): Promise<InstallResult> {
  const pacote = ENGINE_NPM_PACKAGE[engine];
  if (!pacote) return Promise.resolve({ ok: false, log: `sem instalação automática pro motor ${engine}` });
  return new Promise((resolve) => {
    let log = "";
    let child: ReturnType<typeof spawnBin>;
    try {
      child = spawnBin("npm", ["install", "-g", `${pacote}@latest`], { stdio: ["ignore", "pipe", "pipe"] });
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
