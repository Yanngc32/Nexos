import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CAVEMAN_NIVEIS, DEFAULT_CONFIG, SWITCH_MODES, type CavemanNivel, type NexoConfig, type SwitchMode } from "@nexo/shared";
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
    host: isHost(raw.host) ? raw.host : DEFAULT_CONFIG.host,
    fallbackOrder: raw.fallbackOrder ?? [],
    switchMode: isSwitchMode(raw.switchMode) ? raw.switchMode : DEFAULT_CONFIG.switchMode,
    pack: {
      keepLastMessages: raw.pack?.keepLastMessages ?? DEFAULT_CONFIG.pack.keepLastMessages,
      prefixCharBudget: raw.pack?.prefixCharBudget ?? DEFAULT_CONFIG.pack.prefixCharBudget,
      compactar: raw.pack?.compactar ?? DEFAULT_CONFIG.pack.compactar,
    },
    accent: isHex(raw.accent) ? raw.accent : DEFAULT_CONFIG.accent,
    repos: cleanRepos(raw.repos),
    hiddenRepos: cleanRepos(raw.hiddenRepos),
    lastProject: str(raw.lastProject),
    lastThread: str(raw.lastThread),
    trustedProjects: cleanRepos(raw.trustedProjects),
    memoriaDir: str(raw.memoriaDir),
    graphDir: str(raw.graphDir),
    modulos: cleanModulos(raw.modulos),
  };
}

function isCavemanNivel(value: unknown): value is CavemanNivel {
  return typeof value === "string" && (CAVEMAN_NIVEIS as readonly string[]).includes(value);
}

function cleanModulos(value: unknown): NexoConfig["modulos"] {
  const o = (value ?? {}) as Partial<NexoConfig["modulos"]>;
  return {
    rtk: Boolean(o.rtk),
    caveman: Boolean(o.caveman),
    cavemanNivel: isCavemanNivel(o.cavemanNivel) ? o.cavemanNivel : DEFAULT_CONFIG.modulos.cavemanNivel,
    grafoAuto: Boolean(o.grafoAuto),
    grafoAutoProfileId: str(o.grafoAutoProfileId),
  };
}

function isSwitchMode(value: unknown): value is SwitchMode {
  return typeof value === "string" && (SWITCH_MODES as string[]).includes(value);
}

/**
 * Endereço de bind. Só IP literal ou `localhost`: nome que precisa de DNS
 * mudaria de significado entre redes, e o bind é escolha de segurança — não é
 * lugar pra resolução dinâmica.
 */
function isHost(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "localhost") return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return v.split(".").every((n) => Number(n) <= 255);
  // IPv6 literal, incluindo o loopback `::1` e o `::` (todas as interfaces)
  return /^[0-9a-fA-F:]{2,45}$/.test(v) && v.includes(":");
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
    host: isHost(patch.host) ? patch.host : current.host,
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
    memoriaDir: patch.memoriaDir === undefined ? current.memoriaDir : str(patch.memoriaDir),
    graphDir: patch.graphDir === undefined ? current.graphDir : str(patch.graphDir),
    // Merge campo a campo: `{ modulos: { rtk: true } }` liga só o rtk, sem apagar o resto.
    modulos: {
      rtk: patch.modulos?.rtk === undefined ? current.modulos.rtk : Boolean(patch.modulos.rtk),
      caveman: patch.modulos?.caveman === undefined ? current.modulos.caveman : Boolean(patch.modulos.caveman),
      cavemanNivel: isCavemanNivel(patch.modulos?.cavemanNivel)
        ? patch.modulos.cavemanNivel
        : current.modulos.cavemanNivel,
      grafoAuto: patch.modulos?.grafoAuto === undefined ? current.modulos.grafoAuto : Boolean(patch.modulos.grafoAuto),
      grafoAutoProfileId:
        patch.modulos?.grafoAutoProfileId === undefined
          ? current.modulos.grafoAutoProfileId
          : str(patch.modulos.grafoAutoProfileId),
    },
  };
  writeFileSync(configPath(home), JSON.stringify(next, null, 2), "utf8");
  return next;
}
