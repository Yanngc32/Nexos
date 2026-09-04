import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, SWITCH_MODES, type NexoConfig, type SwitchMode } from "@nexo/shared";
import { configPath, ensureHome } from "./home.ts";

export function loadConfig(home: string): NexoConfig {
  ensureHome(home);
  const path = configPath(home);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    return { ...DEFAULT_CONFIG, pack: { ...DEFAULT_CONFIG.pack }, accent: DEFAULT_CONFIG.accent };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<NexoConfig>;
  return {
    port: raw.port ?? DEFAULT_CONFIG.port,
    fallbackOrder: raw.fallbackOrder ?? [],
    switchMode: isSwitchMode(raw.switchMode) ? raw.switchMode : DEFAULT_CONFIG.switchMode,
    pack: {
      keepLastMessages: raw.pack?.keepLastMessages ?? DEFAULT_CONFIG.pack.keepLastMessages,
      prefixCharBudget: raw.pack?.prefixCharBudget ?? DEFAULT_CONFIG.pack.prefixCharBudget,
    },
    accent: isHex(raw.accent) ? raw.accent : DEFAULT_CONFIG.accent,
    repos: cleanRepos(raw.repos),
    hiddenRepos: cleanRepos(raw.hiddenRepos),
    lastProject: str(raw.lastProject),
    lastThread: str(raw.lastThread),
    trustedProjects: cleanRepos(raw.trustedProjects),
  };
}

function isSwitchMode(value: unknown): value is SwitchMode {
  return typeof value === "string" && (SWITCH_MODES as string[]).includes(value);
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Lista de pastas: sem vazio, sem repetido, teto pra não crescer sem fim. */
function cleanRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!path) continue;
    const chave = path.replace(/[\u005c]/g, "/").replace(/\/+$/, "").toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(path);
    if (out.length >= 50) break;
  }
  return out;
}

export function saveConfig(home: string, patch: Partial<NexoConfig>): NexoConfig {
  const current = loadConfig(home);
  const next: NexoConfig = {
    port: patch.port ?? current.port,
    fallbackOrder: patch.fallbackOrder ?? current.fallbackOrder,
    switchMode: isSwitchMode(patch.switchMode) ? patch.switchMode : current.switchMode,
    pack: { ...current.pack, ...patch.pack },
    accent: isHex(patch.accent) ? patch.accent : current.accent,
    repos: patch.repos === undefined ? current.repos : cleanRepos(patch.repos),
    hiddenRepos: patch.hiddenRepos === undefined ? current.hiddenRepos : cleanRepos(patch.hiddenRepos),
    lastProject: patch.lastProject === undefined ? current.lastProject : str(patch.lastProject),
    lastThread: patch.lastThread === undefined ? current.lastThread : str(patch.lastThread),
    trustedProjects:
      patch.trustedProjects === undefined ? current.trustedProjects : cleanRepos(patch.trustedProjects),
  };
  writeFileSync(configPath(home), JSON.stringify(next, null, 2), "utf8");
  return next;
}
