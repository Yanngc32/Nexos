import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CAVEMAN_NIVEIS, DEFAULT_CONFIG, SWITCH_MODES, type CavemanNivel, type NexoConfig, type SwitchMode } from "@nexo/shared";
import { configPath, ensureHome } from "./home.ts";

/**
 * `writeFileSync` direto no arquivo final deixa uma janela: processo morto (crash, kill, o
 * usuário fechando o daemon pela bandeja) bem no meio da escrita trunca `config.json` — e como
 * TODA rota chama `loadConfig`, um config truncado derrubava o daemon de novo a cada tentativa
 * de subir, sem forma de se recuperar sozinho. Escrever num arquivo temporário e mover por cima
 * (`rename`) é atômico no mesmo volume: ou o config velho continua inteiro, ou o novo já está
 * inteiro — nunca um meio-termo corrompido.
 */
function writeJsonAtomico(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

export function loadConfig(home: string): NexoConfig {
  ensureHome(home);
  const path = configPath(home);
  if (!existsSync(path)) {
    writeJsonAtomico(path, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG, pack: { ...DEFAULT_CONFIG.pack }, accent: DEFAULT_CONFIG.accent };
  }
  let raw: Partial<NexoConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<NexoConfig>;
  } catch (e) {
    /*
     * `config.json` truncado/corrompido (ex.: processo morto no meio de um `writeFileSync`) não
     * pode derrubar o daemon inteiro — sem isso, TODA rota chama `loadConfig` e o motor nunca
     * mais volta a subir sozinho, porque cai nesta mesma exceção a cada tentativa. Cai pro
     * padrão e regrava o arquivo, igual ao caminho de "arquivo não existe" acima — perde a
     * config antiga (já estava ilegível mesmo), mas o daemon volta a responder.
     */
    console.error(`config.json corrompido (${(e as Error).message}) — voltando ao padrão`);
    writeJsonAtomico(path, DEFAULT_CONFIG);
    raw = {};
  }
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
    ...(isTetoTokens(raw.repoMapTetoTokens) ? { repoMapTetoTokens: raw.repoMapTetoTokens } : {}),
    modulos: cleanModulos(raw.modulos),
  };
}

function isTetoTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
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
    repoMapResumos: Boolean(o.repoMapResumos),
    repoMapProfileId: str(o.repoMapProfileId),
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
    ...(patch.repoMapTetoTokens === undefined
      ? current.repoMapTetoTokens !== undefined
        ? { repoMapTetoTokens: current.repoMapTetoTokens }
        : {}
      : isTetoTokens(patch.repoMapTetoTokens)
        ? { repoMapTetoTokens: patch.repoMapTetoTokens }
        : {}),
    // Merge campo a campo: `{ modulos: { rtk: true } }` liga só o rtk, sem apagar o resto.
    modulos: {
      rtk: patch.modulos?.rtk === undefined ? current.modulos.rtk : Boolean(patch.modulos.rtk),
      caveman: patch.modulos?.caveman === undefined ? current.modulos.caveman : Boolean(patch.modulos.caveman),
      cavemanNivel: isCavemanNivel(patch.modulos?.cavemanNivel)
        ? patch.modulos.cavemanNivel
        : current.modulos.cavemanNivel,
      repoMapResumos:
        patch.modulos?.repoMapResumos === undefined ? current.modulos.repoMapResumos : Boolean(patch.modulos.repoMapResumos),
      repoMapProfileId:
        patch.modulos?.repoMapProfileId === undefined
          ? current.modulos.repoMapProfileId
          : str(patch.modulos.repoMapProfileId),
    },
  };
  writeJsonAtomico(configPath(home), next);
  return next;
}
