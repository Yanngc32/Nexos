import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { globalSkillsDir } from "./home.ts";

/**
 * Módulos externos opcionais (`NexoConfig.modulos`) — cada um instalado e sincronizado só se
 * ligado. `rtk` é um proxy de CLI (hook `PreToolUse` que filtra saída de comando antes dela entrar
 * no contexto); `caveman` é uma skill de comunicação comprimida, instalada pelo MESMO mecanismo
 * que já copia `~/.nexo/skills` pra dentro do `CLAUDE_CONFIG_DIR` isolado de cada perfil (ver
 * `syncGlobalSkills`, engines/cli.ts, e `skill.ts`, que já faz isto pra "nexo-times").
 */

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 120_000;

async function rodar(bin: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(bin, args, {
      timeout: timeoutMs,
      shell: process.platform === "win32",
      ...(env ? { env } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Garante o binário `rtk` na máquina — best-effort, NUNCA lança. Só tenta `cargo` (se disponível,
 * em qualquer plataforma) e o `install.sh` oficial (fora do Windows, que não tem um). O rtk não
 * publica installer automatizado pra Windows — só zip de release pra extrair à mão — e baixar e
 * extrair esse zip aqui é risco alto sem como validar em CI; o log deixa a URL certa em vez de
 * arriscar deixar a instalação pela metade.
 */
export async function ensureRtkInstalled(): Promise<void> {
  if (await rodar("rtk", ["--version"], 10_000)) return;
  if (await rodar("cargo", ["install", "--git", "https://github.com/rtk-ai/rtk"], INSTALL_TIMEOUT_MS)) {
    console.log("rtk: instalado via cargo");
    return;
  }
  if (process.platform !== "win32") {
    const script = "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh";
    if (await rodar("sh", ["-c", script], INSTALL_TIMEOUT_MS)) {
      console.log("rtk: instalado via install.sh");
      return;
    }
  }
  console.log(
    "rtk: não consegui instalar automaticamente (sem cargo, e Windows não tem installer de script) — " +
      "baixe o zip e extraia rtk.exe pro PATH: https://github.com/rtk-ai/rtk/releases",
  );
}

/** Checagem rápida (um `readFileSync` pequeno) — evita pagar um subprocesso inteiro em toda mensagem. */
function jaTemHookRtk(claudeConfigDir: string): boolean {
  const path = join(claudeConfigDir, "settings.json");
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes("rtk");
  } catch {
    return false;
  }
}

/**
 * Liga o hook `PreToolUse` do rtk no `settings.json` ISOLADO deste perfil. Delega a edição de
 * verdade pro instalador oficial (`rtk init -g`, com `CLAUDE_CONFIG_DIR` apontado pra cá) em vez
 * de reconstruir o JSON do hook aqui — é o próprio rtk quem sabe o formato exato que a versão
 * instalada espera. Chamada a cada turno (ver `syncArgs`, engines/cli.ts), mas `jaTemHookRtk`
 * faz o custo cair pra quase zero depois da primeira vez.
 */
export async function syncRtkHook(claudeConfigDir: string): Promise<void> {
  if (jaTemHookRtk(claudeConfigDir)) return;
  mkdirSync(claudeConfigDir, { recursive: true });
  await rodar("rtk", ["init", "-g"], 15_000, { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir });
}

const CAVEMAN_SKILL_URL = "https://raw.githubusercontent.com/JuliusBrussee/caveman/main/skills/caveman/SKILL.md";

/**
 * Instala a skill `caveman` na pasta global do Nexo (mesmo lugar que `nexo-times`, ver skill.ts)
 * pra `syncGlobalSkills` copiar pra dentro do `CLAUDE_CONFIG_DIR` de cada perfil como qualquer
 * outra skill — nenhum mecanismo novo. Best-effort, nunca lança: rede fora não pode impedir o
 * módulo de ser ligado nem o daemon de subir. Não reinstala se já existe (edição manual do usuário
 * não é sobrescrita sozinha a cada turno).
 */
export async function ensureCavemanInstalled(home: string): Promise<void> {
  const dir = join(globalSkillsDir(home), "caveman");
  const dest = join(dir, "SKILL.md");
  if (existsSync(dest)) return;
  try {
    const resp = await fetch(CAVEMAN_SKILL_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const texto = await resp.text();
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, texto, "utf8");
    console.log("caveman: skill instalada");
  } catch (e) {
    console.log(`caveman: não consegui baixar a skill (${(e as Error).message || String(e)}) — tente de novo mais tarde`);
  }
}
