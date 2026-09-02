import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, type NexoConfig } from "@nexo/shared";
import { configPath, ensureHome } from "./home.ts";

export function loadConfig(home: string): NexoConfig {
  ensureHome(home);
  const path = configPath(home);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    return { ...DEFAULT_CONFIG, pack: { ...DEFAULT_CONFIG.pack } };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<NexoConfig>;
  return {
    port: raw.port ?? DEFAULT_CONFIG.port,
    fallbackOrder: raw.fallbackOrder ?? [],
    pack: {
      keepLastMessages: raw.pack?.keepLastMessages ?? DEFAULT_CONFIG.pack.keepLastMessages,
      prefixCharBudget: raw.pack?.prefixCharBudget ?? DEFAULT_CONFIG.pack.prefixCharBudget,
    },
  };
}

export function saveConfig(home: string, patch: Partial<NexoConfig>): NexoConfig {
  const current = loadConfig(home);
  const next: NexoConfig = {
    port: patch.port ?? current.port,
    fallbackOrder: patch.fallbackOrder ?? current.fallbackOrder,
    pack: { ...current.pack, ...patch.pack },
  };
  writeFileSync(configPath(home), JSON.stringify(next, null, 2), "utf8");
  return next;
}
