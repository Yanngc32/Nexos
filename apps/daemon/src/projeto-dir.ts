import { execFileSync } from "node:child_process";
import { log } from "./log.ts";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { NexoConfig } from "@nexos/shared";
import { loadConfig } from "./config.ts";
import { readGoogleStore } from "./google-auth.ts";
import { projectKey } from "./home.ts";

/**
 * Pasta única por projeto (memória + tarefas + repo map dentro dela), nomeada de forma
 * legível e ESTÁVEL entre máquinas — ao contrário do hash de path que `memoria.ts`/
 * `tarefas.ts`/`repo-map-indice.ts` calculavam cada um por conta própria (mesmo projeto em
 * PCs diferentes = paths diferentes = hashes diferentes = pastas sem relação nenhuma). Ver
 * spec docs/superpowers/specs/2026-09-12-storage-cross-device-design.md.
 */

export type OrigemSlug = "manual" | "git" | "pasta";

/**
 * Raiz de todas as pastas de projeto (e da `_biblioteca/` geral).
 *
 * Com o Google Drive CONECTADO, é uma pasta do próprio Nexos (`<home>/drive`) e a pasta manual
 * (`projetosDir`) não vale: quem replica é o sync pela API (drive-sync.ts). Antes as duas
 * conviviam — a pasta manual apontando pro `G:\Meu Drive\…` que o Drive para desktop já espelhava
 * e o sync pela API mexendo na mesma pasta: dois sincronizadores no mesmo lugar. Trocar a raiz é
 * seguro: o sync recomeça a base e baixa tudo, sem apagar nada (ver `rodar` em drive-sync.ts).
 */
export function projetosRoot(home: string): string {
  if (readGoogleStore(home).refreshToken) return join(home, "drive");
  const cfg = loadConfig(home);
  return cfg.projetosDir || join(home, "projetos");
}

/** Nome da pasta-espelho de agentes/times/hooks/skills (`PASTA_BIBLIOTECA` em biblioteca.ts, que importa daqui). */
const PASTA_BIBLIOTECA = "_biblioteca";

/** Pastas de código/build: nunca são dado do Nexos, em nível nenhum. */
const PASTAS_DE_CODIGO = new Set(["node_modules", "__pycache__"]);

/**
 * Subpasta de primeiro nível de `projetosRoot` que é nossa: projeto (`meta.json`) ou a biblioteca.
 * Repo git com um `meta.json` qualquer na raiz não conta — pasta de projeto do Nexos nunca tem `.git`.
 */
function ehPastaDoNexos(dir: string, nome: string): boolean {
  if (nome === PASTA_BIBLIOTECA) return true;
  return existsSync(join(dir, "meta.json")) && !existsSync(join(dir, ".git"));
}

/**
 * `dir` tem cara de pasta de CÓDIGO (repo ou pasta de repos), não de pasta de dados do Nexos?
 * É repo git, ou tem subpasta que é repo git — pasta de projeto do Nexos nunca tem `.git`. Usada pra recusar `projetosDir` apontado pro lugar errado (ver PUT /v1/config).
 */
export function pastaDeCodigo(dir: string): boolean {
  try {
    if (existsSync(join(dir, ".git"))) return true;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sub = join(dir, e.name);
      if (existsSync(join(sub, ".git"))) return true;
    }
  } catch {
    // não existe ou não dá pra ler: nada pra dizer (o resto do app já trata pasta inexistente)
  }
  return false;
}

/** Acima disto a pasta manual não é de dados do Nexos: não copia nada. */
export const TETO_COPIA_ARQUIVOS = 20_000;
export const TETO_COPIA_BYTES = 500 * 1024 * 1024;

/** Origem que já bateu no teto NESTA subida: não varre de novo a cada rodada, e avisa uma vez só. */
const tetoAtingido = new Set<string>();

/** Só pra teste: esquece os tetos desta subida. */
export function resetTetoCopiaForTest(): void {
  tetoAtingido.clear();
}

/**
 * Google conectado: traz pra raiz do Drive (`<home>/drive`) o que estava na pasta manual antiga
 * (`projetosDir`), UMA vez por pasta de origem.
 *
 * Por quê: até a 0.5.0 as duas conviviam e o app gravava na manual (em geral `G:\Meu Drive\…`,
 * espelhada pelo Drive para desktop). O sync pela API só enxerga o que ELE criou no Drive, então
 * o que foi gravado direto na manual (ícones, memória, projetos inteiros) não estava na raiz nova
 * — trocar a raiz fazia parecer que os dados de projeto tinham sido resetados.
 *
 * Só copia arquivo que falta no destino (nunca sobrescreve) e a manual fica intacta, de backup.
 * A marca em `<home>/pasta-manual-migrada.json` evita recopiar o que a pessoa apagar depois.
 * Best-effort: nunca lança. Devolve quantos arquivos copiou.
 *
 * Só entra em pasta de projeto nossa (`meta.json`) e na `_biblioteca` — o mesmo filtro de
 * `varrerLocal` em drive-sync.ts. Sem isso, `projetosDir` apontado pra pasta de CÓDIGO da pessoa
 * (`C:\projects`, com repos, `node_modules`, `.git`) trazia tudo: medido 279.990 arquivos numa
 * máquina, cópia inútil de vários GB que o sync nem sobe.
 *
 * **Assíncrona e com teto.** A versão síncrona segurava o event loop do motor a cópia inteira — o
 * `/health` parava de responder e o motor parecia morto. Agora primeiro LISTA o que copiaria; se
 * passar de 20 mil arquivos ou 500 MB, não copia nada, avisa (uma vez por subida) e não grava a
 * marca — a pasta manual com esse tamanho não é de dados do Nexos.
 */
