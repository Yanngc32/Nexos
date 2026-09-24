import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResultadoSync, StatusDrive } from "@nexos/shared";
import { driveSyncStatePath } from "./home.ts";
import { log } from "./log.ts";
import { googleAccount, readGoogleStore, updateGoogleStore } from "./google-auth.ts";
import {
  acharRaizNexo,
  createFile,
  createFolder,
  downloadFile,
  getFolder,
  listChildren,
  marcarRaizNexo,
  MIME_PASTA,
  trashFile,
  updateFile,
} from "./google-drive.ts";
import { sincronizarBiblioteca } from "./biblioteca.ts";
import { ehPastaDoNexos, projetosRoot, trazerPastaManualProDrive } from "./projeto-dir.ts";
import { decidir, Ignorados, PASTA_BIBLIOTECA, sincronizavel, type Acao } from "./sync-decisao.ts";
import { importarConversas, mesclarJsonl } from "./threads.ts";

/**
 * Sync de DUAS MÃOS entre `projetosRoot` (memória, tarefas, repo-map, conversas de cada projeto)
 * e uma pasta do Drive escolhida pela pessoa, pela API — sem Drive Desktop. A estrutura é a mesma
 * dos dois lados: `<pasta do Drive>/<slug-do-projeto>/{memoria,tarefas,repo-map,conversas}/…`.
 *
 * Como saber quem mudou: o estado local (`drive-sync.json`, por máquina) guarda o MD5 de cada
 * arquivo na última vez em que os dois lados estavam iguais. Comparando local e remoto com essa
 * base, dá pra separar "só eu mudei", "só o outro mudou", "apagaram" e "os dois mudaram".
 * Conflito: conversa (`.jsonl`, só cresce) é mesclada linha a linha; o resto vale o mais recente.
 *
 * `meta.json` de cada projeto NÃO sincroniza: ele guarda o caminho da pasta NESTA máquina.
 * `_biblioteca/` (agentes, times, hooks, skills) viaja junto, conciliada antes e depois de cada
 * rodada por `sincronizarBiblioteca` (biblioteca.ts).
 */

export { decidir, type Acao } from "./sync-decisao.ts";

type BaseEntry = { md5: string; size: number; mtimeMs: number };
type Estado = { folderId: string; root: string; files: Record<string, BaseEntry> };

export type { ResultadoSync, StatusDrive } from "@nexos/shared";

const md5 = (buf: Buffer | string): string => createHash("md5").update(buf).digest("hex");

function lerEstado(home: string): Estado | undefined {
  try {
    const raw = JSON.parse(readFileSync(driveSyncStatePath(home), "utf8")) as Partial<Estado>;
    if (typeof raw.folderId !== "string" || typeof raw.root !== "string" || !raw.files || typeof raw.files !== "object") return undefined;
    return { folderId: raw.folderId, root: raw.root, files: raw.files };
  } catch {
    return undefined;
  }
}

function gravarEstado(home: string, e: Estado): void {
  const path = driveSyncStatePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(e), "utf8");
  renameSync(tmp, path);
}

