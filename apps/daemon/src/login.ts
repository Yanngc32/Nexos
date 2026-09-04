import { mkdirSync } from "node:fs";
import { applyLoginResult, engineEnv, engineSpawnEnv, getProfile, importGlobalCredentials } from "./profiles.ts";
import { spawnBin } from "./spawn-bin.ts";

export async function loginProfile(
  id: string,
  home: string,
  opts?: { bin?: string; fromGlobal?: boolean },
): Promise<void> {
  const p = getProfile(id, home);
  if (!p) throw new Error("perfil não existe");
  if (opts?.fromGlobal) {
    importGlobalCredentials(id, home);
    return;
  }
  if (p.engine === "stub" || p.engine === "api") {
    applyLoginResult(id, home);
    return;
  }
  if (p.engine !== "claude" && p.engine !== "codex") {
    throw new Error(`login de ${p.engine} não suportado`);
  }

  const extra = engineEnv(p, home);
  const dir = extra.CLAUDE_CONFIG_DIR ?? extra.CODEX_HOME;
  if (dir) mkdirSync(dir, { recursive: true });

  const bin =
    opts?.bin ??
    (p.engine === "claude" ? (process.env.NEXO_CLAUDE_BIN ?? "claude") : (process.env.NEXO_CODEX_BIN ?? "codex"));
  // `claude auth login` é o comando real; "/login" só existe dentro da sessão interativa.
  const args = p.engine === "claude" ? ["auth", "login", "--claudeai"] : ["login"];

  await new Promise<void>((resolve, reject) => {
    const child = spawnBin(bin, args, {
      env: engineSpawnEnv(p, home),
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        let after = applyLoginResult(id, home);
        if (after.status !== "ready" && after.engine === "claude") {
          try {
            after = importGlobalCredentials(id, home);
          } catch {
            /* Outlook/OAuth costuma gravar em ~/.claude, não na pasta isolada */
          }
        }
        if (after.status !== "ready") {
          reject(new Error("login não gravou credencial"));
          return;
        }
        resolve();
        return;
      }
      reject(new Error(`login falhou (exit ${code})`));
    });
  });
}