export async function trazerPastaManualProDrive(home: string, destino: string): Promise<number> {
  const de = loadConfig(home).projetosDir;
  if (!de || !readGoogleStore(home).refreshToken || !existsSync(de)) return 0;
  if (tetoAtingido.has(de)) return 0;
  const marca = join(home, "pasta-manual-migrada.json");
  try {
    const feita = JSON.parse(readFileSync(marca, "utf8")) as { de?: string };
    if (feita.de === de) return 0;
  } catch {
    // sem marca: ainda não migrou
  }
  const inicio = Date.now();
  log.info("copia", "começou a trazer a pasta manual pro Drive", { de, para: destino });

  type Item = { o: string; a: string; bytes: number };
  const itens: Item[] = [];
  let bytes = 0;
  let pulados = 0;
  let estourou = "";
  let ultimoProgresso = inicio;
  const progresso = (fase: string, n: number): void => {
    const agora = Date.now();
    if (n % 1000 !== 0 && agora - ultimoProgresso < 10_000) return;
    ultimoProgresso = agora;
    const dados = { fase, arquivos: n, bytes, ms: agora - inicio };
    if (agora - inicio > 30_000) log.info("copia", `progresso: ${n} arquivo(s)`, dados);
    else log.debug("copia", `progresso: ${n} arquivo(s)`, dados);
  };

  const listar = async (origem: string, alvo: string, raiz: boolean): Promise<void> => {
    for (const e of await readdir(origem, { withFileTypes: true })) {
      if (estourou) return;
      // restos de migrações/escritas antigas não viram dado de projeto
      if (e.name.endsWith(".stale-backup") || e.name.endsWith(".tmp") || e.name === "desktop.ini") continue;
      const o = join(origem, e.name);
      if (e.name.startsWith(".") || PASTAS_DE_CODIGO.has(e.name)) {
        if (e.isDirectory()) {
          pulados += 1;
          log.debug("copia", "pasta pulada", { pasta: o });
        }
        continue;
      }
      const a = join(alvo, e.name);
      if (e.isDirectory()) {
        if (!raiz || ehPastaDoNexos(o, e.name)) await listar(o, a, false);
        else {
          pulados += 1;
          log.debug("copia", "pasta pulada (não é do Nexos)", { pasta: o });
        }
      } else if (!raiz && e.isFile() && !existsSync(a)) {
        // arquivo solto na raiz não é de projeto nenhum
        const tam = (await stat(o)).size;
        itens.push({ o, a, bytes: tam });
        bytes += tam;
        progresso("listando", itens.length);
        if (itens.length > TETO_COPIA_ARQUIVOS) estourou = `mais de ${TETO_COPIA_ARQUIVOS} arquivos`;
        else if (bytes > TETO_COPIA_BYTES) estourou = `mais de ${Math.round(TETO_COPIA_BYTES / 1024 / 1024)} MB`;
      }
    }
  };

  let copiados = 0;
  try {
    await listar(de, destino, true);
    if (pulados) log.info("copia", `${pulados} pasta(s) pulada(s)`, { pulados });
    if (estourou) {
      // sem marca: se a pessoa limpar a pasta, a próxima subida tenta de novo
      tetoAtingido.add(de);
      log.aviso("copia", `teto atingido (${estourou}), não copiei nada: a pasta manual não parece ser só de dados do Nexos`, {
        de,
        arquivos: itens.length,
        bytes,
      });
      return 0;
    }
    for (const it of itens) {
      await mkdir(dirname(it.a), { recursive: true });
      await copyFile(it.o, it.a);
      copiados += 1;
      progresso("copiando", copiados);
    }
    writeFileSync(marca, JSON.stringify({ de, para: destino, em: new Date().toISOString(), copiados }, null, 2), "utf8");
    log.info("copia", `terminou: ${copiados} arquivo(s) trazidos`, { de, para: destino, arquivos: copiados, bytes, ms: Date.now() - inicio });
  } catch (e) {
    // sem marca: tenta de novo na próxima rodada (o que já veio não é copiado duas vezes)
    log.erro("copia", "não consegui trazer a pasta manual", { de, copiados, erro: (e as Error).message });
  }
  return copiados;
}

