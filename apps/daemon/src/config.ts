import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  CAVEMAN_NIVEIS,
  DEFAULT_CONFIG,
  LOG_NIVEIS,
  MODOS_PAINEL,
  PAINEIS_DO_AGENTE,
  SWITCH_MODES,
  TEMAS,
  TYPESAFE_MODOS,
  type CavemanNivel,
  type LogNivel,
  type NexoConfig,
  type SwitchMode,
  type Tema,
  type PaineisDoAgente,
  type TypesafeModo,
} from "@nexos/shared";
import { configPath, ensureHome } from "./home.ts";
import { log } from "./log.ts";

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
    log.erro("motor", "config.json corrompido, voltando ao padrão", { erro: (e as Error).message });
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
    tema: isTema(raw.tema) ? raw.tema : DEFAULT_CONFIG.tema,
    logoProjetos: raw.logoProjetos === undefined ? DEFAULT_CONFIG.logoProjetos : Boolean(raw.logoProjetos),
    repos: cleanRepos(raw.repos),
    hiddenRepos: cleanRepos(raw.hiddenRepos),
    lastProject: str(raw.lastProject),
    lastThread: str(raw.lastThread),
    trustedProjects: cleanRepos(raw.trustedProjects),
    memoriaDir: str(raw.memoriaDir),
    graphDir: str(raw.graphDir),
    tarefasDir: str(raw.tarefasDir),
    projetosDir: str(raw.projetosDir),
    armazenamento: raw.armazenamento === "projeto" ? "projeto" : "pasta",
    slugOverrides: cleanSlugOverrides(raw.slugOverrides),
    skillsDesligadas: cleanSkillsDesligadas(raw.skillsDesligadas),
    ...(isTetoTokens(raw.repoMapTetoTokens) ? { repoMapTetoTokens: raw.repoMapTetoTokens } : {}),
    modulos: cleanModulos(raw.modulos),
    windowsControlEnabled: Boolean(raw.windowsControlEnabled),
    paineisDoAgente: limparPaineis(raw.paineisDoAgente, DEFAULT_CONFIG.paineisDoAgente),
    typesafe: { modo: isTypesafeModo(raw.typesafe?.modo) ? raw.typesafe.modo : DEFAULT_CONFIG.typesafe.modo },
    ...(isLogNivel(raw.logNivel) ? { logNivel: raw.logNivel } : {}),
  };
}

export function isLogNivel(value: unknown): value is LogNivel {
  return typeof value === "string" && (LOG_NIVEIS as readonly string[]).includes(value);
}

function isTema(value: unknown): value is Tema {
  return typeof value === "string" && (TEMAS as string[]).includes(value);
}

function isTypesafeModo(value: unknown): value is TypesafeModo {
  return typeof value === "string" && (TYPESAFE_MODOS as string[]).includes(value);
}

function isTetoTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCavemanNivel(value: unknown): value is CavemanNivel {
  return typeof value === "string" && (CAVEMAN_NIVEIS as readonly string[]).includes(value);
}

/** Campo a campo por cima de `base`: o que vier inválido fica como estava. */
function limparPaineis(value: unknown, base: PaineisDoAgente): PaineisDoAgente {
  const o = (value ?? {}) as Partial<PaineisDoAgente>;
  return {
    modo: typeof o.modo === "string" && (MODOS_PAINEL as readonly string[]).includes(o.modo) ? o.modo : base.modo,
    paineis: Array.isArray(o.paineis)
      ? PAINEIS_DO_AGENTE.filter((p) => (o.paineis as unknown[]).includes(p))
      : [...base.paineis],
    trazerPraFrente: typeof o.trazerPraFrente === "boolean" ? o.trazerPraFrente : base.trazerPraFrente,
  };
}

