import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { NexoConfig } from "@nexo/shared";
import { loadConfig } from "./config.ts";
import { projectKey } from "./home.ts";

/**
 * Pasta única por projeto (memória + tarefas + repo map dentro dela), nomeada de forma
 * legível e ESTÁVEL entre máquinas — ao contrário do hash de path que `memoria.ts`/
 * `tarefas.ts`/`repo-map-indice.ts` calculavam cada um por conta própria (mesmo projeto em
 * PCs diferentes = paths diferentes = hashes diferentes = pastas sem relação nenhuma). Ver
 * spec docs/superpowers/specs/2026-09-12-storage-cross-device-design.md.
 */

export type OrigemSlug = "manual" | "git" | "pasta";

/** Raiz de todas as pastas de projeto. Configurável pra apontar numa pasta já sincronizada. */
export function projetosRoot(home: string): string {
  const cfg = loadConfig(home);
  return cfg.projetosDir || join(home, "projetos");
}

function normalizarSlug(bruto: string): string {
  return bruto
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** `owner/repo` (os dois últimos segmentos de path) de uma URL de remote git, HTTPS ou SSH. */
function ownerRepoDoRemote(url: string): string | undefined {
  const semGit = url.trim().replace(/\.git$/i, "");
  const segmentos = semGit.split(/[/:]/).filter(Boolean);
  if (segmentos.length < 2) return undefined;
  const [repo, owner] = [segmentos.at(-1)!, segmentos.at(-2)!];
  return `${owner}-${repo}`;
}

/**
 * Cache do remote git por projeto — `projectSlug` é chamado várias vezes por turno de
 * conversa (memória, tarefas, repo map, cada um por conta própria), e sem isso cada uma
 * dessas chamadas spawnaria um processo `git` síncrono (lento, principalmente no Windows).
 * Remote não muda no meio de um daemon rodando na prática; pior caso aceitável é precisar
 * reiniciar o daemon pra pegar uma troca de remote — mesmo trade-off do `entryCache` em
 * `spawn-bin.ts` pro mesmo tipo de custo (processo + IO por chamada repetida).
 */
const remoteOrigemCache = new Map<string, string | undefined>();

/** `git remote get-url origin` — best-effort, nunca lança (sem git, sem repo, sem remote = undefined). */
function remoteOrigin(projectPath: string): string | undefined {
  const chave = projectKey(projectPath);
  if (remoteOrigemCache.has(chave)) return remoteOrigemCache.get(chave);
  let out: string | undefined;
  try {
    const bruto = execFileSync("git", ["-C", projectPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    out = bruto.trim() || undefined;
  } catch {
    out = undefined;
  }
  remoteOrigemCache.set(chave, out);
  return out;
}

/** Slugs já em uso em `projetosRoot`, lidos do `meta.json` de cada subpasta — pra checar colisão do fallback. */
function slugsExistentes(root: string): Map<string, string> {
  const out = new Map<string, string>(); // slug -> projectPath dono
  let nomes: string[];
  try {
    nomes = readdirSync(root);
  } catch {
    return out;
  }
  for (const nome of nomes) {
    try {
      const meta = JSON.parse(readFileSync(join(root, nome, "meta.json"), "utf8")) as { projectPath?: string };
      if (typeof meta.projectPath === "string") out.set(nome, meta.projectPath);
    } catch {
      // pasta sem meta.json legível (não é uma pasta de projeto nossa) — ignora
    }
  }
  return out;
}

export function projectSlug(projectPath: string, home: string): { slug: string; origem: OrigemSlug } {
  const chave = projectKey(projectPath);
  const override = loadConfig(home).slugOverrides[chave];
  if (override) return { slug: override, origem: "manual" };

  const remote = remoteOrigin(projectPath);
  const doRemote = remote && ownerRepoDoRemote(remote);
  if (doRemote) {
    const slug = normalizarSlug(doRemote);
    if (slug) return { slug, origem: "git" };
  }

  const base = normalizarSlug(basename(projectPath)) || "projeto";
  const existentes = slugsExistentes(projetosRoot(home));
  const dono = existentes.get(base);
  if (dono === undefined || projectKey(dono) === chave) return { slug: base, origem: "pasta" };
  // colisão com pasta de OUTRO projeto: sufixo curto e estável pra não pisar em cima dela
  const sufixo = createHash("sha1").update(chave).digest("hex").slice(0, 4);
  return { slug: `${base}-${sufixo}`, origem: "pasta" };
}

/**
 * Caminho da pasta de UM projeto, sem criar nada — pra leitura pura (ex.: `readMemoria`,
 * chamada em toda conversa; criar pasta só de ler encheria `projetosRoot` de entrada até pra
 * projeto que nunca vai ter memória/tarefa/repo-map nenhum).
 */
export function projectDirSemCriar(projectPath: string, home: string): string {
  return join(projetosRoot(home), projectSlug(projectPath, home).slug);
}

/** Pasta de UM projeto. Cria (com o `meta.json`) se ainda não existir. */
export function projectDir(projectPath: string, home: string): string {
  const { slug, origem } = projectSlug(projectPath, home);
  const dir = join(projetosRoot(home), slug);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ projectPath, slug, origem }, null, 2), "utf8");
  }
  return dir;
}

function hashLegado(projectPath: string): string {
  return createHash("sha1").update(projectKey(projectPath)).digest("hex");
}

/**
 * Um tipo de dado que migra do layout antigo (raiz-por-tipo + hash) pro novo
 * (`projectDir/<novoSub>`) — ver `memoria.ts`/`tarefas.ts`/`repo-map-indice.ts`.
 */
type TipoMigravel = { cfgField: keyof Pick<NexoConfig, "memoriaDir" | "tarefasDir" | "graphDir">; raizDefault: string; novoSub: string };

const TIPOS_MIGRAVEIS: TipoMigravel[] = [
  { cfgField: "memoriaDir", raizDefault: "memoria", novoSub: "memoria" },
  { cfgField: "tarefasDir", raizDefault: "tarefas", novoSub: "tarefas" },
  { cfgField: "graphDir", raizDefault: "grafo", novoSub: "repo-map" },
];

/**
 * Move o conteúdo do layout antigo (raiz por tipo + hash do projeto) pro layout novo
 * (pasta única do projeto) — best-effort, nunca lança, chamada em `cmdUp()` pra cada projeto
 * conhecido. Só mexe num tipo quando: (1) não há override explícito pra ele (`memoriaDir`
 * etc. configurado — nesse caso o layout antigo CONTINUA sendo o de verdade, nada a migrar),
 * (2) a pasta antiga existe, e (3) a pasta nova ainda NÃO existe (nunca sobrescreve).
 */
export function migrarProjeto(projectPath: string, home: string): void {
  const cfg = loadConfig(home);
  for (const tipo of TIPOS_MIGRAVEIS) {
    try {
      if (cfg[tipo.cfgField]) continue;
      const antigo = join(home, tipo.raizDefault, hashLegado(projectPath));
      if (!existsSync(antigo)) continue;
      const novo = join(projectDir(projectPath, home), tipo.novoSub);
      if (existsSync(novo)) continue;
      mkdirSync(dirname(novo), { recursive: true });
      try {
        renameSync(antigo, novo);
      } catch {
        // `EXDEV` (raiz nova em outro volume) ou qualquer outra falha de rename: copia e só
        // apaga a origem depois da cópia ter dado certo — nunca perde dado no meio do caminho.
        cpSync(antigo, novo, { recursive: true });
        rmSync(antigo, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`nexo: falha ao migrar ${tipo.novoSub} de ${projectPath}: ${(e as Error).message}`);
    }
  }
}