export type ModoArmazenamento = "pasta" | "projeto";

/** Pasta dos dados de UM projeto no modo dado (padrão: o da config). Não cria nada. */
export function dirDoProjeto(projectPath: string, home: string, modo: ModoArmazenamento = loadConfig(home).armazenamento): string {
  if (modo === "projeto") return join(projectPath, ".nexos");
  return join(projetosRoot(home), projectSlug(projectPath, home).slug);
}

/**
 * Modo "projeto": `.nexos/` entra no `.gitignore` do repo (memória, conversa exportada e repo map
 * não são código). Só em repo git; nunca duplica a linha. Best-effort: nunca lança.
 */
export function garantirGitignore(projectPath: string): void {
  try {
    if (!existsSync(join(projectPath, ".git"))) return;
    const arq = join(projectPath, ".gitignore");
    const atual = existsSync(arq) ? readFileSync(arq, "utf8") : "";
    if (/^\/?\.nexos\/?\s*$/m.test(atual)) return;
    const sep = atual && !atual.endsWith("\n") ? "\n" : "";
    writeFileSync(arq, `${atual}${sep}${atual ? "\n" : ""}# Nexos: memória, tarefas, repo map e design system deste projeto\n.nexos/\n`, "utf8");
  } catch (e) {
    log.aviso("drive", "não consegui ajustar o .gitignore", { projectPath, erro: (e as Error).message });
  }
}

/**
 * Trocou o modo de armazenamento: COPIA os dados de cada projeto do lugar antigo pro novo (só
 * quando o novo ainda não tem nada) — o antigo fica como estava, de backup. Best-effort.
 */
export function migrarArmazenamento(de: ModoArmazenamento, para: ModoArmazenamento, projetos: string[], home: string): number {
  if (de === para) return 0;
  let n = 0;
  for (const projectPath of projetos) {
    try {
      const origem = dirDoProjeto(projectPath, home, de);
      const destino = dirDoProjeto(projectPath, home, para);
      if (!existsSync(origem) || existsSync(join(destino, "meta.json"))) continue;
      mkdirSync(destino, { recursive: true });
      cpSync(origem, destino, { recursive: true, force: false, errorOnExist: false });
      if (para === "projeto") garantirGitignore(projectPath);
      n += 1;
    } catch (e) {
      log.erro("drive", "falha ao mover os dados do projeto", { projectPath, erro: (e as Error).message });
    }
  }
  return n;
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
  return dirDoProjeto(projectPath, home);
}

/** Pasta de UM projeto. Cria (com o `meta.json`) se ainda não existir. */
export function projectDir(projectPath: string, home: string): string {
  const { slug, origem } = projectSlug(projectPath, home);
  const modo = loadConfig(home).armazenamento;
  const dir = dirDoProjeto(projectPath, home, modo);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ projectPath, slug, origem }, null, 2), "utf8");
    if (modo === "projeto") garantirGitignore(projectPath);
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
    if (cfg[tipo.cfgField]) continue;
    moverLegado(join(home, tipo.raizDefault, hashLegado(projectPath)), projectPath, tipo, home);
  }
}

/**
 * Move UMA pasta do layout legado pro novo. Só quando a antiga existe e a nova ainda não —
 * nunca sobrescreve. Best-effort: nunca lança, só registra.
 */
function moverLegado(antigo: string, projectPath: string, tipo: TipoMigravel, home: string): void {
  try {
    if (!existsSync(antigo)) return;
    const novo = join(projectDir(projectPath, home), tipo.novoSub);
    if (existsSync(novo)) return;
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
    log.erro("drive", `falha ao migrar ${tipo.novoSub}`, { projectPath, erro: (e as Error).message });
  }
}

/**
 * Alguém acabou de APAGAR `memoriaDir`/`tarefasDir`/`graphDir` do config — o layout de verdade
 * daquele tipo passa a ser o novo (`projectDir/<sub>`), e o que estava na raiz antiga precisa vir
 * junto. `migrarProjeto` não dá conta deste caso: ele procura só na raiz PADRÃO (`~/.nexos/<tipo>`)
 * e, quando roda, o campo já foi apagado — ninguém mais sabe pra onde a pessoa tinha apontado.
 * Sem isso, tirar o override deixava memória/tarefas/repo map pra trás sem aviso nenhum.
 *
 * @param raizAntiga valor que o campo tinha ANTES de ser apagado.
 */
export function migrarRaizLegadaRemovida(
  cfgField: TipoMigravel["cfgField"],
  raizAntiga: string,
  projetos: string[],
  home: string,
): void {
  const tipo = TIPOS_MIGRAVEIS.find((t) => t.cfgField === cfgField);
  if (!tipo || !raizAntiga) return;
  for (const projectPath of projetos) {
    moverLegado(join(raizAntiga, hashLegado(projectPath)), projectPath, tipo, home);
  }
}