function cleanModulos(value: unknown): NexoConfig["modulos"] {
  const o = (value ?? {}) as Partial<NexoConfig["modulos"]>;
  return {
    rtk: Boolean(o.rtk),
    caveman: Boolean(o.caveman),
    cavemanNivel: isCavemanNivel(o.cavemanNivel) ? o.cavemanNivel : DEFAULT_CONFIG.modulos.cavemanNivel,
    repoMapResumos: Boolean(o.repoMapResumos),
    repoMapProfileId: str(o.repoMapProfileId),
    quadroTarefas: o.quadroTarefas === undefined ? DEFAULT_CONFIG.modulos.quadroTarefas : Boolean(o.quadroTarefas),
    coletaDesign: o.coletaDesign === undefined ? DEFAULT_CONFIG.modulos.coletaDesign : Boolean(o.coletaDesign),
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

/** Chave/valor string→string (override manual de slug de projeto): sem vazio, teto pra não crescer sem fim. */
function cleanSlugOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const chave = k.trim();
    const slug = v.trim();
    if (!chave || !slug) continue;
    out[chave] = slug;
    if (Object.keys(out).length >= 200) break;
  }
  return out;
}

/** Skill → projetos onde está desligada: sem skill sem projeto, sem projeto repetido. */
function cleanSkillsDesligadas(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const nome = k.trim();
    if (!nome || !Array.isArray(v)) continue;
    const projetos = [...new Set(v.filter((p): p is string => typeof p === "string").map((p) => p.trim()).filter(Boolean))];
    if (!projetos.length) continue;
    out[nome] = projetos.slice(0, 200);
    if (Object.keys(out).length >= 200) break;
  }
  return out;
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
    tema: isTema(patch.tema) ? patch.tema : current.tema,
    logoProjetos: patch.logoProjetos === undefined ? current.logoProjetos : Boolean(patch.logoProjetos),
    repos: patch.repos === undefined ? current.repos : cleanRepos(patch.repos),
    hiddenRepos: patch.hiddenRepos === undefined ? current.hiddenRepos : cleanRepos(patch.hiddenRepos),
    lastProject: patch.lastProject === undefined ? current.lastProject : str(patch.lastProject),
    lastThread: patch.lastThread === undefined ? current.lastThread : str(patch.lastThread),
    trustedProjects:
      patch.trustedProjects === undefined ? current.trustedProjects : cleanRepos(patch.trustedProjects),
    memoriaDir: patch.memoriaDir === undefined ? current.memoriaDir : str(patch.memoriaDir),
    graphDir: patch.graphDir === undefined ? current.graphDir : str(patch.graphDir),
    tarefasDir: patch.tarefasDir === undefined ? current.tarefasDir : str(patch.tarefasDir),
    projetosDir: patch.projetosDir === undefined ? current.projetosDir : str(patch.projetosDir),
    armazenamento:
      patch.armazenamento === undefined ? current.armazenamento : patch.armazenamento === "projeto" ? "projeto" : "pasta",
    // Merge raso: um PATCH de slugOverrides SUBSTITUI o mapa inteiro (igual todo outro campo
    // aqui) — quem quer só ACRESCENTAR uma entrada manda o mapa atual + a nova (a UI já lê o
    // config antes de patchar, então tem o mapa corrente em mãos).
    slugOverrides: patch.slugOverrides === undefined ? current.slugOverrides : cleanSlugOverrides(patch.slugOverrides),
    skillsDesligadas:
      patch.skillsDesligadas === undefined ? current.skillsDesligadas : cleanSkillsDesligadas(patch.skillsDesligadas),
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
      quadroTarefas:
        patch.modulos?.quadroTarefas === undefined ? current.modulos.quadroTarefas : Boolean(patch.modulos.quadroTarefas),
      coletaDesign:
        patch.modulos?.coletaDesign === undefined ? current.modulos.coletaDesign : Boolean(patch.modulos.coletaDesign),
    },
    windowsControlEnabled:
      patch.windowsControlEnabled === undefined ? current.windowsControlEnabled : Boolean(patch.windowsControlEnabled),
    paineisDoAgente: limparPaineis(patch.paineisDoAgente, current.paineisDoAgente),
    typesafe: { modo: isTypesafeModo(patch.typesafe?.modo) ? patch.typesafe.modo : current.typesafe.modo },
    ...(isLogNivel(patch.logNivel)
      ? { logNivel: patch.logNivel }
      : current.logNivel !== undefined
        ? { logNivel: current.logNivel }
        : {}),
  };
  writeJsonAtomico(configPath(home), next);
  return next;
}
