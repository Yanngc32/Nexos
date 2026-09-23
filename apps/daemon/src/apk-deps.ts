import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Bubblewrap from "@bubblewrap/core";

/**
 * `@bubblewrap/core` (gera o APK do app de celular) SOB DEMANDA.
 *
 * Ela sozinha puxava 244 pacotes e ~9.200 dos ~10.000 arquivos do instalador (googleapis, jimp,
 * lodash, rxjs…) — era por isso que a atualização levava ~2 min trocando arquivo. O motor não
 * precisa dela pra nada além de gerar o APK, que se faz uma vez. Então ela não vai no instalador:
 * na primeira geração, o Nexos baixa um zip com ela (publicado numa release própria do GitHub,
 * `apk-deps-<versão>`) e guarda em `~/.nexos/apk-deps/v<versão>/`.
 *
 * Em desenvolvimento (e nos testes) ela está instalada como devDependency e carrega direto.
 * Mudou a versão da bubblewrap? Suba `APK_DEPS_VERSAO` e gere o zip de novo
 * (`scripts/build-apk-deps.mjs`).
 */
export const APK_DEPS_VERSAO = "1";
export const APK_DEPS_URL = `https://github.com/Yanngc32/Nexos/releases/download/apk-deps-${APK_DEPS_VERSAO}/apk-deps-${APK_DEPS_VERSAO}.zip`;

export type Bw = typeof Bubblewrap & { BUILD_TOOLS_VERSION: string };

export function apkDepsDir(home: string): string {
  return join(home, "apk-deps", `v${APK_DEPS_VERSAO}`);
}

type Opts = {
  fetchImpl?: typeof fetch;
  url?: string;
  /** Avisa quando vai baixar (a tela do celular mostra "baixando…"). */
  aoBaixar?: () => void;
};

let carregada: Bw | null = null;

function daPasta(dir: string): Bw {
  const req = createRequire(join(dir, "carregar.cjs"));
  const bw = req("@bubblewrap/core") as typeof Bubblewrap;
  const { BUILD_TOOLS_VERSION } = req("@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools.js") as { BUILD_TOOLS_VERSION: string };
  return { ...bw, BUILD_TOOLS_VERSION };
}

async function instalada(): Promise<Bw | null> {
  try {
    const bw = (await import("@bubblewrap/core")) as typeof Bubblewrap & { default?: typeof Bubblewrap };
    const tools = (await import("@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools.js")) as { BUILD_TOOLS_VERSION?: string; default?: { BUILD_TOOLS_VERSION: string } };
    const base = (bw.default ?? bw) as typeof Bubblewrap;
    return { ...base, BUILD_TOOLS_VERSION: tools.BUILD_TOOLS_VERSION ?? tools.default!.BUILD_TOOLS_VERSION };
  } catch {
    return null;
  }
}

/** Baixa e extrai o zip pra `dir` (por pasta temporária + rename: nunca fica pela metade). */
async function baixar(home: string, dir: string, opts: Opts): Promise<void> {
  opts.aoBaixar?.();
  const res = await (opts.fetchImpl ?? fetch)(opts.url ?? APK_DEPS_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`não consegui baixar as dependências do APK (HTTP ${res.status}) — confira a internet e tente de novo`);
  const zip = Buffer.from(await res.arrayBuffer());
  const tmp = `${dir}.baixando-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const { default: AdmZip } = await import("adm-zip");
    new AdmZip(zip).extractAllTo(tmp, true);
    if (!existsSync(join(tmp, "node_modules", "@bubblewrap", "core", "package.json"))) {
      throw new Error("o pacote de dependências do APK veio incompleto");
    }
    writeFileSync(join(tmp, "versao.txt"), APK_DEPS_VERSAO, "utf8");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(home, "apk-deps"), { recursive: true });
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

/**
 * A bubblewrap pronta pra usar: instalada (dev) → já baixada → baixa agora. Carregada uma vez por
 * processo.
 */
export async function carregarBubblewrap(home: string, opts: Opts = {}): Promise<Bw> {
  if (carregada) return carregada;
  const local = await instalada();
  if (local) return (carregada = local);
  const dir = apkDepsDir(home);
  if (!existsSync(join(dir, "node_modules", "@bubblewrap", "core", "package.json"))) await baixar(home, dir, opts);
  return (carregada = daPasta(dir));
}

/** Só pra teste: o download direto (em dev a devDependency faria o `carregarBubblewrap` pular ele). */
export const __baixarParaTeste = baixar;

/** Só pra teste: força o caminho "baixado" (sem a devDependency) e zera o cache. */
export function carregarDaPastaParaTeste(dir: string): Bw {
  return daPasta(dir);
}
export function resetApkDepsForTest(): void {
  carregada = null;
}