/** Nome de arquivo/pasta vindo do Drive: recusa o que escaparia da raiz ao virar caminho local. */
function nomeSeguro(nome: string): boolean {
  return nome !== "" && nome !== "." && nome !== ".." && !/[\\/:*?"<>|\0]/.test(nome) && !nome.startsWith(".");
}

type Local = { md5: string; size: number; mtimeMs: number };

/** A cada tantos arquivos a varredura devolve a vez pro event loop (o `/health` responde no meio). */
const CEDER_A_CADA = 200;

function ceder(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** md5 lendo em stream: um arquivo grande sem cache não segura o motor enquanto é lido. */
function md5DoArquivo(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(abs)
      .on("data", (b) => h.update(b))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * Assíncrona e cedendo a vez a cada 200 arquivos: a primeira rodada (sem base) relê tudo, e a
 * versão síncrona segurava o event loop o tempo inteiro. Nas rodadas seguintes quase nada é
 * relido (tamanho e mtime iguais aos da base).
 */
async function varrerLocal(
  root: string,
  base: Record<string, BaseEntry>,
): Promise<{ arquivos: Map<string, Local>; topoIgnorado: Set<string> }> {
  const inicio = Date.now();
  log.info("sync", "varrerLocal começou", { root });
  const out = new Map<string, Local>();
  const ignorados = new Ignorados();
  // pasta de 1º nível que existe aqui mas não é do Nexos (sem meta.json, ou repo com .git): o sync
  // não toca nela de lado nenhum — nem baixa pra dentro, nem apaga no remoto o que a base lembra
  const topoIgnorado = new Set<string>();
  let vistos = 0;
  let relidos = 0;
  const andar = async (dir: string, prefixo: string): Promise<void> => {
    let nomes: string[];
    try {
      nomes = await readdir(dir);
    } catch {
      return;
    }
    for (const nome of nomes) {
      if (nome.startsWith(".") || nome.endsWith(".tmp")) continue;
      const abs = join(dir, nome);
      const rel = prefixo ? `${prefixo}/${nome}` : nome;
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // 1º nível: só pasta de projeto do Nexos (`meta.json`, sem `.git`) ou a `_biblioteca`.
        // Abaixo disso, só os dados que o Nexos grava — nunca desce em `node_modules`, `src`…
        if (prefixo === "" ? !ehPastaDoNexos(abs, nome) : !sincronizavel(rel)) {
          ignorados.anotar(rel);
          if (prefixo === "") topoIgnorado.add(nome);
          continue;
        }
        await andar(abs, rel);
      } else if (st.isFile()) {
        // arquivo solto na raiz, `meta.json` do projeto (caminho NESTA máquina) e o que não é dado
        if (!sincronizavel(rel)) {
          ignorados.anotar(rel);
          continue;
        }
        if (++vistos % CEDER_A_CADA === 0) await ceder();
        const anterior = base[rel];
        // mesmo tamanho e mtime da última sync: não relê o arquivo (repo-map pode ser grande)
        let hash: string;
        if (anterior && anterior.size === st.size && anterior.mtimeMs === st.mtimeMs) hash = anterior.md5;
        else {
          try {
            hash = await md5DoArquivo(abs);
          } catch {
            continue; // sumiu entre o stat e a leitura: entra na próxima rodada
          }
          relidos += 1;
        }
        out.set(rel, { md5: hash, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  await andar(root, "");
  log.info("sync", "varrerLocal terminou", {
    arquivos: out.size,
    relidos,
    ignorados: ignorados.total,
    maisIgnoradas: ignorados.maiores(),
    ms: Date.now() - inicio,
  });
  return { arquivos: out, topoIgnorado };
}

type Remoto = { id: string; md5: string; mtimeMs: number };

/**
 * Mesmo filtro da varredura local: no 1º nível só pastas (projeto ou `_biblioteca`); abaixo, só o
 * que `sincronizavel` aceita. Subárvore fora da lista nem é listada — código que já tinha subido
 * pro Drive (`APROXIMA/src/...`) não desce aqui e não custa uma chamada por pasta.
 */
async function varrerRemoto(
  home: string,
  rootId: string,
  topoIgnorado: Set<string>,
): Promise<{ arquivos: Map<string, Remoto>; pastas: Map<string, string> }> {
  const inicio = Date.now();
  const arquivos = new Map<string, Remoto>();
  const pastas = new Map<string, string>([["", rootId]]);
  const ignorados = new Ignorados();
  const fila: { id: string; rel: string }[] = [{ id: rootId, rel: "" }];
  while (fila.length) {
    const { id, rel } = fila.shift()!;
    for (const item of await listChildren(home, id)) {
      if (!nomeSeguro(item.name)) continue;
      const caminho = rel ? `${rel}/${item.name}` : item.name;
      if (item.mimeType === MIME_PASTA) {
        if (pastas.has(caminho)) continue;
        if (rel ? !sincronizavel(caminho) : topoIgnorado.has(item.name)) {
          ignorados.anotar(caminho);
          continue;
        }
        pastas.set(caminho, item.id);
        fila.push({ id: item.id, rel: caminho });
      } else if (item.md5Checksum && !arquivos.has(caminho)) {
        // sem md5 = Google Docs/Sheets/atalho: não é arquivo nosso
        if (!sincronizavel(caminho)) {
          ignorados.anotar(caminho);
          continue;
        }
        arquivos.set(caminho, { id: item.id, md5: item.md5Checksum, mtimeMs: Date.parse(item.modifiedTime ?? "") || 0 });
      }
    }
  }
  log.info("sync", "varrerRemoto terminou", {
    arquivos: arquivos.size,
    ignorados: ignorados.total,
    maisIgnoradas: ignorados.maiores(),
    ms: Date.now() - inicio,
  });
  return { arquivos, pastas };
}

let emAndamento: Promise<ResultadoSync> | undefined;
let ultimo: ResultadoSync | undefined;
/** Rodada em voo: desde quando, e quantas operações (subir/baixar/apagar/mesclar) ainda faltam. */
let andamento: { desde: string; pendentes: number } | undefined;

export function driveStatus(home: string): StatusDrive {
  const acc = googleAccount(home);
  return {
    connected: acc.connected,
    ...(acc.folder ? { folder: acc.folder } : {}),
    running: emAndamento !== undefined,
    ...(emAndamento && andamento ? { emAndamentoDesde: andamento.desde, pendentes: andamento.pendentes } : {}),
    ...(ultimo ? { last: ultimo } : {}),
  };
}

/** Acima disto numa rodada só, algo está errado (código entrando no sync): para e avisa. */
export const TETO_OPERACOES = 5000;
/** Grava o estado a cada tantas operações (e a cada projeto concluído). */
const GRAVAR_A_CADA = 200;
/** Tantos erros seguidos = a rede caiu: para a rodada (o estado já gravado fica) em vez de insistir. */
const ERROS_SEGUIDOS_MAX = 20;

/** Teto já avisado nesta subida (por raiz): a rodada repete a cada 2 min, o log não precisa. */
const tetoAvisado = new Set<string>();

/** Só pra teste: esquece o que já foi avisado nesta subida. */
export function resetAvisosSyncForTest(): void {
  tetoAvisado.clear();
}

/** `_biblioteca` primeiro, depois os projetos (agentes/skills não ficam atrás de um projeto grande). */
function ordemDaRodada(a: string, b: string): number {
  const ba = a.startsWith(`${PASTA_BIBLIOTECA}/`) ? 0 : 1;
  const bb = b.startsWith(`${PASTA_BIBLIOTECA}/`) ? 0 : 1;
  return ba - bb || (a < b ? -1 : a > b ? 1 : 0);
}

export const NOME_PASTA_NEXO = "Nexos";

/**
 * Pasta de destino quando esta máquina ainda não tem nenhuma: a que outro PC da mesma conta já
 * usa (marcada, ver `marcarRaizNexo`), senão cria "Nexos" no Meu Drive. Grava o id pra próxima rodada.
 */
export async function garantirPastaNexo(home: string): Promise<{ id: string; name: string }> {
  const existente = await acharRaizNexo(home);
  const pasta = existente ?? (await criarPastaNexo(home));
  updateGoogleStore(home, { folderId: pasta.id, folderName: pasta.name });
  return { id: pasta.id, name: pasta.name };
}

export async function criarPastaNexo(home: string): Promise<{ id: string; name: string }> {
  const pasta = await createFolder(home, "root", NOME_PASTA_NEXO);
  await marcarRaizNexo(home, pasta.id);
  return pasta;
}

/** Usa `id` como pasta dos projetos (escolhida no seletor do Google) e avisa os outros PCs. */
export async function usarPastaDrive(home: string, id: string): Promise<{ id: string; name: string }> {
  // a raiz do Meu Drive não aceita appProperties customizado (marcarRaizNexo falharia) — e sincronizar
  // o Drive inteiro da pessoa seria um escopo bem diferente do pretendido aqui.
  if (id === "root") {
    throw Object.assign(new Error("não dá pra usar a raiz do Meu Drive — crie ou escolha uma subpasta"), { status: 400 });
  }
  const pasta = await getFolder(home, id);
  await marcarRaizNexo(home, pasta.id);
  updateGoogleStore(home, { folderId: pasta.id, folderName: pasta.name });
  return { id: pasta.id, name: pasta.name };
}

export function removerPastaDrive(home: string): void {
  updateGoogleStore(home, { folderId: undefined, folderName: undefined });
}

/** Uma rodada de sync (single-flight: chamada durante outra devolve a mesma promessa). */
export function sincronizarDrive(home: string): Promise<ResultadoSync> {
  if (emAndamento) return emAndamento;
  andamento = { desde: new Date().toISOString(), pendentes: 0 };
  emAndamento = rodar(home).finally(() => {
    emAndamento = undefined;
    andamento = undefined;
  });
  return emAndamento;
}

async function rodar(home: string): Promise<ResultadoSync> {
  const inicio = Date.now();
  const res: ResultadoSync = { subiu: 0, baixou: 0, apagouLocal: 0, apagouRemoto: 0, mesclou: 0, erros: [], iniciouEm: new Date(inicio).toISOString(), duracaoMs: 0 };
  try {
    const store = readGoogleStore(home);
    if (!store.refreshToken) throw Object.assign(new Error("conta Google não conectada"), { status: 400 });
    const folderId = store.folderId ?? (await garantirPastaNexo(home)).id;
    const rootLocal = projetosRoot(home);
    mkdirSync(rootLocal, { recursive: true });
    // o que ficou na pasta manual antiga (gravado fora do sync pela API) vem pra cá e sobe nesta rodada
    await trazerPastaManualProDrive(home, rootLocal);
    // antes: o que mudou aqui (agente, time, hook, skill) já vai no espelho que sobe nesta rodada
    anotarBiblioteca(res, sincronizarBiblioteca(home));

    // outra pasta do Drive ou outra raiz local: a base antiga não vale mais (recomeça do zero, sem apagar nada)
    let estado = lerEstado(home);
    if (!estado || estado.folderId !== folderId || estado.root !== rootLocal) {
      estado = { folderId, root: rootLocal, files: {} };
    }

    const { arquivos: local, topoIgnorado } = await varrerLocal(rootLocal, estado.files);
    let varredura;
    try {
      varredura = await varrerRemoto(home, folderId, topoIgnorado);
    } catch (e) {
      // pasta apagada (ou tirada do alcance) no Drive: esquece, a próxima rodada acha/cria outra
      if ((e as { status?: number }).status === 404) {
        removerPastaDrive(home);
        throw new Error("a pasta do Drive não existe mais — o Nexos vai criar outra na próxima sincronização");
      }
      throw e;
    }
    const { arquivos: remoto, pastas } = varredura;

    /*
     * Base com o MESMO filtro das duas varreduras: entrada antiga fora da lista (o `node_modules` que
     * subiu na 0.8.0) é descartada, não tratada como "apagada" — senão o sync apagaria do outro lado.
     */
    const dentro = (rel: string): boolean => sincronizavel(rel) && !topoIgnorado.has(rel.split("/")[0]!);
    const base: Record<string, BaseEntry> = {};
    for (const [rel, b] of Object.entries(estado.files)) if (dentro(rel)) base[rel] = b;
    estado.files = base;

    // Um lado vazio com base cheia é quase sempre acidente (pasta apagada/movida), não intenção:
    // trata como "nunca sincronizado" em vez de propagar a exclusão em massa pro outro lado.
    const temBase = Object.keys(base).length > 0;
    const ignorarBase = temBase && (local.size === 0 || remoto.size === 0);

    const garantirPasta = async (rel: string): Promise<string> => {
      const existente = pastas.get(rel);
      if (existente) return existente;
      const i = rel.lastIndexOf("/");
      const paiId = await garantirPasta(i === -1 ? "" : rel.slice(0, i));
      const nova = await createFolder(home, paiId, i === -1 ? rel : rel.slice(i + 1));
      pastas.set(rel, nova.id);
      return nova.id;
    };

    // o plano inteiro antes de mexer: conta as operações pro teto e pro "pendentes" da tela
    const caminhos = [...new Set([...local.keys(), ...remoto.keys(), ...Object.keys(base)])].filter(dentro).sort(ordemDaRodada);
    const plano: { rel: string; acao: Acao }[] = caminhos.map((rel) => {
      const l = local.get(rel);
      const r = remoto.get(rel);
      const b = ignorarBase ? undefined : base[rel];
      return { rel, acao: decidir(b?.md5, l?.md5, r?.md5, { jsonl: rel.endsWith(".jsonl"), mtimeLocal: l?.mtimeMs ?? 0, mtimeRemoto: r?.mtimeMs ?? 0 }) };
    });
    const operacoes = plano.filter((p) => p.acao !== "nada");
    if (operacoes.length > TETO_OPERACOES) {
      const porPasta = new Ignorados();
      for (const op of operacoes) porPasta.anotar(op.rel);
      const msg = `rodada com ${operacoes.length} operações passa do teto de ${TETO_OPERACOES}: não sincronizei nada`;
      if (!tetoAvisado.has(rootLocal)) {
        tetoAvisado.add(rootLocal);
        log.aviso("sync", msg, { operacoes: operacoes.length, maiores: porPasta.maiores() });
      }
      throw new Error(msg);
    }
    if (andamento) andamento.pendentes = operacoes.length;

    /*
     * Estado INCREMENTAL: `atual` começa na base e é atualizado arquivo a arquivo; vai pro disco a
     * cada 200 operações e a cada projeto concluído. Rodada interrompida (app fechado, rede caiu)
     * continua de onde parou — antes o estado só era gravado no fim, e uma rodada grande
     * recomeçava do zero pra sempre.
     */
    const atual: Record<string, BaseEntry> = { ...base };
    const gravarAgora = (): void => {
      estado.files = atual;
      gravarEstado(home, estado);
    };
    const gravar = (rel: string, buf: Buffer, st: { size: number; mtimeMs: number }): void => {
      atual[rel] = { md5: md5(buf), size: st.size, mtimeMs: st.mtimeMs };
    };
    let desdeGravou = 0;
    let errosSeguidos = 0;
    let topoAnterior = "";

    try {
      for (const { rel, acao } of plano) {
        const topo = rel.split("/")[0]!;
        if (topoAnterior && topo !== topoAnterior) {
          gravarAgora(); // projeto concluído
          desdeGravou = 0;
        }
        topoAnterior = topo;
        const l = local.get(rel);
        const r = remoto.get(rel);
        const abs = join(rootLocal, ...rel.split("/"));
        try {
          if (acao === "nada") {
            if (l) atual[rel] = { md5: l.md5, size: l.size, mtimeMs: l.mtimeMs };
            else delete atual[rel];
            continue;
          } else if (acao === "subir") {
            const st = statSync(abs); // antes de ler: se mudar no meio, o próximo ciclo enxerga
            const buf = readFileSync(abs);
            if (r) await updateFile(home, r.id, buf);
            else {
              const i = rel.lastIndexOf("/");
              await createFile(home, await garantirPasta(i === -1 ? "" : rel.slice(0, i)), rel.slice(i + 1), buf);
            }
            gravar(rel, buf, st);
            res.subiu++;
          } else if (acao === "baixar") {
            const buf = await downloadFile(home, r!.id);
            // mudou localmente durante o download: não pisa, o próximo ciclo resolve como conflito
            if (!(l && existsSync(abs) && md5(readFileSync(abs)) !== l.md5)) {
              escreverAtomico(abs, buf);
              gravar(rel, buf, statSync(abs));
              res.baixou++;
            }
          } else if (acao === "mesclar") {
            const doRemoto = (await downloadFile(home, r!.id)).toString("utf8");
            // sem `await` entre ler o local e gravar: nenhum append do daemon cabe no meio
            const doLocal = existsSync(abs) ? readFileSync(abs, "utf8") : "";
            const junto = mesclarJsonl(doLocal, doRemoto);
            if (junto !== doLocal) escreverAtomico(abs, Buffer.from(junto, "utf8"));
            const buf = Buffer.from(junto, "utf8");
            if (md5(buf) !== r!.md5) await updateFile(home, r!.id, buf);
            gravar(rel, buf, statSync(abs));
            res.mesclou++;
          } else if (acao === "apagar-local") {
            if (!(l && existsSync(abs) && md5(readFileSync(abs)) !== l.md5)) {
              rmSync(abs, { force: true });
              delete atual[rel];
              res.apagouLocal++;
            }
          } else if (acao === "apagar-remoto") {
            await trashFile(home, r!.id);
            delete atual[rel];
            res.apagouRemoto++;
          }
          errosSeguidos = 0;
        } catch (e) {
          // o que já estava na base fica como estava
          res.erros.push(`${rel}: ${(e as Error).message}`);
          if (++errosSeguidos >= ERROS_SEGUIDOS_MAX) {
            throw new Error(`${ERROS_SEGUIDOS_MAX} erros seguidos, parei a rodada (a próxima continua daqui): ${(e as Error).message}`);
          }
        }
        if (andamento) andamento.pendentes = Math.max(0, andamento.pendentes - 1);
        if (++desdeGravou >= GRAVAR_A_CADA) {
          gravarAgora();
          desdeGravou = 0;
        }
      }
    } finally {
      gravarAgora();
    }
    try {
      importarConversas(home);
    } catch (e) {
      res.erros.push(`importar conversas: ${(e as Error).message}`);
    }
    // depois: o que desceu do Drive pro espelho vira agente/time/hook/skill desta máquina
    anotarBiblioteca(res, sincronizarBiblioteca(home));
  } catch (e) {
    res.erros.push((e as Error).message);
  }
  res.duracaoMs = Date.now() - inicio;
  ultimo = res;
  return res;
}

function anotarBiblioteca(res: ResultadoSync, b: { erros: string[] }): void {
  for (const e of b.erros) res.erros.push(`biblioteca: ${e}`);
}

function escreverAtomico(abs: string, buf: Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, abs);
}

/** Acima disto fora da lista em `<home>/drive`, a subida avisa (sobra da cópia da 0.8.0). */
export const LIXO_AVISO_BYTES = 50 * 1024 * 1024;

/**
 * Mede o que está em `<home>/drive` e o sync ignora (código que a cópia da 0.8.0 trouxe, arquivo
 * solto na raiz). Acima de 50 MB loga UM aviso com o tamanho e as 3 maiores pastas. **Não apaga
 * nada**, nem aqui nem no Drive: depois do filtro do sync esse lixo não atrapalha mais nada, e
 * apagar em massa sozinho é arriscado — a limpeza é à mão. Assíncrona e cedendo a vez: pode ser
 * dezenas de milhares de arquivos. Nunca lança.
 */
export async function avisarLixoNoDrive(home: string): Promise<{ bytes: number; maiores: { pasta: string; bytes: number }[] }> {
  const raiz = join(home, "drive");
  const porPasta = new Map<string, number>();
  let bytes = 0;
  let vistos = 0;
  const somar = async (abs: string, chave: string): Promise<void> => {
    let st;
    try {
      st = await stat(abs);
    } catch {
      return;
    }
    if (++vistos % CEDER_A_CADA === 0) await ceder();
    if (st.isFile()) {
      bytes += st.size;
      porPasta.set(chave, (porPasta.get(chave) ?? 0) + st.size);
      return;
    }
    if (!st.isDirectory()) return;
    let nomes: string[];
    try {
      nomes = await readdir(abs);
    } catch {
      return;
    }
    for (const n of nomes) await somar(join(abs, n), chave);
  };
  try {
    for (const nome of existsSync(raiz) ? await readdir(raiz) : []) {
      const abs = join(raiz, nome);
      if (nome === PASTA_BIBLIOTECA) continue;
      if (!ehPastaDoNexos(abs, nome)) {
        await somar(abs, nome);
        continue;
      }
      for (const item of await readdir(abs)) {
        if (item === "meta.json" || sincronizavel(`${nome}/${item}`)) continue;
        await somar(join(abs, item), `${nome}/${item}`);
      }
    }
  } catch {
    /* best-effort */
  }
  const maiores = [...porPasta.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pasta, b]) => ({ pasta, bytes: b }));
  if (bytes > LIXO_AVISO_BYTES) {
    log.aviso("drive", `${Math.round(bytes / 1024 / 1024)} MB em ${raiz} ficam fora do sync (não é dado do Nexos) — nada foi apagado`, {
      bytes,
      maiores,
    });
  }
  return { bytes, maiores };
}
